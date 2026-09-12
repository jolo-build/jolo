import { afterEach, expect, test } from 'bun:test';
import { fixture } from '../../apps/access/test/fixture.js';
import { AccountService, accountOrigin } from '../../apps/engine/src/account/service.js';
import { AccountSecretStore } from '../../apps/engine/src/account/secrets.js';
import { createRpcHandlers } from '../../apps/engine/src/rpc/handlers.js';
import { AccountStatusSchema, parseEvent } from '@jolo/protocol';

const services = [];
afterEach(async () => { for (const service of services.splice(0)) await service.stop(); });

/**
 * Build an account service over in-memory preferences and a fake keychain, and return it together
 * with the handles the cases drive. Each option is something a single case varies on its own.
 * @param {{ prefs?: Map<string, any>, keychain?: Map<string, string>, dataDir?: string, origin?: string, failStore?: boolean }} [options]
 */
function setup({ prefs = new Map(), keychain = new Map(), dataDir = '/fixture/profile', origin, failStore = false } = {}) {
  const web = fixture(), events = [], timers = [], lifetime = { count: 0, workStarted() { this.count++; }, workFinished() { this.count--; } };
  const storage = { getPreference: key => prefs.get(key), setPreference: (key, value) => prefs.set(key, value), appendEvent: event => events.push(event) };
  const secrets = new AccountSecretStore({ dataDir, mode: 'keychain', secrets: {
    get: async ({ name }) => keychain.get(name), set: async ({ name, value }) => { if (failStore) throw new Error('locked'); keychain.set(name, value); }, delete: async ({ name }) => keychain.delete(name),
  } });
  const service = new AccountService({ storage, paths: { dataDir, profile: 'test' }, lifetime, secrets, env: { JOLO_ACCOUNT_ORIGIN: origin ?? web.env.ACCESS_ORIGIN }, now: web.now,
    fetchImpl: (url, init) => web.app.fetch(new Request(url, init)), setTimer: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; }, clearTimer: timer => { if (timer) timer.cancelled = true; } });
  services.push(service);
  const approve = async (decision = 'approved') => {
    await web.login();
    const csrf = web.sqlite.query('SELECT csrf FROM sessions').get().csrf;
    const response = await web.send('/device/approve', { method: 'POST', headers: { origin: web.env.ACCESS_ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, user_code: service.snapshot().pending.userCode, decision }) });
    expect(response.status).toBe(200);
  };
  const poll = async (ms = 5000) => { web.advance(ms); await service.poll(service.pending); };
  return { service, web, events, prefs, keychain, secrets, storage, timers, lifetime, approve, poll };
}

test('engine device flow persists only in the scoped secret store; status and events contain no token', async () => {
  const f = setup();
  const initial = await f.service.login({ deviceName: 'My desktop' });
  expect(AccountStatusSchema.safeParse(initial).success).toBe(true);
  expect(initial.state).toBe('pending');
  expect(f.lifetime.count).toBe(1);
  expect(initial).not.toHaveProperty('device_code');
  await f.poll();
  expect(f.service.snapshot().state).toBe('pending');
  await f.approve(); await f.poll();
  const status = await f.service.status();
  expect(status.state).toBe('signed_in');
  expect(status.account.email).toBe('dev@example.com');
  expect(status.device.name).toBe('My desktop');
  expect(status.source).toBe('keychain');
  expect(f.lifetime.count).toBe(0);
  const token = (await f.secrets.get(status.origin)).token;
  expect(JSON.stringify(status)).not.toContain(token);
  expect(JSON.stringify([...f.prefs])).not.toContain(token);
  expect(JSON.stringify(f.events)).not.toContain(token);
  expect(JSON.stringify(f.events)).not.toContain(status.account.email);
  for (const event of f.events) expect(parseEvent({ ...event, engineBootId: 'boot_test', eventSeq: '1', sessionId: null, runId: null, at: new Date().toISOString() }).ok).toBe(true);
  expect(f.web.sqlite.query('SELECT count(*) AS n FROM devices').get().n).toBe(1);
  await f.service.logout();
  expect((await f.service.status()).state).toBe('signed_out');
  expect(f.web.sqlite.query('SELECT count(*) AS n FROM devices').get().n).toBe(0);
  expect(f.keychain.size).toBe(0);
});

