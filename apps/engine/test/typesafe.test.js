import { expect, test } from 'bun:test';
import { createDecisionService } from '../src/providers/decisions.js';
import { ProviderFactory } from '../src/providers/index.js';
import { createProviderCatalog } from '../src/providers/presets.js';
import { CredentialService } from '../src/credentials/index.js';

const request = { state: 'Hello', questions: { greeting: { type: 'noul', instructions: 'Is this a greeting?' } } };
const reply = /** @type {const} */ ({ model: 'jev-1.13.0', answers: { greeting: { type: 'noul', noul: 0.99 } }, usage: { input_tokens: 20, output_tokens: 5 } });
const ref = { preset: 'typesafe', model: 'jev-latest' };

test('direct Jev discovers aliases and resolves pinned models with its own credential and transport', async () => {
  const catalog = createProviderCatalog();
  const credentials = new CredentialService({ catalog, mode: 'session', env: { TYPESAFE_API_KEY: 'native-secret', OPENROUTER_API_KEY: 'router-secret' } });
  const settings = { get: () => ({ providers: { typesafe: { baseUrl: 'https://native.example/v1' } } }) };
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    expect(init.headers.authorization).toBe('Bearer native-secret');
    expect(init.redirect).toBe('error');
    if (url.endsWith('/models')) return Response.json({ models: [{ name: 'jev-latest' }, { name: 'jev-preview' }] });
    expect(url).toBe('https://native.example/v1/systemone');
    expect(JSON.parse(init.body)).toEqual({ ...request, model: ref.model });
    return Response.json(reply);
  };
  const providers = new ProviderFactory({ credentials, catalog, settings, fetchImpl });
  expect((await providers.presets()).presets.find(p => p.id === 'typesafe')).toMatchObject({ available: true, credentialSource: 'environment' });
  expect((await providers.models('typesafe', {})).models).toMatchObject([
    { id: 'jev-latest', outputModalities: ['decisions'], supportsTools: false, supportsReasoning: false },
    { id: 'jev-preview', outputModalities: ['decisions'] },
  ]);
  const resolved = await providers.create({ ...ref, model: 'jev-1.13.0' });
  expect(resolved.settings).toMatchObject({ protocol: 'typesafe', model: 'jev-1.13.0' });
  expect(resolved.provider).toBeNull();
  const service = createDecisionService({ settings, providers, credentials, fetchImpl });
  expect(await service.request(request, ref)).toEqual(reply);
  // Resuming uses the captured endpoint even after the user's connection changes.
  settings.get = () => ({ providers: { typesafe: { baseUrl: 'https://changed.example/v1' } } });
  expect(await service.request(request, ref, undefined, resolved.settings)).toEqual(reply);
  expect(calls.every(url => url.startsWith('https://native.example/v1/'))).toBe(true);
});

test('direct Jev errors redact secrets and reject missing keys and invalid answers', async () => {
  const settings = { get: () => ({}) };
  const credentials = { get: async () => ({ value: 'native-secret' }) };
  const providers = new ProviderFactory({ credentials, settings });
  const make = fetchImpl => createDecisionService({ settings, providers, credentials, fetchImpl });
  await expect(make(async () => { throw new Error('native-secret'); }).request(request, ref)).rejects.toThrow('[redacted]');
  await expect(make(async () => new Response('native-secret', { status: 401 })).request(request, ref)).rejects.toThrow('HTTP 401');
  await expect(make(async () => Response.json({ ...reply, answers: {} })).request(request, ref)).rejects.toThrow('unknown or missing questions');
  const abort = new AbortController(); abort.abort();
  await expect(make(async (_url, init) => { init.signal.throwIfAborted(); }).request(request, ref, abort.signal)).rejects.toThrow('cancelled');
  credentials.get = async () => null;
  await expect(make(async () => { throw new Error('Must not call without a key'); }).request(request, ref)).rejects.toThrow('No credential for typesafe');
});

test('Sifty is a separate keyless provider with its own model catalog and endpoint', async () => {
  const catalog = createProviderCatalog();
  const credentials = new CredentialService({ catalog, mode: 'session', env: {} });
  const settings = { get: () => ({}) };
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url === 'https://sifty.dev/v1/models') return Response.json({ models: [{ name: 'syn-latest', description: 'Decision scorer', release_date: '2026-09-21' }] });
    expect(url).toBe('https://sifty.dev/v1/systemone');
    expect(init.headers.authorization).toBeUndefined();
    expect(JSON.parse(init.body)).toEqual({ ...request, model: 'syn-latest' });
    return Response.json({ ...reply, model: 'Qwen/Qwen3-8B' });
  };
  const providers = new ProviderFactory({ credentials, catalog, settings, fetchImpl });
  expect((await providers.presets()).presets.find(p => p.id === 'sifty')).toMatchObject({
    protocol: 'typesafe', baseUrl: 'https://sifty.dev/v1', available: true, credentialSource: 'none', auth: { kind: 'none' },
  });
  expect((await providers.models('sifty', {})).models).toMatchObject([
    { id: 'syn-latest', outputModalities: ['decisions'], supportsTools: false, supportsReasoning: false },
  ]);
  const selection = { preset: 'sifty', model: 'syn-latest' };
  expect((await providers.create(selection)).settings).toMatchObject({ protocol: 'typesafe', preset: 'sifty', model: 'syn-latest' });
  const service = createDecisionService({ settings, providers, credentials, fetchImpl });
  expect(await service.request(request, selection)).toMatchObject({ model: 'Qwen/Qwen3-8B', answers: reply.answers });
  const tooMany = Object.fromEntries(Array.from({ length: 27 }, (_, index) => [`option_${index}`, `Option ${index}`]));
  await expect(service.request({ state: 'Choose', questions: { action: { type: 'choice', instructions: 'Choose one', criteria: tooMany } } }, selection)).rejects.toThrow('Sifty supports at most 26 choices');
  expect(calls.map(call => call.url)).toEqual(['https://sifty.dev/v1/models', 'https://sifty.dev/v1/systemone']);
});
