import { expect, test } from 'bun:test';
import { ModelRefSchema, modelChatIssue } from '@jolo/protocol';
import { BUILTIN_PRESETS } from '../src/providers/presets.js';
import { createProviderDirectory, parseModels } from '../src/providers/listing.js';
import { ProviderFactory } from '../src/providers/index.js';

const preset = BUILTIN_PRESETS.find(p => p.id === 'openrouter');
const credentials = { get: async () => ({ value: 'test-secret' }) };
const decision = { id: '~typesafe/jev-latest', name: 'TypeSafe: Jev Latest', architecture: { output_modalities: ['decisions'] }, endpoints: [] };

test('reported output modalities determine chat compatibility, including future decision aliases', () => {
  const [model] = parseModels('openrouter', { data: [{ ...decision, id: 'new/alias', supported_parameters: [] }] });
  expect(model.outputModalities).toEqual(['decisions']);
  expect(modelChatIssue(model)).toContain('structured decisions');
  expect(modelChatIssue({ outputModalities: ['image'] })).toContain('does not generate text');
  expect(modelChatIssue({ outputModalities: ['text', 'image'], supportsTools: true })).toBeNull();
  expect(modelChatIssue({ supportsTools: false })).toContain('no tool support');
  expect(modelChatIssue({})).toBeNull();
  expect(modelChatIssue(undefined)).toBeNull();
});

test('saved models omitted by the catalog are looked up, retained within the list limit and cached', async () => {
  const calls = [];
  const directory = createProviderDirectory({ credentials, fetchImpl: async (url, init) => {
    calls.push(url);
    expect(init.headers.Authorization ?? init.headers.authorization).toBe('Bearer test-secret');
    return Response.json({ data: url.endsWith('/endpoints') ? decision : Array.from({ length: 100 }, (_, i) => ({ id: `chat/${i}` })) });
  } });
  const report = await directory.list(preset, { model: decision.id });
  expect(report.models).toHaveLength(100);
  expect(report.models[0]).toMatchObject({ id: decision.id, outputModalities: ['decisions'] });
  expect(calls[2]).toBe('https://openrouter.ai/api/v1/models/~typesafe/jev-latest/endpoints');
  await directory.list(preset, { model: decision.id });
  expect(calls).toHaveLength(3);
  expect(JSON.stringify(report)).not.toContain('test-secret');
});

test('OpenRouter lists decision models without a saved selection, deduplicates and bounds the merged catalog', async () => {
  const calls = [];
  const directory = createProviderDirectory({ credentials, fetchImpl: async url => {
    calls.push(url);
    return Response.json({ data: url.includes('output_modalities=decisions') ? [decision]
      : [...Array.from({ length: 99 }, (_, i) => ({ id: `chat/${i}` })), decision] });
  } });
  const report = await directory.list(preset);
  expect(report.models).toHaveLength(100);
  expect(report.models.filter(m => m.id === decision.id)).toHaveLength(1);
  expect(report.models[0].id).toBe(decision.id);
  expect(modelChatIssue(report.models[0])).toContain('structured decisions');
  await directory.list(preset);
  expect(calls).toHaveLength(2);
});

test('a failed decision catalog preserves chat choices and retries discovery', async () => {
  let attempts = 0;
  const directory = createProviderDirectory({ credentials, fetchImpl: async url => {
    if (!url.includes('output_modalities=decisions')) return Response.json({ data: [{ id: 'chat/valid' }] });
    return ++attempts === 1 ? new Response('', { status: 503 }) : Response.json({ data: [decision] });
  } });
  const first = await directory.list(preset);
  expect(first.models[0].id).toBe('chat/valid');
  expect(first.note).toContain('Could not list decision models');
  expect((await directory.list(preset)).models[0].id).toBe(decision.id);
  expect(attempts).toBe(2);
});

test('failed selected-model discovery preserves the catalog and retries without poisoning the cache', async () => {
  let attempts = 0;
  const directory = createProviderDirectory({ credentials, fetchImpl: async url => {
    if (!url.endsWith('/endpoints')) return Response.json({ data: [{ id: 'chat/valid' }] });
    return ++attempts === 1 ? new Response('', { status: 503 }) : Response.json({ data: decision });
  } });
  const first = await directory.list(preset, { model: decision.id });
  expect(first.models[0].id).toBe('chat/valid');
  expect(first.note).toContain('Could not check');
  const next = await directory.list(preset, { model: decision.id });
  expect(next.models[0].outputModalities).toEqual(['decisions']);
  expect(attempts).toBe(2);
});

test('native runs and persisted resolutions select the decision transport without creating a chat request', async () => {
  const factory = new ProviderFactory({ credentials, fetchImpl: async (url, init) => {
    expect(init.method).not.toBe('POST');
    return Response.json({ data: url.endsWith('/endpoints') ? decision : [] });
  } });
  const ref = ModelRefSchema.parse({ preset: 'openrouter', model: decision.id });
  expect((await factory.create(ref)).settings.protocol).toBe('openrouter-decisions');
  expect((await factory.create(ref, { resolved: { ...preset, preset: 'openrouter', model: ref.model } })).settings.protocol).toBe('openrouter-decisions');
});

test('ordinary chat and models with unknown metadata still resolve', async () => {
  const factory = new ProviderFactory({ credentials, fetchImpl: async url => url.endsWith('/endpoints')
    ? new Response('', { status: 404 })
    : Response.json({ data: [{ id: 'chat/valid', architecture: { output_modalities: ['text'] }, supported_parameters: ['tools'] }] }) });
  for (const model of ['chat/valid', 'custom/unknown']) {
    expect((await factory.resolve(ModelRefSchema.parse({ preset: 'openrouter', model }))).model).toBe(model);
  }
});

test('queued decision turns retain their companion model and endpoint', async () => {
  const config = { model: { preset: 'openai', model: 'text-before' }, providers: { openai: { baseUrl: 'https://chat-before.example/v1' } } };
  const factory = new ProviderFactory({ credentials, settings: { get: () => config }, fetchImpl: async () => Response.json({ data: [decision] }) });
  const saved = factory.capture({ model: { preset: 'openrouter', model: decision.id, mode: 'decisions' } }, {});
  config.model = { preset: 'openai', model: 'text-after' };
  config.providers.openai.baseUrl = 'https://chat-after.example/v1';
  const selected = await factory.create(saved.ref, { resolved: saved });
  expect(selected.settings.chatProvider.ref.model).toBe('text-before');
  expect(selected.settings.chatProvider.endpoint.baseUrl).toBe('https://chat-before.example/v1');
});