test('keychain login restores after engine restart, while profile/server namespaces stay separate', async () => {
  const f = setup(); await f.service.login(); await f.approve(); await f.poll();
  await f.service.stop();
  const restore = new AccountService({ storage: f.storage, paths: { dataDir: '/fixture/profile', profile: 'test' }, secrets: f.secrets, now: f.web.now, fetchImpl: (url, init) => f.web.app.fetch(new Request(url, init)) });
  services.push(restore);
  expect((await restore.status()).state).toBe('signed_in');
  // This store is only ever read, so its double deliberately leaves out `set` and `delete`.
  const other = new AccountSecretStore({ dataDir: '/fixture/other', mode: 'keychain', secrets: /** @type {ConstructorParameters<typeof AccountSecretStore>[0]['secrets']} */ ({ get: async ({ name }) => f.keychain.get(name) }) });
  expect(await other.get(f.web.env.ACCESS_ORIGIN)).toBeNull();
  expect(await f.secrets.get('https://different.example')).toBeNull();
  await restore.logout();
});

test('a locked keychain uses engine memory and never revives an older keychain entry', async () => {
  const f = setup({ failStore: true }); await f.service.login(); await f.approve(); await f.poll();
  expect((await f.service.status()).source).toBe('session');
  expect(f.keychain.size).toBe(0);
  const restored = new AccountService({ storage: f.storage, paths: { dataDir: '/fixture/profile', profile: 'test' }, secrets: f.secrets });
  services.push(restored);
  expect((await restored.status()).state).toBe('signed_out');
  await f.service.logout();
});

test('revocation and expiration clear engine sign-in; network failure preserves a labeled cached account', async () => {
  const f = setup(); await f.service.login(); await f.approve(); await f.poll();
  const liveFetch = f.service.fetch;
  f.service.fetch = async () => { throw new Error('private network data'); };
  let status = await f.service.status({ refresh: true });
  expect(status.state).toBe('signed_in'); expect(status.note).toContain('last verified');
  f.service.fetch = liveFetch;
  f.web.sqlite.exec('DELETE FROM devices');
  status = await f.service.status({ refresh: true });
  expect(status.state).toBe('signed_out'); expect(status.note).toContain('revoked');
  expect(f.keychain.size).toBe(0);
});

test('cancel, denial, and timeout end pending sign-in and release the engine lifetime', async () => {
  const f = setup();
  await f.service.login(); await f.service.cancel();
  expect(f.lifetime.count).toBe(0);
  expect(f.web.sqlite.query('SELECT count(*) AS n FROM device_flows').get().n).toBe(0);
  await f.service.login(); await f.approve('denied'); await f.poll();
  expect(f.service.snapshot().note).toContain('declined');
  await f.service.login(); await f.poll(600_000);
  expect(f.service.snapshot().state).toBe('signed_out'); expect(f.lifetime.count).toBe(0);
});

test('early polling increases the next interval and untrusted verification URLs are rejected', async () => {
  const f = setup(); await f.service.login(); await f.service.poll(f.service.pending);
  expect(f.service.pending.interval).toBe(10);
  await f.service.cancel();
  f.service.fetch = async () => Response.json({ device_code: 'a'.repeat(64), user_code: 'ABCD-EFGH', interval: 5, expires_in: 600, verification_uri: 'https://evil.example/device', verification_uri_complete: 'https://evil.example/device?user_code=ABCD-EFGH' });
  await expect(f.service.login()).rejects.toThrow('could not start');
  expect(f.service.snapshot().state).toBe('signed_out');
  expect(() => accountOrigin('http://example.com')).toThrow();
  expect(() => accountOrigin('https://user:secret@example.com')).toThrow();
  expect(() => accountOrigin('https://example.com/path')).toThrow();
  expect(accountOrigin('http://127.0.0.1:8788')).toBe('http://127.0.0.1:8788');
});

test('account mutation RPCs reject headless and scoped guest clients', async () => {
  const f = setup();
  // Only the account handlers are called here, so the rest of the engine's services stay absent.
  const handlers = createRpcHandlers(/** @type {import('../../apps/engine/src/rpc/handlers.js').RpcDependencies} */ ({ account: f.service }));
  for (const method of ['account.login', 'account.cancel', 'account.logout']) {
    expect(() => handlers[method]({}, { kind: 'headless' })).toThrow();
    expect(() => handlers[method]({}, { kind: 'desktop', capability: {} })).toThrow();
  }
  expect((await handlers['account.status']({}, { kind: 'headless' })).state).toBe('signed_out');
});

