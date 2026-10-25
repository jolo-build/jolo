import { expect, test } from 'bun:test';
import { RemotePrompts } from '../src/account/remote-prompts.js';

// The relay client against fakes: what it remembers across restarts and accounts, cancels that
// race the start of a run, requests too long to approve from the web, and replies that do not sync.
const CHAT = '11111111-1111-4111-8111-111111111111', SESSION = 'ses_1';
const id = () => crypto.randomUUID();
const settle = async check => { for (let i = 0; i < 100; i++) { if (check()) return; await Bun.sleep(10); } throw new Error('did not settle'); };

function world() {
  const preferences = new Map(), runs = new Map(), permissions = new Map(), sockets = [];
  const storage = {
    getPreference: key => structuredClone(preferences.get(key)),
    setPreference: (key, value) => preferences.set(key, structuredClone(value)),
    getWorkspace: () => ({ id: 'wks_1', projectId: 'prj_1' }),
    getSession: sessionId => ({ id: sessionId, workspaceId: 'wks_1', state: 'active' }),
    sessionHasBusyRuns: () => false,
    getRun: runId => runs.get(runId) ?? null,
    pendingPermissionForRun: runId => permissions.get(runId) ?? null,
    db: { query: () => ({ all: () => [] }) },
  };
  const account = { origin: 'https://access.test', credential: 'token', ready: Promise.resolve(), record: { account: { id: 'acct_1' }, device: { scopes: ['prompts:run'] } }, changed() {}, snapshot: () => ({}) };
  const sync = { synced: true, error: null };
  const chatSync = { identity: () => `${account.origin}:${account.record.account.id}`, status: () => ({ enabled: true, error: sync.error }), run: async () => {}, synced: () => sync.synced };
  storage.setPreference(`chat-sync-map:${chatSync.identity()}`, { [SESSION]: { remote: CHAT } });
  class FakeSocket {
    constructor(url, options) {
      this.url = url; this.options = options; this.sent = []; this.closed = false;
      /** @type {null | (() => void)} */ this.onopen = null;
      /** @type {null | ((event: { data: string }) => void)} */ this.onmessage = null;
      sockets.push(this); setTimeout(() => this.onopen?.(), 0);
    }
    send(data) { this.sent.push(data); }
    close() { this.closed = true; }
    deliver(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
    messages() { return this.sent.filter(data => data !== 'ping').map(data => JSON.parse(data)); }
  }
  const calls = [];
  const handlers = {
    'run.start': async params => { calls.push(['run.start', params]); const runId = `run_${calls.length}`; runs.set(runId, { id: runId, state: 'running' }); return { run: { id: runId } }; },
    'run.cancel': async params => { calls.push(['run.cancel', params]); runs.get(params.runId).state = 'cancelled'; },
  };
  const resolved = [];
  const start = () => {
    const remote = new RemotePrompts({ account, storage, chatSync, handlers, resolvePermission: params => resolved.push(params), WebSocketImpl: FakeSocket, pingMs: 60_000 });
    clearInterval(remote.watch);
    remote.refresh();
    return remote;
  };
  return { preferences, runs, permissions, sockets, account, sync, handlers, calls, resolved, start, socket: () => sockets.at(-1) };
}

test('a prompt accepted before a restart still reports how it ended', async () => {
  const w = world();
  let remote = w.start();
  await settle(() => w.socket()?.messages().some(m => m.type === 'hello'));
  const prompt = id();
  w.socket().deliver({ type: 'prompt', id: prompt, chatId: CHAT, text: 'Fix it' });
  await settle(() => w.socket().messages().some(m => m.status === 'accepted'));
  await remote.stop();

  // The run ends while the engine is down, as startup recovery would leave it.
  w.runs.get('run_1').state = 'failed';
  remote = w.start();
  await settle(() => w.socket().messages().some(m => m.type === 'hello'));
  await remote.poll();
  expect(w.socket().messages().filter(m => m.type === 'status' && m.id === prompt).map(m => m.status)).toEqual(['accepted', 'failed']);
  expect(w.socket().messages().findLast(m => m.id === prompt)).toMatchObject({ status: 'failed', chatId: CHAT });
  expect(remote.tracked.size).toBe(0);
  await remote.stop();
});

test('a cancel that arrives while the run starts stops it, and one for an unknown prompt is answered', async () => {
  const w = world();
  const remote = w.start();
  await settle(() => w.socket()?.messages().some(m => m.type === 'hello'));
  /** @type {null | ((value?: unknown) => void)} */
  let release = null;
  const start = w.handlers['run.start'];
  w.handlers['run.start'] = async params => { await new Promise(resolve => { release = resolve; }); return start(params); };
  const prompt = id();
  w.socket().deliver({ type: 'prompt', id: prompt, chatId: CHAT, text: 'Fix it' });
  await settle(() => release);
  w.socket().deliver({ type: 'cancel', id: prompt });
  release?.();
  await settle(() => w.calls.some(([name]) => name === 'run.cancel'));
  await remote.poll();
  expect(w.socket().messages().filter(m => m.id === prompt).map(m => m.status)).toEqual(['accepted', 'cancelled']);

  const unknown = id();
  w.socket().deliver({ type: 'cancel', id: unknown });
  await settle(() => w.socket().messages().some(m => m.id === unknown));
  expect(w.socket().messages().find(m => m.id === unknown)).toEqual({ type: 'status', id: unknown, status: 'cancelled' });
  await remote.stop();
});

test('a request longer than the web can show is answered only on the device', async () => {
  const w = world();
  const remote = w.start();
  w.preferences.set(`remote-prompts-approvals:${w.account.origin}:acct_1`, true);
  await settle(() => w.socket()?.messages().some(m => m.type === 'hello'));
  const prompt = id();
  w.socket().deliver({ type: 'prompt', id: prompt, chatId: CHAT, text: 'Fix it' });
  await settle(() => remote.tracked.has(prompt));
  const run = w.runs.get('run_1');
  run.state = 'awaiting_permission';
  w.permissions.set('run_1', { id: 'perm_1', tool: 'run_command', request: { argv: ['echo', 'x'.repeat(5000)], summary: 'echo xxx' } });
  await remote.poll();
  const waiting = w.socket().messages().find(m => m.status === 'awaiting_permission');
  expect(waiting.permission).toMatchObject({ id: 'perm_1', complete: false });
  expect(waiting.permission.command.length).toBe(4000);
  w.socket().deliver({ type: 'permission', id: prompt, permissionId: 'perm_1', decision: 'allow_once' });
  await Bun.sleep(20);
  expect(w.resolved).toEqual([]);

  // The same request, short enough to show whole, can be answered.
  w.permissions.set('run_1', { id: 'perm_2', tool: 'run_command', request: { argv: ['echo', 'hi'], summary: 'echo hi' } });
  await remote.poll();
  expect(w.socket().messages().findLast(m => m.status === 'awaiting_permission').permission).toEqual({ id: 'perm_2', tool: 'run_command', summary: 'echo hi', command: 'echo hi', complete: true });
  w.socket().deliver({ type: 'permission', id: prompt, permissionId: 'perm_2', decision: 'allow_once' });
  await settle(() => w.resolved.length);
  expect(w.resolved).toEqual([{ permissionId: 'perm_2', decision: 'allow_once' }]);
  await remote.stop();
});

test('a reply that has not synced is retried before the prompt is reported, and then says so', async () => {
  const w = world();
  const remote = w.start();
  await settle(() => w.socket()?.messages().some(m => m.type === 'hello'));
  const prompt = id();
  w.socket().deliver({ type: 'prompt', id: prompt, chatId: CHAT, text: 'Fix it' });
  await settle(() => remote.tracked.has(prompt));
  w.runs.get('run_1').state = 'completed';
  w.sync.synced = false; w.sync.error = 'Chat sync is offline. It will retry automatically.';
  await remote.poll();
  expect(w.socket().messages().some(m => m.status === 'completed')).toBe(false);
  expect(remote.tracked.get(prompt).retryAt).toBeGreaterThan(Date.now());

  // Synced on a later try: the page gets the answer with the status.
  w.sync.synced = true; remote.tracked.get(prompt).retryAt = 0;
  await remote.poll();
  expect(w.socket().messages().find(m => m.status === 'completed')).toEqual({ type: 'status', id: prompt, status: 'completed', chatId: CHAT });

  // Never synced: reported after the last try, with the reason.
  const other = id();
  w.socket().deliver({ type: 'prompt', id: other, chatId: CHAT, text: 'Again' });
  await settle(() => remote.tracked.has(other));
  w.runs.get(remote.tracked.get(other).runId).state = 'completed';
  w.sync.synced = false;
  for (let i = 0; i < 12; i++) { const entry = remote.tracked.get(other); if (!entry) break; entry.retryAt = 0; await remote.poll(); }
  expect(w.socket().messages().find(m => m.id === other && m.status === 'completed').error).toBe('Finished on the device. The reply has not synced yet: Chat sync is offline. It will retry automatically.');
  await remote.stop();
});

test('prompts stay with the account server they came from', async () => {
  const w = world();
  const remote = w.start();
  await settle(() => w.socket()?.messages().some(m => m.type === 'hello'));
  const prompt = id();
  w.socket().deliver({ type: 'prompt', id: prompt, chatId: CHAT, text: 'Fix it' });
  await settle(() => remote.tracked.has(prompt));
  const first = w.socket();

  w.account.origin = 'https://other.test'; w.account.record = { account: { id: 'acct_2' }, device: { scopes: ['prompts:run'] } }; w.account.credential = 'other';
  remote.refresh();
  await settle(() => w.socket() !== first && w.socket().messages().some(m => m.type === 'hello'));
  expect(remote.tracked.size).toBe(0);
  expect(w.socket().messages().some(m => m.id === prompt)).toBe(false);

  // Back on the first server, the prompt is still followed there.
  w.account.origin = 'https://access.test'; w.account.record = { account: { id: 'acct_1' }, device: { scopes: ['prompts:run'] } }; w.account.credential = 'token';
  remote.refresh();
  expect([...remote.tracked.keys()]).toEqual([prompt]);
  await remote.stop();
});
