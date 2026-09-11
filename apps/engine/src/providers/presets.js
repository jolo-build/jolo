// Endpoints are data. Model IDs and capabilities come from the endpoint itself.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { ProtocolError, ProviderPresetSchema } from '@jolo/protocol';
import { demoProviderEnabled } from './mode.js';

const preset = (id, displayName, protocol, baseUrl, listing, kind, env, extra = {}) => ProviderPresetSchema.parse({
  id, displayName, protocol, baseUrl, listing, auth: { kind, env },
  defaults: { contextWindowTokens: 32_000, maxOutputTokens: 4096 }, ...extra,
});
export const BUILTIN_PRESETS = Object.freeze([
  preset('openai', 'OpenAI', 'openai-responses', 'https://api.openai.com/v1', 'openai', 'bearer', 'OPENAI_API_KEY'),
  preset('anthropic', 'Anthropic', 'anthropic', 'https://api.anthropic.com/v1', 'anthropic', 'x-api-key', 'ANTHROPIC_API_KEY', { headers: { 'anthropic-version': '2023-06-01' }, thinkingBudgets: { low: 1024, medium: 2048, high: 3072 } }),
  preset('gemini', 'Gemini', 'gemini', 'https://generativelanguage.googleapis.com/v1beta', 'gemini', 'x-goog-api-key', 'GEMINI_API_KEY', { thinkingBudgets: { low: 1024, medium: 2048, high: 3072 } }),
  preset('openrouter', 'OpenRouter', 'openai-chat', 'https://openrouter.ai/api/v1', 'openrouter', 'bearer', 'OPENROUTER_API_KEY', { chatReasoning: { effortParameter: 'reasoning.effort' } }),
  // The endpoint's listing carries no limits; its documentation states a 128K minimum context for every model.
  preset('deepseek', 'DeepSeek', 'openai-chat', 'https://api.deepseek.com', 'openai', 'bearer', 'DEEPSEEK_API_KEY', { chatReasoning: { thinkingToggle: true, requireReasoningContent: true }, defaults: { contextWindowTokens: 128_000, maxOutputTokens: 8192 } }),
  preset('xai', 'xAI', 'openai-chat', 'https://api.x.ai/v1', 'openai', 'bearer', 'XAI_API_KEY'),
  preset('ollama', 'Ollama', 'openai-chat', 'http://localhost:11434/v1', 'ollama', 'none', null),
  preset('fake', 'Demo provider', 'fake', 'http://localhost', 'none', 'none', null, { defaults: { contextWindowTokens: 128_000, maxOutputTokens: 4096 } }),
]);

/**
 * The endpoints this engine knows: the built-ins, plus any preset files the operator dropped in
 * `dir`. Callers that only read the built-ins (tests, a factory without a data directory) pass
 * nothing at all.
 * @param {{ dir?: string, log?: any, env?: Record<string, string | undefined> }} [options]
 */
export function createProviderCatalog({ dir, log, env = process.env } = {}) {
  const demoEnabled = demoProviderEnabled(env);
  const allowed = p => demoEnabled || (p.id !== 'fake' && p.protocol !== 'fake');
  const entries = new Map(BUILTIN_PRESETS.filter(allowed).map(p => [p.id, { ...p, source: 'builtin' }]));
  if (dir) {
    let files = [];
    try { files = readdirSync(dir).filter(f => f.endsWith('.json')).sort().slice(0, 100); }
    catch (error) { if (error.code !== 'ENOENT') log?.warn('provider directory unavailable'); }
    for (const file of files) {
      try {
        const filename = path.join(dir, file);
        if (!statSync(filename).isFile() || statSync(filename).size > 65536) throw new Error('invalid file size');
        const p = ProviderPresetSchema.parse(JSON.parse(readFileSync(filename, 'utf8')));
        if (!allowed(p)) throw new Error('the demo provider is only available in development mode');
        if (!entries.has(p.id) && entries.size >= 100) throw new Error('preset limit reached');
        entries.set(p.id, { ...p, source: 'user' });
      } catch { log?.warn('invalid provider preset skipped', { file }); }
    }
  }
  return {
    list: () => [...entries.values()].filter(p => p.protocol !== 'fake' || demoProviderEnabled(env)),
    get(id) {
      const p = entries.get(id);
      if (!p) throw new ProtocolError('not_found', `unknown provider preset ${id}`);
      return p;
    },
  };
}
