// Resolve a model once, then construct its protocol adapter. Credentials are never persisted.
import { ModelRefSchema, ProtocolError } from '@jolo/protocol';
import { createFakeProvider, loadFakeScript } from './fake.js';
import { createOpenAIProvider } from './openai.js';
import { createChatProvider } from './openai-chat.js';
import { createAnthropicProvider } from './anthropic.js';
import { createGeminiProvider } from './gemini.js';
import { createProviderCatalog } from './presets.js';
import { createProviderDirectory } from './listing.js';
import { demoProviderEnabled } from './mode.js';

export const ADAPTERS = Object.freeze({ 'openai-responses': createOpenAIProvider, 'openai-chat': createChatProvider, anthropic: createAnthropicProvider, gemini: createGeminiProvider });
export const FAKE_MODEL = Object.freeze({ preset: 'fake', model: 'fake', effort: null, contextWindowTokens: null, maxOutputTokens: null });
export function resolveModelRef(config, session = {}, execution = {}) {
  if (!session.model && !config.model && !config.provider && !execution?.preset &&
      (config.demoProviderEnabled === false || !demoProviderEnabled())) {
    throw new ProtocolError('unavailable', 'no model provider is configured; configure a model provider or select an installed coding agent');
  }
  const base = session.model ?? config.model ?? (config.provider && (config.provider.name !== 'fake' || config.demoProviderEnabled !== false) ? { preset: config.provider.name, model: config.provider.model, effort: config.provider.reasoningEffort, contextWindowTokens: config.provider.contextWindowTokens, maxOutputTokens: config.provider.maxOutputTokens } : null) ?? FAKE_MODEL;
  const samePreset = !execution?.preset || execution.preset === base.preset;
  if (!samePreset && !execution.model) throw new ProtocolError('invalid_params', 'A provider override requires a model ID');
  const sameModel = samePreset && (!execution?.model || execution.model === base.model);
  return ModelRefSchema.parse({ ...(sameModel ? base : { preset: execution?.preset ?? base.preset, model: execution?.model }),
    ...(execution?.model ? { model: execution.model } : {}), ...(execution?.effort != null ? { effort: execution.effort } : {}) });
}
export function resolveCapabilities(ref, reported, preset, learned) {
  const contextWindowTokens = ref.contextWindowTokens ?? learned ?? reported?.contextWindowTokens ?? preset.defaults.contextWindowTokens;
  const maxOutputTokens = ref.maxOutputTokens ?? Math.min(reported?.maxOutputTokens ?? preset.defaults.maxOutputTokens, Math.max(16, contextWindowTokens - 4001));
  if (maxOutputTokens >= contextWindowTokens) throw new ProtocolError('invalid_params', 'Max output tokens must be smaller than the context window');
  return { contextWindowTokens, maxOutputTokens, supportsTools: reported?.supportsTools ?? true, supportsReasoning: reported?.supportsReasoning ?? true, thinkingMode: reported?.thinkingMode ?? preset.thinkingMode };
}
export class ProviderFactory {
  constructor({ credentials, env = process.env, log, fetchImpl, catalog = createProviderCatalog({ env }), settings }) {
    Object.assign(this, { credentials, env, log, fetchImpl, catalog, settings });
    this.directory = createProviderDirectory({ credentials, fetchImpl });
    this.learned = new Map();
  }
  preset(id, config = this.settings?.get() ?? {}) {
    if (id === 'fake' && !demoProviderEnabled(this.env)) throw new ProtocolError('unavailable', 'the demo provider is only available in development mode');
    const p = this.catalog.get(id);
    if (p.protocol === 'fake' && !demoProviderEnabled(this.env)) throw new ProtocolError('unavailable', 'the demo provider is only available in development mode');
    return { ...p, baseUrl: config.providers?.[id]?.baseUrl ?? p.baseUrl };
  }
  async presets() {
    return { presets: await Promise.all(this.catalog.list().filter(p => demoProviderEnabled(this.env) || (p.id !== 'fake' && p.protocol !== 'fake')).map(async p => {
      const status = p.auth.kind === 'none' ? { available: true, source: 'none' } : await this.credentials.status(p.id);
      return { ...this.preset(p.id), available: status.available, credentialSource: status.source };
    })) };
  }
  models(id, options) { return this.directory.list(this.preset(id), options); }
  learn(settings, value) { this.learned.set(`${settings.preset}:${settings.baseUrl}:${settings.model}`, value); }
  capture(session, execution) {
    const config = this.settings.get();
    try {
      const ref = resolveModelRef(config, session, execution);
      return { pending: true, ref, endpoint: this.preset(ref.preset, config) };
    } catch (error) {
      // An unconfigured native run is still recorded and fails visibly in its conversation.
      if (error.code === 'unavailable') return null;
      throw error;
    }
  }
  async resolve(ref, config = this.settings?.get() ?? {}, endpoint = null) {
    const preset = endpoint ?? this.preset(ref.preset, config);
    const { models } = await this.directory.list(preset);
    const reported = models.find(m => m.id === ref.model);
    if (preset.listing === 'ollama' && !ref.contextWindowTokens && !reported?.contextWindowTokens) throw new ProtocolError('invalid_params', 'Ollama did not report its configured context size; set num_ctx in its Modelfile or enter a context override matching the server configuration');
    const capabilities = resolveCapabilities(ref, reported, preset, this.learned.get(`${ref.preset}:${preset.baseUrl}:${ref.model}`));
    if (capabilities.supportsTools === false) throw new ProtocolError('unavailable', `${ref.model} reports no tool support; choose a model that can use tools`);
    if (ref.effort && ref.effort !== 'none' && capabilities.supportsReasoning === false) throw new ProtocolError('invalid_params', `${ref.model} reports no reasoning support`);
    if (ref.effort && reported?.efforts?.length && !reported.efforts.includes(ref.effort) && ref.effort !== 'none') throw new ProtocolError('invalid_params', `${ref.model} does not support effort ${ref.effort}`);
    if (ref.effort && ref.effort !== 'none' && ['anthropic', 'gemini'].includes(preset.protocol)) {
      // Budgeted thinking is preset data; an effort without a budget must fail here, not inside the stream.
      const budgeted = preset.protocol === 'anthropic' ? capabilities.thinkingMode !== 'adaptive' : capabilities.thinkingMode !== 'level';
      if (budgeted && !preset.thinkingBudgets?.[ref.effort === 'minimal' ? 'low' : ref.effort]) throw new ProtocolError('invalid_params', `${preset.displayName} has no thinking budget for effort ${ref.effort}; choose low, medium or high, or add thinkingBudgets to the preset`);
    }
    return { ...preset, ...capabilities, name: preset.id, preset: preset.id, model: ref.model, reasoningEffort: ref.effort, ref };
  }
  async create(selection, { resolved = null, config } = {}) {
    if (!selection && !resolved && !demoProviderEnabled(this.env)) throw new ProtocolError('unavailable', 'no model provider is configured; configure a model provider or select an installed coding agent');
    // The old entry point is retained for existing callers during migration.
    if (selection?.name && !selection.preset) {
      config = { providers: { [selection.name]: { baseUrl: selection.baseUrl ?? null } } };
      selection = { preset: selection.name, model: selection.model, effort: selection.reasoningEffort, contextWindowTokens: selection.contextWindowTokens, maxOutputTokens: selection.maxOutputTokens };
    }
    const ref = ModelRefSchema.parse(selection ?? FAKE_MODEL);
    const effective = resolved?.pending ? await this.resolve(ref, config, resolved.endpoint) : resolved ?? await this.resolve(ref, config);
    // Revalidate persisted run resolutions too: a development run can be resumed by a release build.
    if (effective.protocol === 'fake' && !demoProviderEnabled(this.env)) throw new ProtocolError('unavailable', 'the demo provider is only available in development mode');
    if (effective.protocol === 'fake') return { settings: effective, configured: Boolean(selection), provider: createFakeProvider({ steps: Number(this.env.JOLO_FAKE_STEPS ?? 20), delayMs: Number(this.env.JOLO_FAKE_DELAY_MS ?? 100), script: loadFakeScript(this.env), ...effective }) };
    const credential = effective.auth.kind === 'none' ? null : await this.credentials.get(effective.preset);
    if (effective.auth.kind !== 'none' && !credential) throw new ProtocolError('unavailable', `no credential for ${effective.preset}; run \`jolo auth set ${effective.preset}\``);
    const create = ADAPTERS[effective.protocol];
    if (!create) throw new ProtocolError('unavailable', `unsupported protocol ${effective.protocol}`);
    return { settings: effective, configured: true, provider: create({ ...effective, apiKey: credential?.value, fetchImpl: this.fetchImpl }) };
  }
}
