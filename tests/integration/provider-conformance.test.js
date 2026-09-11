import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { startEngine, tempHome, removeHome, openSession, waitFor } from './helpers.js';
import { mockProvider, PROTOCOLS, wireTurn } from '../fixtures/mock-providers.js';

const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
/**
 * Boot an engine against a mock provider and hand back the handles the assertions drive.
 * @param {string} protocol
 * @param {Parameters<typeof mockProvider>[1]} [options] the turns, failures and validation the mock replays
 * @param {Record<string, unknown>} [presetOptions] extra preset fields merged into the written `fixture.json`
 * @param {{ preset: string, model: string, effort?: string }} [model] the engine's default model;
 *   cases that check what compaction asks for leave the effort out on purpose.
 */
async function setup(protocol, options = {}, presetOptions = {}, model = { preset: 'fixture', model: 'test-model', effort: 'low' }) {
  const home = tempHome(); cleanup.push(() => removeHome(home));
  const mock = mockProvider(protocol, options); cleanup.push(mock.stop);
  const engine = await startEngine({ home, env: { JOLO_CREDENTIALS: 'session' } }); cleanup.push(() => engine.stop());
  // Load a user preset on a fresh engine boot, the same path users configure.
  const dir = path.join(engine.paths.dataDir, 'providers'); mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'fixture.json'), JSON.stringify({ id: 'fixture', displayName: 'Fixture', protocol, baseUrl: mock.baseUrl,
    auth: { kind: protocol === 'anthropic' ? 'x-api-key' : protocol === 'gemini' ? 'x-goog-api-key' : 'bearer' }, listing: protocol === 'gemini' ? 'gemini' : protocol === 'anthropic' ? 'anthropic' : 'openai',
    defaults: { contextWindowTokens: 64000, maxOutputTokens: 4096 }, thinkingBudgets: { low: 1024, medium: 2048, high: 3072 }, headers: protocol === 'anthropic' ? { 'anthropic-version': '2023-06-01' } : {}, ...presetOptions }));
  await engine.stop();
  const restarted = await startEngine({ home, env: { JOLO_CREDENTIALS: 'session' } }); cleanup.push(() => restarted.stop());
  const client = await restarted.connect(); cleanup.push(() => client.close());
  await client.call('credential.set', { provider: 'fixture', value: 'fixture-secret-key' });
  await client.call('settings.update', { model });
  const { session, cursor } = await openSession(client, home);
  const events = []; await client.subscribe({ after: cursor, sessionId: session.id }, { onEvent: e => events.push(e) });
  const start = async (id = 'run', extra = {}) => (await client.call('run.start', { sessionId: session.id, requestId: id, prompt: 'Inspect this project.', ...extra })).run;
  const finish = run => waitFor(async () => { const r = await client.call('run.snapshot', { runId: run.id }); return ['completed', 'failed', 'paused', 'cancelled'].includes(r.run.state) && r; }, { timeoutMs: 12000, label: `${protocol} finished` });
  return { client, mock, session, events, start, finish, home };
}

