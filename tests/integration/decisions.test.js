import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { startEngine, tempHome, removeHome, waitFor, openSession } from './helpers.js';
import { mockProvider } from '../fixtures/mock-providers.js';

test.each(['openrouter', 'typesafe'])('Jev via %s is the primary model, survives reconnect, and accepts typed requests without a helper', async (transport) => {
  const home = tempHome(), requests = [];
  const model = { preset: 'decisions', model: transport === 'typesafe' ? 'jev-latest' : '~typesafe/jev-latest', mode: 'decisions' };
  const prompt = { state: 'Hello', questions: { greeting: { type: 'choice', instructions: 'Classify this message', criteria: { yes: 'A greeting', no: 'Work to do' } } } };
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (request.method === 'GET') return Response.json(transport === 'typesafe' ? { models: [{ name: model.model }] } : { data: [{ id: model.model, architecture: { output_modalities: ['decisions'] } }] });
    requests.push({ path: new URL(request.url).pathname, body: await request.json() });
    return Response.json({ model: model.model, answers: { greeting: { type: 'choice', choice: 'yes', confidence: 1, probabilities: { yes: 1, no: 0 } } }, usage: { input_tokens: 10, output_tokens: 5 } });
  } });
  let engine;
  try {
    const dir = path.join(home, 'data/t/providers');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'decisions.json'), JSON.stringify({ id: 'decisions', displayName: 'Decision fixture', protocol: transport === 'typesafe' ? 'typesafe' : 'openai-chat', baseUrl: server.url.origin + '/api/v1', auth: { kind: 'none' }, listing: transport, defaults: { contextWindowTokens: 32000, maxOutputTokens: 4096 } }));
    engine = await startEngine({ home });
    let client = await engine.connect();
    const original = (await client.call('settings.get', {})).settings;
    const { project, session } = await openSession(client, home);
    const { session: other } = await client.call('session.create', { projectId: project.projectId, workspaceId: project.workspaceId });
    const updated = (await client.call('session.setAgent', { sessionId: session.id, agentId: null, model, expectedRevision: session.revision })).session;
    expect(updated.model).toMatchObject(model);
    expect((await client.call('session.page', { sessionId: other.id })).session.model).toEqual(other.model);
    // The selection must be durable before any message is sent.
    await client.close(); await engine.stop();
    engine = await startEngine({ home }); client = await engine.connect();
    const restored = (await client.call('session.page', { sessionId: session.id })).session;
    expect(restored).toMatchObject({ agentId: null, model });
    expect((await client.call('settings.get', {})).settings).toEqual(original);
    const send = async (requestId, text) => {
      const { run } = await client.call('run.start', { sessionId: session.id, requestId, prompt: text });
      return waitFor(async () => {
        const value = await client.call('run.snapshot', { runId: run.id });
        return ['completed', 'failed', 'paused'].includes(value.run.state) ? value : null;
      }, { timeoutMs: 15_000, label: 'Jev run finished' });
    };
    const result = await send('jev-direct', JSON.stringify(prompt));
    expect(result.run.state).toBe('completed');
    const messages = result.messages.filter(m => m.role === 'assistant' && m.kind === 'text');
    expect(messages).toHaveLength(1);
    expect((await client.call('artifact.read', { artifactId: messages[0].artifactId })).text).toContain('Choice: **yes**');
    expect(requests).toEqual([{ path: transport === 'typesafe' ? '/api/v1/systemone' : '/api/alpha/decisions', body: { ...prompt, model: model.model } }]);
    const invalid = await send('jev-invalid', 'Write some code');
    expect(invalid.run.state).toBe('failed');
    expect(invalid.run.failure).toContain('Select a text model first');
    expect(requests).toHaveLength(1);
    await client.close();
  } finally { await engine?.stop(); server.stop(true); removeHome(home); }
}, 30_000);

