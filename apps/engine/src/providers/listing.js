import { createHash } from 'node:crypto';
import { ProviderModelSchema, ModelEffortSchema } from '@jolo/protocol';
import { boundedText, requestHeaders, redact } from './transport.js';

const TTL = 5 * 60_000;
const validLimit = (n, min, max) => Number.isInteger(n) && n >= min && n <= max ? n : undefined;
export function parseModels(kind, body) {
  const rows = ['gemini', 'ollama', 'typesafe'].includes(kind) ? body.models : body.data;
  if (!Array.isArray(rows)) throw new Error('provider returned no model list');
  const result = [];
  for (const row of rows) {
    if (kind === 'gemini' && Array.isArray(row.supportedGenerationMethods) && !row.supportedGenerationMethods.includes('generateContent')) continue;
    const id = kind === 'gemini' ? row.name?.replace(/^models\//, '') : kind === 'ollama' ? row.model ?? row.name : kind === 'typesafe' ? row.name : row.id;
    let context, output, supportsTools, supportsReasoning, thinkingMode, outputModalities, efforts = [];
    if (kind === 'typesafe') {
      // The System One endpoint serves typed decisions, including manually
      // pinned versions that do not appear in the alias listing.
      outputModalities = ['decisions']; supportsTools = false; supportsReasoning = false;
    } else if (kind === 'anthropic') {
      context = row.max_input_tokens; output = row.max_tokens;
      supportsReasoning = row.capabilities?.thinking?.supported;
      if (row.capabilities?.thinking?.types?.adaptive?.supported) thinkingMode = 'adaptive';
      efforts = Object.entries(row.capabilities?.effort ?? {}).filter(([,v]) => v?.supported).map(([k]) => k).filter(k => ModelEffortSchema.safeParse(k).success);
    } else if (kind === 'gemini') {
      context = row.inputTokenLimit; output = row.outputTokenLimit; supportsReasoning = row.thinking;
    } else if (kind === 'openrouter') {
      context = row.context_length; output = row.top_provider?.max_completion_tokens;
      outputModalities = row.architecture?.output_modalities;
      if (Array.isArray(row.supported_parameters)) {
        supportsTools = row.supported_parameters.includes('tools');
        supportsReasoning = row.supported_parameters.some(p => ['reasoning', 'reasoning_effort'].includes(p));
      }
    } else {
      context = row.context_length; output = row.max_output_tokens;
    }
    const parsed = ProviderModelSchema.safeParse({ id, displayName: String(row.displayName ?? row.display_name ?? row.name ?? id ?? '').slice(0, 200),
      contextWindowTokens: validLimit(context, 1000, 10_000_000), maxOutputTokens: validLimit(output, 16, 1_000_000),
      supportsTools, supportsReasoning, thinkingMode, outputModalities, efforts });
    if (parsed.success && !result.some(m => m.id === id)) result.push(parsed.data);
    if (result.length === 100) break;
  }
  return result;
}

/** @param {{ credentials: any, fetchImpl?: import('./transport.js').FetchLike, now?: () => number }} options */
export function createProviderDirectory({ credentials, fetchImpl = fetch, now = Date.now }) {
  const cache = new Map(), pending = new Map();
  const keyFor = (p, key) => createHash('sha256').update(JSON.stringify([p, key ?? null])).digest('hex');
  return {
    clear() { cache.clear(); },
    async list(preset, { refresh = false, model = undefined } = {}) {
      if (preset.protocol === 'fake') return { models: [{ id: 'fake', displayName: 'Demo provider', ...preset.defaults, supportsTools: true, supportsReasoning: true, efforts: [] }], note: null };
      if (preset.listing === 'none') return { models: [], note: 'This preset does not list models. Enter a model ID.' };
      const credential = preset.auth.kind === 'none' ? null : await credentials.get(preset.id);
      if (preset.auth.kind !== 'none' && !credential) return { models: [], note: `Configure an API key for ${preset.displayName} to find models.` };
      const key = keyFor({ ...preset, selectedModel: preset.listing === 'openrouter' ? model : undefined }, credential?.value), cached = cache.get(key);
      if (!refresh && cached && now() - cached.at < TTL) return cached.report;
      if (pending.has(key)) return pending.get(key);
      if (pending.size >= 4) return { models: [], note: 'Model discovery is busy; try again shortly.' };
      const job = (async () => {
        const signal = AbortSignal.timeout(8000);
        const headers = requestHeaders({ ...preset, apiKey: credential?.value });
        const base = preset.baseUrl.replace(/\/+$/, '');
        const read = async (url, body) => {
          const response = await fetchImpl(url, { headers, signal, redirect: 'error', ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
          const text = await boundedText(response);
          if (!response.ok) throw new Error(`model listing returned HTTP ${response.status}`);
          return JSON.parse(text);
        };
        try {
          const kind = preset.listing;
          const root = kind === 'ollama' ? base.replace(/\/v1$/, '') : base;
          const [catalog, decisions] = await Promise.allSettled([
            read(kind === 'ollama' ? `${root}/api/tags` : `${base}/models${kind === 'anthropic' ? '?limit=100' : kind === 'gemini' ? '?pageSize=100' : kind === 'openrouter' ? '?limit=100' : ''}`),
            kind === 'openrouter' ? read(`${base}/models?output_modalities=decisions&limit=100`) : Promise.resolve(null),
          ]);
          if (catalog.status === 'rejected') throw catalog.reason;
          const body = catalog.value;
          let models = parseModels(kind, body);
          const notes = [];
          let detailFailed = false;
          if (kind === 'openrouter') {
            try {
              if (decisions.status === 'rejected') throw decisions.reason;
              const extra = parseModels(kind, decisions.value).filter(m => m.outputModalities?.includes('decisions'));
              // Keep decision models visible even when the default catalog fills the page, so
              // searching for Jev explains its incompatibility instead of yielding no matches.
              const ids = new Set(extra.map(m => m.id));
              models = [...extra, ...models.filter(m => !ids.has(m.id))].slice(0, 100);
            } catch (error) {
              detailFailed = true;
              notes.push(redact(`Could not list decision models: ${signal.aborted ? 'model discovery timed out' : error.message}`, credential?.value));
            }
          }
          // OpenRouter's default catalog excludes decision models and is paginated. Resolve a
          // saved/manual selection separately; do not infer its API from an alias or model name.
          if (kind === 'openrouter' && model && !models.some(m => m.id === model)) {
            try {
              const modelPath = model.split('/').map(part => encodeURIComponent(part).replace(/\./g, '%2E')).join('/');
              const detail = await read(`${base}/models/${modelPath}/endpoints`);
              const selected = parseModels(kind, { data: [{ ...detail.data, id: model }] })[0];
              if (selected) { if (models.length === 100) models.pop(); models.unshift(selected); }
            } catch (error) {
              detailFailed = true;
              notes.push(redact(`Could not check the selected model: ${signal.aborted ? 'model discovery timed out' : error.message}`, credential?.value));
            }
          }
          if (kind === 'ollama') {
            let index = 0;
            await Promise.all(Array.from({ length: Math.min(4, models.length) }, async () => {
              while (index < models.length) {
                const model = models[index++];
                const detail = await read(`${root}/api/show`, { model: model.id });
                // The model architecture's context_length is not the server's configured num_ctx.
                const window = Number(/^\s*num_ctx\s+(\d+)\s*$/m.exec(detail.parameters ?? '')?.[1]);
                if (validLimit(window, 1000, 10_000_000)) model.contextWindowTokens = window;
                if (Array.isArray(detail.capabilities)) { model.supportsTools = detail.capabilities.includes('tools'); model.supportsReasoning = detail.capabilities.includes('thinking'); }
              }
            }));
          }
          if (models.length === 100 || body.has_more || body.nextPageToken) notes.push('Showing up to 100 models. You can also enter a model ID.');
          if (!models.length) notes.push('No models reported. Enter a model ID.');
          if (kind === 'ollama' && models.some(m => !m.contextWindowTokens)) notes.push('For models without a reported context size, configure Ollama num_ctx and enter the matching context override.');
          const report = { models, note: notes.join(' ') || null };
          if (cache.size >= 100) cache.delete(cache.keys().next().value);
          if (!detailFailed) cache.set(key, { report, at: now() });
          return report;
        } catch (error) { return { models: [], note: redact(signal.aborted ? 'Model discovery timed out after 8 seconds.' : error.message, credential?.value) }; }
      })();
      pending.set(key, job);
      try { return await job; } finally { pending.delete(key); }
    },
  };
}