for (const protocol of PROTOCOLS) describe(`${protocol} harness conformance`, () => {
  test('text, discovery, usage and endpoint authentication', async () => {
    const { client, mock, start, finish, events } = await setup(protocol);
    expect((await client.call('provider.presets', {})).presets.find(p => p.id === 'fixture').available).toBe(true);
    expect((await client.call('provider.models', { preset: 'fixture' })).models[0].id).toBe('test-model');
    const result = await finish(await start());
    expect(result.run.state).toBe('completed');
    expect(result.run.usage).toMatchObject({ inputTokens: 42, outputTokens: 7, cachedInputTokens: 5 });
    const message = result.messages.find(m => m.role === 'assistant' && m.kind === 'text');
    expect((await client.call('artifact.read', { artifactId: message.artifactId })).text).toBe('Fixture answer.');
    expect(JSON.stringify(mock.requests[0].headers)).toContain('fixture-secret-key');
    expect(JSON.stringify(events)).not.toContain('fixture-secret-key');
    expect(events.find(e => e.type === 'provider.attempt').payload.preset).toBe('fixture');
  });
  test('streamed tools, image input and native reasoning replay', async () => {
    const { client, mock, session, start, finish } = await setup(protocol, { turns: [{ tool: true }, {}] });
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
    const { artifactId } = await client.call('attachment.create', { sessionId: session.id, mimeType: 'image/png' });
    await client.call('attachment.write', { sessionId: session.id, artifactId, offset: 0, data: image.toString('base64'), final: true });
    const result = await finish(await start('image', { attachments: [{ artifactId, name: 'pixel.png', mimeType: 'image/png', bytes: image.length }] }));
    expect(result.run.state).toBe('completed'); expect(mock.requests).toHaveLength(2);
    expect(result.run.usage.inputTokens).toBe(84); expect(result.run.usage.cachedInputTokens).toBe(10);
    expect(result.messages.some(m => m.kind === 'reasoning')).toBe(true);
    const body = JSON.stringify(mock.requests[1].body);
    expect(body).toContain(image.toString('base64')); expect(body).toContain('list_files'); expect(body).toContain('entries');
    if (protocol === 'openai-chat') expect(mock.requests[1].body.messages.find(m => m.tool_calls)?.reasoning_content).toBe('Inspect files.');
    else expect(body).toContain('SIGNED-FIXTURE');
  });
  test('429 retries; 401 does not; returned secrets are redacted', async () => {
    const retry = await setup(protocol, { failures: [429] });
    expect((await retry.finish(await retry.start())).run.state).toBe('completed'); expect(retry.mock.requests).toHaveLength(2);
    const auth = await setup(protocol, { failures: [{ status: 401, message: 'fixture-secret-key' }] });
    const result = await auth.finish(await auth.start());
    expect(result.run.state).toBe('failed'); expect(result.run.failure).toContain('auth'); expect(result.run.failure).not.toContain('fixture-secret-key'); expect(auth.mock.requests).toHaveLength(1);
  });
  test('incomplete and unterminated streams fail', async () => {
    const incomplete = await setup(protocol, { turns: [{ incomplete: true }] });
    expect((await incomplete.finish(await incomplete.start())).run.failure).toContain('incomplete');
    const broken = await setup(protocol, { raw: ': no completion\n\n' });
    expect((await broken.finish(await broken.start())).run.failure).toContain('without a completion'); expect(broken.mock.requests).toHaveLength(3);
  });
  test('cancellation interrupts a stalled stream', async () => {
    const { client, mock, start, finish } = await setup(protocol, { hang: true });
    const run = await start(); await waitFor(() => mock.requests.length === 1);
    await client.call('run.cancel', { runId: run.id });
    expect((await finish(run)).run.state).toBe('cancelled');
  });
  test('response byte cap includes ignored SSE comments', async () => {
    const { mock, start, finish } = await setup(protocol, { raw: (':' + 'x'.repeat(200) + '\n').repeat(42000) + '\n' + wireTurn(protocol) });
    const result = await finish(await start()); expect(result.run.state).toBe('failed'); expect(result.run.failure).toContain('8 MiB'); expect(mock.requests).toHaveLength(1);
  });
  test('changing the model drops foreign native data and preserves neutral tool history', async () => {
    const { client, mock, session, start, finish } = await setup(protocol, { turns: [{ tool: true }, {}, {}] });
    expect((await finish(await start())).run.state).toBe('completed');
    const current = (await client.call('session.page', { sessionId: session.id })).session;
    await client.call('session.setModel', { sessionId: session.id, expectedRevision: current.revision, model: { preset: 'fixture', model: 'another-model' } });
    expect((await finish(await start('changed'))).run.state).toBe('completed');
    const body = JSON.stringify(mock.requests[2].body);
    expect(body).not.toContain('SIGNED-FIXTURE'); expect(body).toContain('list_files'); expect(body).toContain('entries');
    if (protocol === 'openai-chat') expect(body).not.toContain('Inspect files.');
  });
  test('an explicit provider context limit compacts history and retries once', async () => {
    const { client, mock, start, finish, events } = await setup(protocol, { turns: [{ text: 'x'.repeat(24000) }, { text: 'Summary of previous work.' }, {}], failures: [null, { status: 400, message: 'maximum context length is 16000 tokens' }] });
    expect((await finish(await start())).run.state).toBe('completed');
    const result = await finish(await start('limited'));
    expect(result.run.state).toBe('completed');
    expect(mock.requests).toHaveLength(4);
    expect(events.some(e => e.type === 'context.compacted' && e.payload.reason.includes('16000'))).toBe(true);
    expect(result.run.usage.contextWindow).toBe(16000 - 4096 - 4000);
  });
  test('compaction asks for no reasoning when the run uses none', async () => {
    const { mock, start, finish } = await setup(protocol, { turns: [{ text: 'x'.repeat(24000) }, { text: 'Summary of previous work.' }, {}], failures: [null, { status: 400, message: 'maximum context length is 16000 tokens' }] }, {}, { preset: 'fixture', model: 'test-model' });
    expect((await finish(await start())).run.state).toBe('completed');
    expect((await finish(await start('limited'))).run.state).toBe('completed');
    expect(mock.requests).toHaveLength(4);
    const compaction = JSON.stringify(mock.requests[2].body);
    expect(compaction).toContain('compacting');
    for (const field of ['reasoning_effort', 'thinking', 'reasoning', 'thinkingConfig', 'output_config']) expect(compaction).not.toContain(`"${field}"`);
  });
  test('queued runs retain selection from admission when the default changes', async () => {
    const { client, mock, session, start, finish } = await setup(protocol);
    // An unfinished native turn holds this workspace while the next request is admitted.
    await client.call('settings.update', { model: { preset: 'fake', model: 'fake' } });
    const active = await start('holding');
    const queued = await start('queued', { execution: { preset: 'fixture', model: 'queued-model' } });
    await client.call('settings.update', { providers: { fixture: { baseUrl: 'http://127.0.0.1:1' } }, model: { preset: 'fake', model: 'fake' } });
    const result = await finish(queued); expect(result.run.state).toBe('completed');
    const request = mock.requests.at(-1);
    if (protocol === 'gemini') expect(request.url).toContain('/models/queued-model:'); else expect(request.body.model).toBe('queued-model');
    await finish(active);
  });
  test('a paused run keeps its endpoint and model after session and default changes', async () => {
    const { client, mock, session, start, finish } = await setup(protocol, { turns: [{ tool: true }, {}] });
    await client.call('settings.update', { budgets: { maxIterations: 1 } });
    const run = await start(); expect((await finish(run)).run.state).toBe('paused');
    const current = (await client.call('session.page', { sessionId: session.id })).session;
    await client.call('session.setModel', { sessionId: session.id, expectedRevision: current.revision, model: { preset: 'fake', model: 'fake' } });
    await client.call('settings.update', { model: { preset: 'fake', model: 'fake' }, providers: { fixture: { baseUrl: 'http://127.0.0.1:1' } }, budgets: { maxIterations: 3 } });
    await client.call('run.resume', { runId: run.id });
    const result = await finish(run); expect(result.run.state).toBe('completed'); expect(mock.requests).toHaveLength(2);
    if (protocol === 'openai-chat') expect(mock.requests[1].body.messages.find(m => m.tool_calls).reasoning_content).toBe('Inspect files.');
    if (protocol === 'gemini') expect(mock.requests[1].url).toContain('/models/test-model:'); else expect(mock.requests[1].body.model).toBe('test-model');
  });
});

