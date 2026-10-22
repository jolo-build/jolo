import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, startEngine, tempHome, removeHome, waitFor, TERMINAL } from './helpers.js';

const engines = [], homes = [];
afterEach(async () => { for (const engine of engines.splice(0)) await engine.stop(); for (const home of homes.splice(0)) removeHome(home); });

/** @param {{ env?: Record<string, string>, clientKind?: string }} [options] */
async function boot({ env = {}, clientKind } = {}) {
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
  let engine = await startEngine({ home, idleMs: 30000, env }); engines.push(engine);
  let client = await engine.connect(clientKind ? { clientKind } : {});
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
    engine = await startEngine({ home, idleMs: 30000, env }); engines.push(engine);
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

test('what another agent said is still delivered to Claude after Claude carried on by itself', async () => {
  const app = await boot();
  const session = await app.create('claude');
  await app.send(session.id, 'Start the work.');
  await app.send(session.id, 'background 1500 Background work is done.');
  await app.send(session.id, '@codex The design is in docs/queue.md; use a single worker.');
  // Claude reports its background work in a run of its own, after the guest's turn.
  await waitFor(async () => (await app.client.call('session.page', { sessionId: session.id })).runs.some((run) => run.requestId.startsWith('continue:') && run.state === 'completed'), { label: 'Claude carried on', timeoutMs: 10000 });
  const context = await app.send(session.id, 'history');
  expect(context).toContain('single worker');
  expect(context).not.toContain('Background work is done.'); // what Claude said itself is in its own thread already
}, 30000);

test('a slash command sent to Claude alone does not mark what another agent said as delivered', async () => {
  const app = await boot();
  const session = await app.create('claude');
  await app.send(session.id, 'Start the work.');
  await app.send(session.id, '@codex The design is in docs/queue.md; use a single worker.');
  await app.send(session.id, '/deploy staging'); // Claude's own command: it goes alone, without the shared updates
  const context = await app.send(session.id, 'history');
  expect(context).toContain('single worker');
}, 30000);


test('a native run resumed after a pause is told what another agent said meanwhile, though a command of its own runs first', async () => {
  const scratch = tempHome(); homes.push(scratch);
  const script = path.join(scratch, 'script.json');
  writeFileSync(script, JSON.stringify([{ toolCalls: [{ name: 'run_command', arguments: { argv: ['echo', 'checked'] } }] }, { text: ['after\n'] }]));
  // Nobody can answer at first: the run pauses with its command admitted but not run.
  const app = await boot({ env: { JOLO_FAKE_SCRIPT: script }, clientKind: 'headless' });
  const events = [];
  const { cursor } = await app.client.call('engine.status', {});
  await app.client.subscribe({ after: cursor }, { onEvent: (event) => events.push(event) });
  const session = await app.create(null);
  const { run } = await app.client.call('run.start', { sessionId: session.id, requestId: 'native', prompt: 'Run the check.' });
  await waitFor(() => events.some((e) => e.type === 'run.state' && e.runId === run.id && e.payload.state === 'paused'), { label: 'the run paused', timeoutMs: 20000 });
  const { permissionId } = events.find((e) => e.type === 'run.state' && e.runId === run.id && e.payload.state === 'paused').payload;
  await app.send(session.id, '@claude Keep the cache warm between checks.');
  const human = await app.engine.connect({ clientKind: 'tui' });
  await human.call('permission.resolve', { permissionId, decision: 'allow_once' });
  await waitFor(() => events.some((e) => e.type === 'run.state' && e.runId === run.id && e.payload.state === 'completed'), { label: 'the resumed run completed', timeoutMs: 20000 });
  await human.close();
  const notes = await app.notes(session.id);
  expect(notes.some((note) => note.startsWith('Shared conversation updates while this task was paused') && note.includes('Keep the cache warm'))).toBe(true);
}, 60000);

test('a native run paused again while finishing its commands is still told, when it goes on, what another agent said', async () => {
  const scratch = tempHome(); homes.push(scratch);
  const script = path.join(scratch, 'script.json');
  writeFileSync(script, JSON.stringify([{ toolCalls: [{ name: 'run_command', arguments: { argv: ['echo', 'one'] } }, { name: 'run_command', arguments: { argv: ['echo', 'two'] } }] }, { text: ['after\n'] }]));
  const app = await boot({ env: { JOLO_FAKE_SCRIPT: script }, clientKind: 'headless' });
  const events = [];
  const { cursor } = await app.client.call('engine.status', {});
  await app.client.subscribe({ after: cursor }, { onEvent: (event) => events.push(event) });
  const session = await app.create(null);
  const { run } = await app.client.call('run.start', { sessionId: session.id, requestId: 'native', prompt: 'Run both checks.' });
  const pauses = () => events.filter((e) => e.type === 'run.state' && e.runId === run.id && e.payload.state === 'paused');
  await waitFor(() => pauses().length === 1, { label: 'the run paused on its first command', timeoutMs: 20000 });
  await app.send(session.id, '@claude Keep the cache warm between checks.');
  // The first command is allowed and nobody stays to answer the second: the resumed run pauses again.
  let human = await app.engine.connect({ clientKind: 'tui' });
  await human.call('permission.resolve', { permissionId: pauses()[0].payload.permissionId, decision: 'allow_once' });
  await human.close();
  await waitFor(() => pauses().length === 2, { label: 'the run paused again on its second command', timeoutMs: 20000 });
  human = await app.engine.connect({ clientKind: 'tui' });
  await human.call('permission.resolve', { permissionId: pauses()[1].payload.permissionId, decision: 'allow_once' });
  await waitFor(() => events.some((e) => e.type === 'run.state' && e.runId === run.id && e.payload.state === 'completed'), { label: 'the run completed', timeoutMs: 20000 });
  await human.close();
  const notes = await app.notes(session.id);
  expect(notes.some((note) => note.startsWith('Shared conversation updates while this task was paused') && note.includes('Keep the cache warm'))).toBe(true);
}, 90000);

test('a new model for Claude does not lose the turn Claude began by itself while another agent answered', async () => {
  const app = await boot();
  const session = await app.create('claude');
  await app.send(session.id, 'background 1200 Background work is done.');
  // While a guest answers, Claude reports its background work by itself: that turn waits for a run.
  await app.client.call('run.start', { sessionId: session.id, requestId: 'guest', prompt: '@codex activity-groups' });
  await Bun.sleep(1800);
  const { session: current } = await app.client.call('session.page', { sessionId: session.id });
  await app.client.call('session.setAgentModel', { sessionId: session.id, model: 'haiku', effort: null, expectedRevision: current.revision });
  // The user's next message waits behind the guest, then runs on the new model.
  const { run } = await app.client.call('run.start', { sessionId: session.id, requestId: 'after-switch', prompt: 'model' });
  /** @type {any} */ let snapshot;
  await waitFor(async () => { snapshot = await app.client.call('run.snapshot', { runId: run.id }); return TERMINAL.includes(snapshot.run.state); }, { timeoutMs: 20000 });
  expect(snapshot.run.state).toBe('completed');
  const texts = [];
  for (const message of snapshot.messages.filter((m) => m.role === 'assistant' && m.kind === 'text')) texts.push((await app.client.call('artifact.read', { artifactId: message.artifactId })).text);
  expect(texts.join(' | ')).toContain('Background work is done.'); // the waiting turn was shown, not lost
  expect(await app.send(session.id, 'model')).toMatch(/^Running haiku/); // the next turn runs on the new model
}, 60000);