test('any OpenRouter decision model pairs with chat: greetings, decision tool, reconnect and existing selections', async () => {
  const home = tempHome(), decisionRequests = [];
  const decisionId = 'example/routing-model'; // Capability metadata, not the Jev name, selects the transport.
  const args = { state: 'Hello', question: 'Classify the message', options: [{ label: 'greeting', description: 'A greeting' }, { label: 'task', description: 'Work to do' }] };
  const chat = mockProvider('openai-chat', { turns: [
    { text: 'Hello! How can I help?' },
    { tool: true, toolName: 'decision_choose', args },
    { text: 'The decision model classified it as a greeting.' },
    { text: 'Hello from the configured chat model.' },
  ] });
  const decisions = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (request.method === 'GET') return Response.json({ data: [{ id: decisionId, architecture: { output_modalities: ['decisions'] } }] });
    decisionRequests.push({ path: new URL(request.url).pathname, body: await request.json() });
    return Response.json({ model: decisionId, answers: { decision: { type: 'choice', choice: 'greeting', confidence: 1, probabilities: { greeting: 1, task: 0 } } } });
  } });
  let engine;
  try {
    const dir = path.join(home, 'data/t/providers'); mkdirSync(dir, { recursive: true });
    for (const [id, baseUrl, listing] of [['decision-test', decisions.url.origin + '/api/v1', 'openrouter'], ['chat-test', chat.baseUrl, 'openai']]) {
      writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, displayName: id, protocol: 'openai-chat', baseUrl, listing, auth: { kind: 'none' }, defaults: { contextWindowTokens: 64000, maxOutputTokens: 4096 } }));
    }
    engine = await startEngine({ home }); let client = await engine.connect();
    const { project, session } = await openSession(client, home);
    const chatModel = { preset: 'chat-test', model: 'test-model' };
    await client.call('session.setAgent', { sessionId: session.id, agentId: null, model: { preset: 'decision-test', model: decisionId, mode: 'decisions', chatModel }, expectedRevision: session.revision });
    await client.close(); await engine.stop();
    engine = await startEngine({ home }); client = await engine.connect();
    expect((await client.call('session.page', { sessionId: session.id })).session.model.chatModel).toMatchObject(chatModel);
    const send = async (sessionId, requestId, prompt) => {
      const { run } = await client.call('run.start', { sessionId, requestId, prompt });
      const result = await waitFor(async () => {
        const value = await client.call('run.snapshot', { runId: run.id });
        return ['completed', 'failed', 'paused'].includes(value.run.state) ? value : null;
      }, { timeoutMs: 15_000 });
      expect(result.run.state).toBe('completed');
      return result;
    };
    await send(session.id, 'greeting', 'hi');
    expect(decisionRequests).toHaveLength(0);
    expect(chat.requests[0].body.model).toBe('test-model');
    expect(chat.requests[0].body.tools.some(tool => tool.function.name === 'decision_choose')).toBe(true);
    await send(session.id, 'classification', 'Use the decision model to classify Hello.');
    expect(decisionRequests).toEqual([{ path: '/api/alpha/decisions', body: { model: decisionId, state: 'Hello', questions: { decision: { type: 'choice', instructions: args.question, criteria: { greeting: 'A greeting', task: 'Work to do' } } } } }]);
    const toolResult = chat.requests[2].body.messages.find(message => message.role === 'tool');
    expect(JSON.parse(toolResult.content)).toMatchObject({ ok: true, model: decisionId, answers: { decision: { choice: 'greeting' } } });
    // Existing decision selections with no mode or pairing also work from reported metadata.
    await client.call('settings.update', { model: chatModel });
    const { session: old } = await client.call('session.create', { projectId: project.projectId, workspaceId: project.workspaceId });
    await client.call('session.setModel', { sessionId: old.id, expectedRevision: old.revision, model: { preset: 'decision-test', model: decisionId } });
    await send(old.id, 'legacy-greeting', 'hi');
    expect(chat.requests).toHaveLength(4);
    expect(decisionRequests).toHaveLength(1);
    await client.close();
  } finally { await engine?.stop(); decisions.stop(true); chat.stop(); removeHome(home); }
}, 30_000);