test('a rejection as too long without a stated maximum compacts history and retries once', async () => {
  const { mock, start, finish, events } = await setup('openai-chat', { turns: [{ text: 'x'.repeat(24000) }, { text: 'Summary of previous work.' }, {}], failures: [null, { status: 400, message: 'Prompt contains 40000 tokens, too large for model with maximum context length' }] });
  expect((await finish(await start())).run.state).toBe('completed');
  const result = await finish(await start('rejected'));
  expect(result.run.state).toBe('completed');
  expect(mock.requests).toHaveLength(4);
  expect(events.find(e => e.type === 'context.compacted').payload.reason).toContain('too long');
  // The window is now the size of the rejected request, so later turns compact before they overflow.
  expect(result.run.usage.contextWindow).toBeGreaterThan(0);
  expect(result.run.usage.contextWindow).toBeLessThan(64000 - 4096 - 4000);
  const again = await setup('openai-chat', { failures: [{ status: 400, message: 'prompt is too long' }, { status: 400, message: 'prompt is too long' }] });
  const failed = await again.finish(await again.start());
  expect(failed.run.state).toBe('failed'); expect(failed.run.failure).toContain('context_length'); expect(again.mock.requests).toHaveLength(2);
});

test('a declined batch leaves no unanswered tool call in the next request', async () => {
  const usage = { prompt_tokens: 1, completion_tokens: 1 };
  const calls = [{ index: 0, id: 'cmd', function: { name: 'run_command', arguments: JSON.stringify({ argv: ['true'] }) } }, { index: 1, id: 'files', function: { name: 'list_files', arguments: JSON.stringify({ path: '.' }) } }];
  const raw = [{ choices: [{ index: 0, delta: { tool_calls: calls } }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }, { choices: [], usage }].map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  const { client, mock, start, finish, events } = await setup('openai-chat', { raw });
  const decline = async (index) => {
    const asked = await waitFor(() => events.filter(e => e.type === 'permission.requested')[index], { timeoutMs: 8000, label: 'permission request' });
    await client.call('permission.resolve', { permissionId: asked.payload.permissionId, decision: 'deny' });
  };
  const interrupted = await start('interrupted');
  await decline(0);
  expect((await finish(interrupted)).run.state).toBe('paused');
  await client.call('run.cancel', { runId: interrupted.id });
  expect((await finish(interrupted)).run.state).toBe('cancelled');
  const next = await start('next');
  await decline(1);
  expect((await finish(next)).run.state).toBe('paused');
  const replayed = mock.requests[1].body.messages;
  expect(replayed.find(m => m.tool_calls).tool_calls.map(c => c.id)).toEqual(['cmd', 'files']);
  expect(replayed.filter(m => m.role === 'tool').map(m => m.tool_call_id)).toEqual(['cmd', 'files']);
  expect(replayed.find(m => m.tool_call_id === 'files').content).toContain('interrupted');
  expect(replayed.at(-1)).toMatchObject({ role: 'user', content: 'Inspect this project.' });
});

for (const format of ['reasoning_content', 'reasoning', 'reasoning_details']) test(`chat reasoning replay: ${format} survives tool turns, final answers, and the next user request`, async () => {
  const reasoning = label => format === 'reasoning_details' ? [
    { reasoning_details: [{ type: 'reasoning.text', text: `${label} 🧭`, index: 0, id: label, signature: null }] },
    { reasoning_details: [{ type: 'reasoning.text', text: '\nnext step', index: 0, id: label, signature: `signed-${label}` }, { type: 'reasoning.encrypted', data: `opaque-${label}`, index: 1 }] },
  ] : [{ [format]: `${label} 🧭` }, { [format]: '\nnext step' }];
  const expected = label => format === 'reasoning_details' ? reasoning(label).flatMap(c => c.reasoning_details) : `${label} 🧭\nnext step`;
  const { mock, start, finish } = await setup('openai-chat', {
    turns: [
      { reasoningChunks: reasoning('A') },
      { tool: true, callId: 'first', reasoningChunks: reasoning('B') },
      { tool: true, callId: 'second', reasoningChunks: reasoning('C') },
      { reasoningChunks: reasoning('D') },
      { reasoningChunks: reasoning('E') },
    ],
    validate(body, index) {
      const replies = body.messages.filter(m => m.role === 'assistant');
      if (replies.length !== index) return 'assistant turn missing';
      for (let i = 0; i < replies.length; i++) if (JSON.stringify(replies[i][format]) !== JSON.stringify(expected('ABCDE'[i]))) return `missing or altered ${format} for turn ${i}`;
      if (index >= 2 && body.messages.filter(m => m.role === 'tool').length !== Math.min(index - 1, 2)) return 'missing tool result';
    },
  }, { chatReasoning: { thinkingToggle: true, effortParameter: format === 'reasoning_details' ? 'reasoning.effort' : 'reasoning_effort' } });
  for (const id of ['first-user-turn', 'tools', 'next-user-turn']) expect((await finish(await start(id))).run.state).toBe('completed');
  expect(mock.requests).toHaveLength(5);
  expect(mock.requests.every(r => r.body.thinking.type === 'enabled')).toBe(true);
  expect(mock.requests[4].body.messages.filter(m => m.role === 'assistant').map(m => m[format])).toEqual(['A', 'B', 'C', 'D'].map(expected));
});
