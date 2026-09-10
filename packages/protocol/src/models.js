import { z } from 'zod';

export const PresetId = z.string().regex(/^[a-z][a-z0-9-]{0,38}$/);
export const ProviderProtocolSchema = z.enum(['openai-responses', 'openai-chat', 'anthropic', 'gemini', 'fake']);
export const ModelEffortSchema = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const Window = z.number().int().min(1000).max(10_000_000);
const Output = z.number().int().min(16).max(1_000_000);
export const ProviderUrlSchema = z.string().url().max(500).refine(value => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}, 'Use an HTTP(S) base URL without credentials, query or fragment');
export const ModelRefSchema = z.object({
  preset: PresetId, model: z.string().trim().min(1).max(200),
  effort: ModelEffortSchema.nullable().default(null),
  contextWindowTokens: Window.nullable().default(null), maxOutputTokens: Output.nullable().default(null),
}).refine(ref => !ref.contextWindowTokens || !ref.maxOutputTokens || ref.maxOutputTokens < ref.contextWindowTokens,
  'Max output tokens must be smaller than the context window');
export const ProviderOverridesSchema = z.record(PresetId, z.object({ baseUrl: ProviderUrlSchema.nullable().default(null) }));
export const ProviderPresetSchema = z.object({
  id: PresetId, displayName: z.string().min(1).max(60), description: z.string().max(200).default(''),
  protocol: ProviderProtocolSchema, baseUrl: ProviderUrlSchema,
  auth: z.object({ kind: z.enum(['bearer', 'x-api-key', 'x-goog-api-key', 'none']), env: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/).nullable().default(null) }),
  listing: z.enum(['openai', 'anthropic', 'gemini', 'openrouter', 'ollama', 'none']),
  defaults: z.object({ contextWindowTokens: Window, maxOutputTokens: Output }).refine(x => x.maxOutputTokens < x.contextWindowTokens),
  thinkingBudgets: z.record(z.enum(['low', 'medium', 'high']), z.number().int().min(1024).max(100_000)).optional(),
  // Wire dialect choices are data, not model-name heuristics.
  thinkingMode: z.enum(['budget', 'adaptive', 'level']).optional(),
  outputTokenField: z.enum(['max_tokens', 'max_completion_tokens']).default('max_tokens'),
  chatReasoning: z.object({
    effortParameter: z.enum(['reasoning_effort', 'reasoning.effort']).default('reasoning_effort'),
    thinkingToggle: z.boolean().default(false),
    requireReasoningContent: z.boolean().default(false),
  }).optional(),
  headers: z.record(z.string().regex(/^[A-Za-z0-9-]{1,64}$/), z.string().max(500).refine(x => !/[\r\n]/.test(x))).default({})
    .refine(h => !Object.keys(h).some(k => /^(authorization|proxy-authorization|x-api-key|x-goog-api-key|cookie|host)$/i.test(k)), 'Secret and routing headers are not allowed in presets; use credential.set'),
});
export const ProviderModelSchema = z.object({
  id: z.string().min(1).max(200), displayName: z.string().max(200),
  contextWindowTokens: Window.optional(), maxOutputTokens: Output.optional(),
  supportsTools: z.boolean().optional(), supportsReasoning: z.boolean().optional(),
  efforts: z.array(ModelEffortSchema).max(7).default([]),
  thinkingMode: z.enum(['budget', 'adaptive', 'level']).optional(),
});
export const ProviderModelsSchema = z.object({ models: z.array(ProviderModelSchema).max(100), note: z.string().max(1000).nullable().default(null) });
export const ProviderEntrySchema = ProviderPresetSchema.extend({
  source: z.enum(['builtin', 'user']), available: z.boolean(), credentialSource: z.enum(['keychain', 'session', 'environment', 'none']),
});

export function parseModelTarget(value) {
  const slash = String(value).indexOf('/');
  if (slash < 1) throw new Error('Use <preset>/<model>, for example openai/model-id');
  return ModelRefSchema.parse({ preset: value.slice(0, slash), model: value.slice(slash + 1) });
}
export function modelFromFields(form) {
  return ModelRefSchema.parse({ preset: form.name, model: form.name === 'fake' ? 'fake' : form.model.trim(),
    effort: form.reasoningEffort || null,
    contextWindowTokens: String(form.contextWindowTokens ?? '').trim() ? Number(form.contextWindowTokens) : null,
    maxOutputTokens: String(form.maxOutputTokens ?? '').trim() ? Number(form.maxOutputTokens) : null });
}