test('failed remote sign-out still clears local metadata and does not restore a stale secret', async () => {
  const f = setup(); await f.service.login(); await f.approve(); await f.poll();
  f.service.fetch = async () => { throw new Error('offline'); };
  f.secrets.clear = async () => {}; // Simulate a keyring that is locked during deletion.
  const status = await f.service.logout();
  expect(status.state).toBe('signed_out'); expect(status.note).toContain('Signed out locally');
  const next = new AccountService({ storage: f.storage, paths: { dataDir: '/fixture/profile', profile: 'test' }, secrets: f.secrets });
  services.push(next);
  expect((await next.status()).state).toBe('signed_out');
});

test('cancelling an in-flight token response revokes the late credential without affecting a new login', async () => {
  const f = setup(); await f.service.login(); await f.approve();
  const liveFetch = f.service.fetch;
  /** @type {(value?: any) => void} */
  let release, received;
  const paused = new Promise(resolve => { release = resolve; });
  const issued = new Promise(resolve => { received = resolve; });
  f.service.fetch = async (url, init) => {
    const response = await liveFetch(url, init);
    if (url.endsWith('/device/token')) { received(); await paused; }
    return response;
  };
  const oldPoll = f.poll();
  await issued;
  expect(f.web.sqlite.query('SELECT count(*) AS n FROM devices').get().n).toBe(1);
  await f.service.cancel();
  const next = await f.service.login({ deviceName: 'New request' });
  release(); await oldPoll;
  expect(f.service.snapshot().pending.userCode).toBe(next.pending.userCode);
  expect(f.web.sqlite.query('SELECT count(*) AS n FROM devices').get().n).toBe(0);
  expect(f.keychain.size).toBe(0);
  expect(f.lifetime.count).toBe(1);
  await f.service.cancel();
});

test('a credential with unexpected scope is rejected and revoked', async () => {
  const f = setup(); await f.service.login(); await f.approve();
  const liveFetch = f.service.fetch;
  f.service.fetch = async (url, init) => {
    const response = await liveFetch(url, init);
    return url.endsWith('/device/token') ? Response.json({ ...await response.json(), scope: 'engine:owner' }) : response;
  };
  await f.poll();
  expect(f.service.snapshot().state).toBe('signed_out');
  expect(f.web.sqlite.query('SELECT count(*) AS n FROM devices').get().n).toBe(0);
  expect(f.keychain.size).toBe(0);
});

test('task access requires reapproval, cancellation keeps the old sign-in, and success replaces its credential', async () => {
  const f=setup(); await f.service.login(); await f.approve(); await f.poll();
  const original=(await f.secrets.get(f.service.origin)).token;
  await expect(f.service.taskRequest('/api/tasks')).rejects.toThrow('task access');
  await f.service.login({tasks:true}); await f.service.cancel();
  expect(f.service.snapshot().state).toBe('signed_in');
  expect((await f.secrets.get(f.service.origin)).token).toBe(original);
  await f.service.login({tasks:true}); await f.approve(); await f.poll();
  expect(f.service.snapshot().device.scopes).toEqual(['account:read','tasks:read']);
  expect((await f.service.taskRequest('/api/tasks')).value.tasks).toEqual([]);
  expect((await f.secrets.get(f.service.origin)).token).not.toBe(original);
  expect(f.web.sqlite.query('SELECT count(*) n FROM devices').get().n).toBe(1);
});

test('sign-out during task fetch discards the response before it reaches an agent',async()=>{
  const f=setup(); await f.service.login({tasks:true}); await f.approve(); await f.poll();
  const live=f.service.fetch;
  /** @type {(value?: any) => void} */ let release,received;
  const gate=new Promise(r=>{release=r;}), ready=new Promise(r=>{received=r;});
  f.service.fetch=async(url,init)=>{const response=await live(url,init); if(url.endsWith('/api/tasks')) {received();await gate;} return response;};
  const request=f.service.taskRequest('/api/tasks').catch(error=>error);
  await ready; await f.service.logout(); release();
  expect((await request).message).toContain('connection changed');
});

test('chat sync scope requires browser approval and preserves existing task access on upgrade', async () => {
  const f = setup();
  await f.service.login({ tasks: true }); await f.approve(); await f.poll();
  const pending = await f.service.login({ chats: true });
  expect(pending.state).toBe('pending');
  expect(pending.device.scopes).not.toContain('chats:sync');
  const page = await f.web.send(`/device?user_code=${pending.pending.userCode}`);
  expect(await page.text()).toContain('Chat sync: upload conversation text');
  await f.approve(); await f.poll();
  expect((await f.service.status()).device.scopes).toEqual(['account:read', 'tasks:read', 'chats:sync']);
});
