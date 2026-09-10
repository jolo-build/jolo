import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ModelRefSchema, ProviderPresetSchema, parseModelTarget } from '@jolo/protocol';
import { BUILTIN_PRESETS, createProviderCatalog } from '../../apps/engine/src/providers/presets.js';
import { createProviderDirectory, parseModels } from '../../apps/engine/src/providers/listing.js';
import { resolveCapabilities, resolveModelRef, ProviderFactory } from '../../apps/engine/src/providers/index.js';
import { nativeFor } from '../../apps/engine/src/providers/transcript.js';
import { contextWindowFromError } from '../../apps/engine/src/providers/transport.js';
import { createAnthropicProvider } from '../../apps/engine/src/providers/anthropic.js';
import { createGeminiProvider, geminiContents } from '../../apps/engine/src/providers/gemini.js';
import { SettingsService } from '../../apps/engine/src/settings.js';
import { CredentialService } from '../../apps/engine/src/credentials/index.js';
import { ToolRegistry } from '../../apps/engine/src/tools/registry.js';

const homes = []; afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });
const p = id => BUILTIN_PRESETS.find(p => p.id === id);
test('preset files are validated, bounded, and can override an endpoint without code', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'jolo-presets-')); homes.push(home);
  writeFileSync(path.join(home, 'local.json'), JSON.stringify({ ...p('openrouter'), id: 'local', baseUrl: 'http://localhost:8000/v1', auth: { kind: 'none' } }));
  writeFileSync(path.join(home, 'bad.json'), '{invalid');
  writeFileSync(path.join(home, 'large.json'), ' '.repeat(65537));
  const warnings = [];
  const catalog = createProviderCatalog({ dir: home, log: { warn: (...args) => warnings.push(args) } });
  expect(catalog.get('local')).toMatchObject({ protocol: 'openai-chat', source: 'user', auth: { kind: 'none' } });
  expect(warnings).toHaveLength(2);
  expect(() => catalog.get('absent')).toThrow('unknown provider');
  for (const baseUrl of ['not a URL', 'file:///tmp/endpoint', 'https://user:secret@example.com', 'https://example.com?key=secret']) expect(ProviderPresetSchema.safeParse({ ...p('openai'), baseUrl }).success).toBe(false);
  expect(ProviderPresetSchema.safeParse({ ...p('openai'), headers: { Authorization: 'secret' } }).success).toBe(false);
});
test('model refs preserve nested model IDs and validate token overrides', () => {
  expect(parseModelTarget('openrouter/vendor/model')).toMatchObject({ preset: 'openrouter', model: 'vendor/model' });
  expect(() => parseModelTarget('model')).toThrow('preset');
  expect(ModelRefSchema.safeParse({ preset: 'openai', model: 'test', contextWindowTokens: 4000, maxOutputTokens: 5000 }).success).toBe(false);
});
test('run overrides, session selection, profile defaults, and capabilities resolve in order', () => {
  const model = ModelRefSchema.parse({ preset: 'openai', model: 'default', contextWindowTokens: 100000 });
  const session = { model: { preset: 'anthropic', model: 'session', effort: 'high' } };
  expect(resolveModelRef({ model })).toMatchObject(model);
  expect(resolveModelRef({ model }, session).model).toBe('session');
  expect(resolveModelRef({ model }, session, { preset: 'gemini', model: 'once' })).toMatchObject({ preset: 'gemini', model: 'once', effort: null, contextWindowTokens: null });
  expect(resolveModelRef({ model }, {}, { model: 'different' }).contextWindowTokens).toBeNull();
  expect(() => resolveModelRef({ model }, {}, { preset: 'gemini' })).toThrow('requires a model');
  const reported = { contextWindowTokens: 64000, maxOutputTokens: 8000 };
  expect(resolveCapabilities(model, reported, p('openai'))).toMatchObject({ contextWindowTokens: 100000, maxOutputTokens: 8000 });
  expect(resolveCapabilities({}, reported, p('openai')).contextWindowTokens).toBe(64000);
  expect(resolveCapabilities({}, null, p('openai')).contextWindowTokens).toBe(32000);
  expect(resolveCapabilities({}, reported, p('openai'), 16000).contextWindowTokens).toBe(16000);
});
test('settings rewrite legacy configuration once, including base URL, and do not revive a cleared model', () => {
  const prefs = new Map([['provider', { name: 'openai', model: 'legacy', contextWindowTokens: 64000, maxOutputTokens: 4000, baseUrl: 'http://localhost:4444/v1', reasoningEffort: 'high' }]]);
  const storage = { getPreference: k => prefs.get(k), setPreference: (k,v) => prefs.set(k,v), transaction: fn => fn() };
  const service = new SettingsService(storage, { catalog: createProviderCatalog() });
  expect(service.get()).toMatchObject({ model: { preset: 'openai', model: 'legacy', effort: 'high' }, providers: { openai: { baseUrl: 'http://localhost:4444/v1' } } });
  service.update({ model: { preset: 'anthropic', model: 'next' }, agents: { codex: { model: 'hosted' } } });
  expect(service.get().model.model).toBe('next');
  service.update({ model: null }); expect(service.get().model).toBeNull(); expect(service.get().agents.codex.model).toBe('hosted');
  expect(() => service.update({ model: { preset: 'unknown', model: 'x' } })).toThrow('unknown provider');
});
test('listing parsers use reported metadata and do not invent unknown capabilities', () => {
  expect(parseModels('openai', { data: [{ id: 'x' }] })[0]).toEqual({ id: 'x', displayName: 'x', efforts: [] });
  expect(parseModels('anthropic', { data: [{ id: 'c', max_input_tokens: 200000, max_tokens: 32000, capabilities: { thinking: { supported: true, types: { adaptive: { supported: true } } }, effort: { low: { supported: true }, high: { supported: true } } } }] })[0]).toMatchObject({ contextWindowTokens: 200000, maxOutputTokens: 32000, thinkingMode: 'adaptive', efforts: ['low', 'high'] });
  expect(parseModels('gemini', { models: [{ name: 'models/x', inputTokenLimit: 200000, outputTokenLimit: 8000 }, { name: 'models/embed', supportedGenerationMethods: ['embedContent'] }] })).toHaveLength(1);
  expect(parseModels('openrouter', { data: [{ id: 'v/m', context_length: 100000, top_provider: { max_completion_tokens: 8000 }, supported_parameters: ['tools', 'reasoning'] }] })[0]).toMatchObject({ supportsTools: true, supportsReasoning: true, maxOutputTokens: 8000 });
  expect(parseModels('openai', { data: Array.from({ length: 150 }, (_,i) => ({ id: String(i) })) })).toHaveLength(100);
});
test('discovery caches successes, shares in-flight work and retries failures; endpoint or key changes invalidate it', async () => {
  let calls = 0, key = 'first', failure = false;
  const directory = createProviderDirectory({ credentials: { get: async () => ({ value: key }) }, fetchImpl: async () => { calls++; await Promise.resolve(); return failure ? new Response('no', { status: 500 }) : Response.json({ data: [{ id: 'x' }] }); } });
  await Promise.all([directory.list(p('openai')), directory.list(p('openai'))]); expect(calls).toBe(1);
  await directory.list(p('openai')); expect(calls).toBe(1);
  key = 'second'; await directory.list(p('openai')); expect(calls).toBe(2);
  await directory.list({ ...p('openai'), baseUrl: 'http://localhost' }); expect(calls).toBe(3);
  failure = true; directory.clear(); await directory.list(p('openai')); await directory.list(p('openai')); expect(calls).toBe(5);
});
test('custom preset environment credentials use the catalog and never appear in listing results', async () => {
  const catalog = { get: () => ({ ...p('openai'), id: 'private', auth: { kind: 'bearer', env: 'PRIVATE_MODEL_KEY' } }), list: () => [] };
  const credentials = new CredentialService({ catalog, mode: 'session', env: { PRIVATE_MODEL_KEY: 'private-secret' } });
  expect(await credentials.status('private')).toEqual({ provider: 'private', available: true, source: 'environment' });
  await credentials.set('private', 'session-secret'); expect((await credentials.get('private')).value).toBe('session-secret');
});
test('Ollama uses configured num_ctx, not the larger model architecture maximum', async () => {
  const factory = new ProviderFactory({ credentials: {}, catalog: createProviderCatalog(), fetchImpl: async (url, init) => {
    if (url.endsWith('/api/tags')) return Response.json({ models: [{ name: 'configured' }, { name: 'unknown' }] });
    const model = JSON.parse(init.body).model;
    return Response.json({ parameters: model === 'configured' ? 'temperature 0.7\n num_ctx 16384' : '', model_info: { 'model.context_length': 131072 }, capabilities: ['completion', 'tools'] });
  } });
  const report = await factory.models('ollama');
  expect(report.models[0].contextWindowTokens).toBe(16384);
  expect(report.models[1].contextWindowTokens).toBeUndefined();
  expect(report.note).toContain('num_ctx');
  expect((await factory.resolve({ preset: 'ollama', model: 'configured' })).contextWindowTokens).toBe(16384);
  await expect(factory.resolve({ preset: 'ollama', model: 'unknown' })).rejects.toThrow('configured context size');
  expect((await factory.resolve({ preset: 'ollama', model: 'unknown', contextWindowTokens: 32000 })).contextWindowTokens).toBe(32000);
});
test('native data is isolated by protocol, endpoint preset and model; untagged history is Responses-only', () => {
  const options = { protocol: 'anthropic', preset: 'a', model: 'm' }, native = { block: { signature: 'secret' } };
  const item = { payload: { native, nativeRef: options } };
  expect(nativeFor(item, options)).toBe(native);
  for (const change of [{ protocol: 'gemini' }, { preset: 'other' }, { model: 'other' }]) expect(nativeFor(item, { ...options, ...change })).toBeNull();
  expect(nativeFor({ payload: { native } }, options)).toBeNull();
  expect(nativeFor({ payload: { native } }, { protocol: 'openai-responses' })).toBe(native);
});
test('learn only explicit context maximums, not token counts from unrelated errors', () => {
  expect(contextWindowFromError('maximum context length is 32,768 tokens; requested 40000')).toBe(32768);
  expect(contextWindowFromError('prompt is too long: 30000 tokens > 16000 maximum')).toBe(16000);
  expect(contextWindowFromError('request had 12000 tokens; quota remaining 200000')).toBeNull();
  expect(contextWindowFromError('maximum context length is 999999999 tokens')).toBeNull();
});
test('adaptive thinking uses discovered capability; budget thinking is bounded by output', () => {
  const request = { instructions: 'System', items: [{ kind: 'user_message', groupId: 'u', payload: { text: 'Hello' } }], tools: [], maxOutputTokens: 2048, reasoningEffort: 'high' };
  expect(createAnthropicProvider({ ...p('anthropic'), model: 'm', thinkingMode: 'adaptive' }).body(request)).toMatchObject({ thinking: { type: 'adaptive' }, output_config: { effort: 'high' } });
  expect(createAnthropicProvider({ ...p('anthropic'), model: 'm' }).body(request).thinking.budget_tokens).toBe(2047);
  expect(createGeminiProvider({ ...p('gemini'), model: 'm', thinkingMode: 'level' }).body(request).generationConfig.thinkingConfig).toMatchObject({ thinkingLevel: 'high' });
});
test('every registry declaration can be encoded by Gemini without unsupported schema references', () => {
  const tools = new ToolRegistry().declarations({ browserAvailable: true });
  const body = createGeminiProvider({ ...p('gemini'), model: 'test' }).body({ items: [], tools, instructions: 'sys', maxOutputTokens: 4000 });
  const encoded = JSON.stringify(body.tools);
  expect(encoded).not.toContain('additionalProperties'); expect(encoded).not.toContain('$ref');
  expect(tools.every(t => /^[A-Za-z0-9_-]{1,64}$/.test(t.name))).toBe(true);
});
test('Gemini preserves signed parts and matches tool results with and without server call IDs', () => {
  const nativeRef = { protocol: 'gemini', preset: 'gemini', model: 'test' };
  const parts = [{ text: '', thoughtSignature: 'signed-empty-part' },
    { functionCall: { name: 'read_file', args: { path: 'a' } }, thoughtSignature: 'first' },
    { functionCall: { id: 'server-id', name: 'read_file', args: { path: 'b' } }, thoughtSignature: 'second' }];
  const items = [
    { kind: 'tool_call', groupId: 'turn', payload: { callId: 'local-id', name: 'read_file', arguments: { path: 'a' } } },
    { kind: 'tool_call', groupId: 'turn', payload: { callId: 'server-id', name: 'read_file', arguments: { path: 'b' } } },
    { kind: 'reasoning', groupId: 'turn', payload: { nativeRef, native: { parts } } },
    { kind: 'tool_result', groupId: 'turn', payload: { callId: 'local-id', output: 'A' } },
    { kind: 'tool_result', groupId: 'turn', payload: { callId: 'server-id', output: 'B' } },
  ];
  const contents = geminiContents({ items }, nativeRef);
  expect(contents[0]).toEqual({ role: 'model', parts });
  expect(contents[1].parts).toEqual([
    { functionResponse: { name: 'read_file', response: { output: 'A' } } },
    { functionResponse: { id: 'server-id', name: 'read_file', response: { output: 'B' } } },
  ]);
  const switched = geminiContents({ items }, { ...nativeRef, model: 'other' });
  expect(JSON.stringify(switched)).not.toContain('signed-empty-part');
  expect(switched[0].parts[0].thoughtSignature).toBe('skip_thought_signature_validator');
  expect(switched[1].parts[0].functionResponse.id).toBe('local-id');
});
