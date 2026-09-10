import { createHash } from 'node:crypto';
import { ProviderModelSchema, ModelEffortSchema } from '@jolo/protocol';
import { boundedText, requestHeaders, redact } from './transport.js';

const TTL = 5 * 60_000;
const validLimit = (n, min, max) => Number.isInteger(n) && n >= min && n <= max ? n : undefined;
export function parseModels(kind, body) {
  const rows = kind === 'gemini' || kind === 'ollama' ? body.models : body.data;
  if (!Array.isArray(rows)) throw new Error('provider returned no model list');
  const result = [];
  for (const row of rows) {
    if (kind === 'gemini' && Array.isArray(row.supportedGenerationMethods) && !row.supportedGenerationMethods.includes('generateContent')) continue;
    const id = kind === 'gemini' ? row.name?.replace(/^models\//, '') : kind === 'ollama' ? row.model ?? row.name : row.id;
    let context, output, supportsTools, supportsReasoning, thinkingMode, efforts = [];
    if (kind === 'anthropic') {
      context = row.max_input_tokens; output = row.max_tokens;
      supportsReasoning = row.capabilities?.thinking?.supported;
      if (row.capabilities?.thinking?.types?.adaptive?.supported) thinkingMode = 'adaptive';
      efforts = Object.entries(row.capabilities?.effort ?? {}).filter(([,v]) => v?.supported).map(([k]) => k).filter(k => ModelEffortSchema.safeParse(k).success);
    } else if (kind === 'gemini') {
      context = row.inputTokenLimit; output = row.outputTokenLimit; supportsReasoning = row.thinking;
    } else if (kind === 'openrouter') {
      context = row.context_length; output = row.top_provider?.max_completion_tokens;
      if (Array.isArray(row.supported_parameters)) {
        supportsTools = row.supported_parameters.includes('tools');
        supportsReasoning = row.supported_parameters.some(p => ['reasoning', 'reasoning_effort'].includes(p));
      }
    } else {
      context = row.context_length; output = row.max_output_tokens;
    }
    const parsed = ProviderModelSchema.safeParse({ id, displayName: String(row.displayName ?? row.display_name ?? row.name ?? id ?? '').slice(0, 200),
      contextWindowTokens: validLimit(context, 1000, 10_000_000), maxOutputTokens: validLimit(output, 16, 1_000_000),
      supportsTools, supportsReasoning, thinkingMode, efforts });
    if (parsed.success && !result.some(m => m.id === id)) result.push(parsed.data);
    if (result.length === 100) break;
  }
  return result;
}

export function createProviderDirectory({ credentials, fetchImpl = fetch, now = Date.now }) {
  const cache = new Map(), pending = new Map();
  const keyFor = (p, key) => createHash('sha256').update(JSON.stringify([p, key ?? null])).digest('hex');
  return {
    clear() { cache.clear(); },
    async list(preset, { refresh = false } = {}) {
      if (preset.protocol === 'fake') return { models: [{ id: 'fake', displayName: 'Demo provider', ...preset.defaults, supportsTools: true, supportsReasoning: true, efforts: [] }], note: null };
      if (preset.listing === 'none') return { models: [], note: 'This preset does not list models. Enter a model ID.' };
      const credential = preset.auth.kind === 'none' ? null : await credentials.get(preset.id);
      if (preset.auth.kind !== 'none' && !credential) return { models: [], note: `Configure an API key for ${preset.displayName} to find models.` };
      const key = keyFor(preset, credential?.value), cached = cache.get(key);
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
          const body = await read(kind === 'ollama' ? `${root}/api/tags` : `${base}/models${kind === 'anthropic' ? '?limit=100' : kind === 'gemini' ? '?pageSize=100' : kind === 'openrouter' ? '?limit=100' : ''}`);
          const models = parseModels(kind, body);
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
          const notes = [];
          if (models.length === 100 || body.has_more || body.nextPageToken) notes.push('Showing up to 100 models. You can also enter a model ID.');
          if (!models.length) notes.push('No models reported. Enter a model ID.');
          if (kind === 'ollama' && models.some(m => !m.contextWindowTokens)) notes.push('For models without a reported context size, configure Ollama num_ctx and enter the matching context override.');
          const report = { models, note: notes.join(' ') || null };
          if (cache.size >= 100) cache.delete(cache.keys().next().value);
          cache.set(key, { report, at: now() });
          return report;
        } catch (error) { return { models: [], note: redact(signal.aborted ? 'Model discovery timed out after 8 seconds.' : error.message, credential?.value) }; }
      })();
      pending.set(key, job);
      try { return await job; } finally { pending.delete(key); }
    },
  };
}
