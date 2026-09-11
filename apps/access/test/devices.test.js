import { expect, test } from 'bun:test';
import { fixture } from './fixture.js';
import { hashToken } from '../src/security.js';

const formPost = (f, path, body, headers = {}) => f.send(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(body) });
const begin = async f => (await formPost(f, '/device/code', { client_id: 'jolo', device_name: 'My laptop' })).json();
const poll = (f, flow) => formPost(f, '/device/token', { client_id: 'jolo', device_code: flow.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
const approve = (f, flow, decision = 'approved') => formPost(f, '/device/approve', { user_code: flow.user_code, decision, csrf: f.sqlite.query('SELECT csrf FROM sessions').get().csrf }, { origin: f.env.ACCESS_ORIGIN });

test('device approval connects a bearer credential with no access to browser sessions', async () => {
  const f = fixture(), flow = await begin(f);
  expect(flow.user_code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  expect(f.sqlite.query('SELECT token_hash FROM device_flows').get().token_hash).toBe(await hashToken(flow.device_code));
  f.advance(5000);
  expect(await (await poll(f, flow)).json()).toEqual({ error: 'authorization_pending' });
  await f.login();
  const page = await (await f.send(`/device?user_code=${flow.user_code}`)).text();
  expect(page).toContain(flow.user_code);
  expect(page).toContain('Only approve a sign-in you started');
  expect(page).toContain('My laptop');
  expect(page).not.toContain(flow.device_code);
  expect((await approve(f, flow)).status).toBe(200);
  f.advance(5000);
  const result = await (await poll(f, flow)).json();
  expect(result.scope).toBe('account:read');
  expect(f.sqlite.query('SELECT token_hash FROM devices').get().token_hash).toBe(await hashToken(result.access_token));
  const headers = { authorization: `Bearer ${result.access_token}`, cookie: '' };
  const session = await (await f.send('/api/device/session', { headers })).json();
  expect(session.account.email).toBe('dev@example.com');
  expect(session.device.name).toBe('My laptop');
  expect(JSON.stringify(session)).not.toContain(result.access_token);
  expect((await f.send('/api/session', { headers })).status).toBe(401);
  expect(await (await poll(f, flow)).json()).toEqual({ error: 'expired_token' });
  expect((await f.send('/api/device/logout', { method: 'POST', headers })).status).toBe(204);
  expect((await f.send('/api/device/session', { headers })).status).toBe(401);
});

test('device intent survives GitHub login without an arbitrary redirect', async () => {
  const f = fixture(), flow = await begin(f);
  const page = await f.send(`/device?user_code=${flow.user_code}`);
  expect(page.headers.get('location')).toBe(`/?user_code=${flow.user_code}`);
  await f.begin(`/login?user_code=${flow.user_code}`);
  expect((await f.send(f.callback())).headers.get('location')).toBe(`/device?user_code=${flow.user_code}`);
  await f.send('/login?user_code='+flow.user_code+'&return_to=https://evil.example');
  expect(f.sqlite.query('SELECT return_to FROM login_flows').get().return_to).toBe(`/device?user_code=${flow.user_code}`);
});

test('approval requires the signed-in browser, exact origin, and CSRF token', async () => {
  const f = fixture(), flow = await begin(f);
  expect((await formPost(f, '/device/approve', { user_code: flow.user_code, decision: 'approved', csrf: 'wrong' }, { origin: f.env.ACCESS_ORIGIN })).status).toBe(403);
  await f.login();
  const csrf = f.sqlite.query('SELECT csrf FROM sessions').get().csrf;
  expect((await formPost(f, '/device/approve', { user_code: flow.user_code, decision: 'approved', csrf }, { origin: 'https://evil.example' })).status).toBe(403);
  expect((await formPost(f, '/device/approve', { user_code: flow.user_code, decision: 'approved', csrf }, { origin: 'null' })).status).toBe(403);
  expect((await formPost(f, '/device/approve', { user_code: flow.user_code, decision: 'approved', csrf })).status).toBe(403);
  expect((await formPost(f, '/device/approve', { user_code: flow.user_code, decision: 'approved', csrf: 'wrong' }, { origin: f.env.ACCESS_ORIGIN })).status).toBe(403);
  expect(f.sqlite.query('SELECT state FROM device_flows').get().state).toBe('pending');
});

test('denial, cancellation, expiry, and fast polling cannot issue credentials', async () => {
  const f = fixture(), flow = await begin(f);
  expect(await (await poll(f, flow)).json()).toEqual({ error: 'slow_down', interval: 10 });
  f.advance(5000);
  expect(await (await poll(f, flow)).json()).toEqual({ error: 'slow_down', interval: 15 });
  await f.login();
  await approve(f, flow, 'denied');
  f.advance(15_000);
  expect(await (await poll(f, flow)).json()).toEqual({ error: 'access_denied' });
  const cancelled = await begin(f);
  await formPost(f, '/device/cancel', { client_id: 'jolo', device_code: cancelled.device_code });
  expect(await (await poll(f, cancelled)).json()).toEqual({ error: 'expired_token' });
  const expired = await begin(f);
  f.advance(600_000);
  expect(await (await poll(f, expired)).json()).toEqual({ error: 'expired_token' });
  expect(f.sqlite.query('SELECT count(*) AS n FROM devices').get().n).toBe(0);
});

test('concurrent redemption issues only one credential and browser revocation takes effect immediately', async () => {
  const f = fixture(), flow = await begin(f);
  await f.login(); await approve(f, flow); f.advance(5000);
  const results = await Promise.all([poll(f, flow), poll(f, flow)]);
  const bodies = await Promise.all(results.map(r => r.json()));
  const issued = bodies.filter(body => body.access_token);
  expect(issued).toHaveLength(1);
  const device = f.sqlite.query('SELECT id, account_id FROM devices').get();
  expect(await (await f.send('/devices')).text()).toContain('My laptop');
  // Another account cannot revoke a device merely by knowing its ID.
  f.identity.id = 67890; await f.login();
  const otherCSRF = f.sqlite.query('SELECT csrf FROM sessions ORDER BY created_at DESC').get().csrf;
  await formPost(f, '/devices/revoke', { device_id: device.id, csrf: otherCSRF }, { origin: f.env.ACCESS_ORIGIN });
  expect(f.sqlite.query('SELECT count(*) AS n FROM devices').get().n).toBe(1);
  f.identity.id = 12345; await f.login();
  const ownCSRF = f.sqlite.query('SELECT csrf FROM sessions').get().csrf;
  await formPost(f, '/devices/revoke', { device_id: device.id, csrf: ownCSRF }, { origin: f.env.ACCESS_ORIGIN });
  expect((await f.send('/api/device/session', { headers: { authorization: `Bearer ${issued[0].access_token}` } })).status).toBe(401);
});
