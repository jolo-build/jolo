// Computer use end to end: a scripted host answers the screenshot, the engine stores it as an
// artifact, and each vendor wire carries the pixels to the model inside the tool result (§5.3, §7.1).
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { startEngine, tempHome, removeHome, openSession, waitFor } from './helpers.js';
import { mockProvider, PROTOCOLS } from '../fixtures/mock-providers.js';
import { scriptedHost, PNG_BASE64 } from '../fixtures/scripted-browser-host.js';

const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function setup(protocol, options, presetOptions = {}) {
  const home = tempHome(); cleanup.push(() => removeHome(home));
  const mock = mockProvider(protocol, options); cleanup.push(mock.stop);
  const engine = await startEngine({ home, env: { JOLO_CREDENTIALS: 'session' } }); cleanup.push(() => engine.stop());
  const dir = path.join(engine.paths.dataDir, 'providers'); mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'fixture.json'), JSON.stringify({ id: 'fixture', displayName: 'Fixture', protocol, baseUrl: mock.baseUrl,
    auth: { kind: protocol === 'anthropic' ? 'x-api-key' : protocol === 'gemini' ? 'x-goog-api-key' : 'bearer' }, listing: protocol === 'gemini' ? 'gemini' : protocol === 'anthropic' ? 'anthropic' : 'openai',
    defaults: { contextWindowTokens: 64000, maxOutputTokens: 4096 }, thinkingBudgets: { low: 1024, medium: 2048, high: 3072 }, headers: protocol === 'anthropic' ? { 'anthropic-version': '2023-06-01' } : {}, ...presetOptions }));
  await engine.stop();
  const restarted = await startEngine({ home, env: { JOLO_CREDENTIALS: 'session' } }); cleanup.push(() => restarted.stop());
  const client = await restarted.connect(); cleanup.push(() => client.close());
  await client.call('credential.set', { provider: 'fixture', value: 'fixture-secret-key' });
  await client.call('settings.update', { model: { preset: 'fixture', model: 'test-model', effort: 'low' } });
  const { project, session, cursor } = await openSession(client, home);
  const host = await scriptedHost(restarted, project.workspaceId); cleanup.push(() => host.client.close());
  const events = []; await client.subscribe({ after: cursor, sessionId: session.id }, { onEvent: e => events.push(e) });
  const start = async () => (await client.call('run.start', { sessionId: session.id, requestId: 'run', prompt: 'Look at the page.' })).run;
  const finish = run => waitFor(async () => { const r = await client.call('run.snapshot', { runId: run.id }); return ['completed', 'failed', 'paused', 'cancelled'].includes(r.run.state) && r; }, { timeoutMs: 12000, label: `${protocol} finished` });
  return { client, mock, host, events, start, finish };
}

for (const protocol of PROTOCOLS) describe(`${protocol} computer use`, () => {
  test('a screenshot reaches the model as an image with its tool result, never through events', async () => {
    const { mock, host, events, start, finish } = await setup(protocol, { turns: [{ tool: true, toolName: 'browser_screenshot', args: {} }, {}] });
    const result = await finish(await start());
    expect(result.run.state, result.run.failure).toBe('completed');
    expect(host.received.map(r => r.operation)).toEqual(['screenshot']);
    expect(mock.requests).toHaveLength(2);
    const body = mock.requests[1].body;
    expect(JSON.stringify(body)).toContain(PNG_BASE64);
    expect(JSON.stringify(events)).not.toContain(PNG_BASE64);
    expect(events.find(e => e.type === 'tool.completed').payload).toMatchObject({ name: 'browser_screenshot', status: 'ok' });
    if (protocol === 'anthropic') {
      const block = body.messages.flatMap(m => m.content).find(b => b.type === 'tool_result');
      expect(block.content[0].text).toContain('"scale":1');
      expect(block.content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_BASE64 } });
      expect(block.toolset_name).toBeUndefined();
      expect(mock.requests[0].body.tools.some(t => t.type)).toBe(false);
    } else if (protocol === 'openai-responses') {
      const output = body.input.find(i => i.type === 'function_call_output').output;
      expect(output[0]).toMatchObject({ type: 'input_text' });
      expect(output[1]).toEqual({ type: 'input_image', image_url: `data:image/png;base64,${PNG_BASE64}`, detail: 'auto' });
    } else if (protocol === 'openai-chat') {
      const index = body.messages.findIndex(m => m.role === 'tool');
      expect(body.messages[index + 1].role).toBe('user');
      expect(body.messages[index + 1].content[1]).toEqual({ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_BASE64}` } });
    } else {
      const response = body.contents.flatMap(c => c.parts).find(p => p.functionResponse).functionResponse;
      expect(response.parts).toEqual([{ inlineData: { mimeType: 'image/png', data: PNG_BASE64 } }]);
    }
  });
});

test('the native computer toolset declares itself on the Messages wire, runs members as portable tools, and replays them as made', async () => {
  const { mock, host, events, start, finish } = await setup('anthropic', { turns: [
    { tool: true, toolName: 'screenshot', toolset: 'computer', args: {}, callId: 'shot' },
    { tool: true, toolName: 'left_click', toolset: 'computer', args: { coordinate: [10, 20], text: 'shift' }, callId: 'click' },
    {},
  ] }, { computerUse: 'native' });
  const result = await finish(await start());
  expect(result.run.state, result.run.failure).toBe('completed');
  const declared = mock.requests[0].body.tools;
  expect(declared[0]).toMatchObject({ type: 'computer_toolset_20260801', configs: { cursor_position: { enabled: false } } });
  expect(declared.map(t => t.name)).toContain('browser_click');
  expect(declared.map(t => t.name)).not.toContain('browser_screenshot');
  expect(host.received.map(r => r.operation)).toEqual(['screenshot', 'pointer']);
  expect(host.received[1].arguments).toMatchObject({ action: 'click', x: 10, y: 20, modifiers: ['Shift'] });
  // The transcript and events record the portable calls the dispatcher admitted.
  expect(events.filter(e => e.type === 'tool.started').map(e => e.payload.name)).toEqual(['browser_screenshot', 'browser_pointer']);
  const third = mock.requests[2].body;
  const uses = third.messages.filter(m => m.role === 'assistant').flatMap(m => m.content).filter(b => b.type === 'tool_use');
  expect(uses).toEqual([
    { type: 'tool_use', id: 'shot', name: 'screenshot', toolset_name: 'computer', input: {} },
    { type: 'tool_use', id: 'click', name: 'left_click', toolset_name: 'computer', input: { coordinate: [10, 20], text: 'shift' } },
  ]);
  const results = third.messages.filter(m => m.role === 'user').flatMap(m => m.content).filter(b => b.type === 'tool_result');
  expect(results[0]).toMatchObject({ tool_use_id: 'shot', toolset_name: 'computer', content: [{ type: 'text' }, { type: 'image', source: { data: PNG_BASE64 } }] });
  expect(results[1]).toMatchObject({ tool_use_id: 'click', toolset_name: 'computer' });
  expect(results[1].is_error).toBeUndefined();
});
