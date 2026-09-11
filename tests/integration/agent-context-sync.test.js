import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, startEngine, tempHome, removeHome, waitFor, TERMINAL } from './helpers.js';

const engines = [], homes = [];
afterEach(async () => { for (const engine of engines.splice(0)) await engine.stop(); for (const home of homes.splice(0)) removeHome(home); });

async function boot() {
  const home = tempHome(); homes.push(home);
  const repo = path.join(home, 'repo');
  mkdirSync(path.join(repo, 'docs'), { recursive: true });
  const agents = path.join(home, 'data/t/agents'); mkdirSync(agents, { recursive: true });
  for (const [id, transport] of [['codex', 'codex-app-server'], ['claude', 'claude-stream'], ['acp', 'acp']]) {
    const binary = path.join(home, `fake-${id}`);
    writeFileSync(binary, `#!/bin/sh\nexport FAKE_ACP_STATE='${home}/acp-state'\nexec '${process.execPath}' '${ROOT}/tests/fixtures/fake-${id}.js' "$@"\n`);
    chmodSync(binary, 0o755);
    writeFileSync(path.join(agents, `${id}.json`), JSON.stringify({ id, displayName: id === 'claude' ? 'Claude Code' : id === 'codex' ? 'Codex' : 'ACP Agent', binary, transport, ...(id === 'claude' ? { modelArgs: ['--model', '{model}'] } : {}), ...(id === 'acp' ? { args: ['--acp'] } : {}) }));
  }
  let engine = await startEngine({ home, idleMs: 30000 }); engines.push(engine);
  let client = await engine.connect();
  const project = await client.call('project.open', { path: repo });
  const create = async agentId => (await client.call('session.create', { projectId: project.projectId, workspaceId: project.workspaceId, ...(agentId ? { agentId } : {}) })).session;
  let counter = 0;
  const send = async (sessionId, prompt, expectedState = 'completed') => {
    const { run } = await client.call('run.start', { sessionId, requestId: `turn-${++counter}`, prompt });
    /** @type {import('./helpers.js').RunSnapshot} */ let snapshot;
    await waitFor(async () => { snapshot = await client.call('run.snapshot', { runId: run.id }); return TERMINAL.includes(snapshot.run.state); }, { timeoutMs: 20000 });
    expect(snapshot.run.state, snapshot.run.failure).toBe(expectedState);
    const reply = snapshot.messages.filter(message => message.role === 'assistant' && message.kind === 'text').at(-1);
    let text = '';
    for (let offset = 0; reply;) {
      const page = await client.call('artifact.read', { artifactId: reply.artifactId, offset });
      text += page.text; offset += page.bytes;
      if (page.eof || !page.bytes) break;
    }
    return text;
  };
  const restart = async () => {
    await client.close(); await engine.stop();
    engine = await startEngine({ home, idleMs: 30000 }); engines.push(engine);
    client = await engine.connect();
  };
  // The engine deliberately owns SQLite exclusively. Inspect only after it stops.
  const read = async operation => {
    await client.close(); await engine.stop();
    const db = new Database(engine.paths.databasePath, { readonly: true });
    try { return operation(db); } finally { db.close(); await restart(); }
  };
  return { home, repo, engine, get client() { return client; }, create, send,
    remembered: sessionId => read(db => JSON.parse(db.query('SELECT agent_state FROM sessions WHERE id = ?1').get(sessionId).agent_state)),
    notes: sessionId => read(db => db.query("SELECT payload FROM conversation_items WHERE session_id = ?1 AND kind = 'system_note' ORDER BY ordinal").all(sessionId).map(row => JSON.parse(row.payload).text)),
    restart };
}

test('Codex resumes with Claude’s architecture and file references, even after restarting the engine', async () => {
  const app = await boot();
  await app.client.call('settings.update', { agents: { claude: { model: 'fable' } } });
  const session = await app.create('codex');
  await app.send(session.id, 'Build the task service after Claude writes its architecture.');
  const before = await app.remembered(session.id);
  await app.send(session.id, '@claude write docs/architecture.md Use a durable queue and an idempotent worker.');
  expect(readFileSync(path.join(app.repo, 'docs/architecture.md'), 'utf8')).toContain('idempotent worker');
  await app.client.call('settings.update', { agents: { claude: { model: 'haiku' } } });
  await app.restart();
  const context = await app.send(session.id, 'history');
  expect(context).toStartWith('Resumed context:');
  expect(context).toContain('Claude Code (fable)');
  expect(context).toContain('docs/architecture.md');
  expect(context).toContain('idempotent worker');
  const after = await app.remembered(session.id);
  expect(after.codex.codexThreadId).toBe(before.codex.codexThreadId);
  expect(await app.send(session.id, 'history')).toBe('Resumed context: history');
}, 30000);

test('a failed catch-up does not acknowledge the guest’s work before a successful retry', async () => {
  const app = await boot();
  const session = await app.create('codex');
  await app.send(session.id, 'Start the work.');
  const seen = (await app.remembered(session.id))._jolo.seen.codex;
  await app.send(session.id, '@claude Use docs/retry-design.md for implementation.');
  await app.send(session.id, 'fail this attempt', 'failed');
  expect((await app.remembered(session.id))._jolo.seen.codex).toBe(seen);
  expect(await app.send(session.id, 'history')).toContain('docs/retry-design.md');
  expect(await app.send(session.id, 'history')).toBe('Resumed context: history');
}, 30000);

test('the native loop receives a guest’s work even when the session’s selected agent stays Jolo', async () => {
  const app = await boot();
  const session = await app.create(null);
  await app.send(session.id, 'Start the work.');
  await app.send(session.id, '@claude Write the design in docs/native-design.md.');
  await app.send(session.id, 'Implement Claude’s design.');
  const notes = await app.notes(session.id);
  expect(notes).toHaveLength(1);
  expect(notes[0]).toContain('Claude Code');
  expect(notes[0]).toContain('docs/native-design.md');
  await app.send(session.id, 'Continue implementation.');
  expect(await app.notes(session.id)).toEqual(notes);
}, 30000);

test('Claude and ACP also catch up after a guest turn, without replaying it on every prompt', async () => {
  const app = await boot();
  for (const agent of ['claude', 'acp']) {
    const session = await app.create(agent);
    await app.send(session.id, 'Start the work.');
    await app.send(session.id, '@codex The design is in docs/queue.md; use a single worker.');
    const context = await app.send(session.id, 'history');
    expect(context).toStartWith('Resumed context:');
    expect(context).toContain('docs/queue.md');
    expect(context).toContain('single worker');
    expect(await app.send(session.id, 'history')).toBe('Resumed context: history');
  }
}, 30000);
