import { expect, test } from 'bun:test';
import worker, { createAccessApp } from '../src/worker.js';
import { FLOW_SECONDS, SESSION_SECONDS, configuration, hashToken } from '../src/security.js';
import { createRepository } from '../src/storage.js';

const ORIGIN = 'https://access.jolo.build';
import { fixture } from './fixture.js';

test('sign-in uses GitHub code flow with PKCE and a fixed callback; the session contains no provider credential', async () => {
  const f = fixture();
  const start = await f.begin();
  expect(start.origin + start.pathname).toBe('https://github.com/login/oauth/authorize');
  expect(start.searchParams.get('scope')).toBe('read:user user:email');
  expect(start.searchParams.get('code_challenge_method')).toBe('S256');
  expect(start.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/callback`);
  const response = await f.send(f.callback());
  expect(response.headers.get('location')).toBe('/welcome');
  const sessionCookie = response.headers.getSetCookie().find(value => value.startsWith('__Host-jolo_session='));
  expect(sessionCookie).toContain('HttpOnly; SameSite=Lax');
  expect(sessionCookie).toContain('; Secure');
  expect(sessionCookie).not.toContain('Domain=');
  const token = f.cookies.get('__Host-jolo_session');
  expect(f.sqlite.query('SELECT token_hash FROM sessions').get().token_hash).toBe(await hashToken(token));
  expect(f.sqlite.query('SELECT count(*) AS n FROM login_flows').get().n).toBe(0);
  const api = await f.send('/api/session');
  // Response.json() is generic on Workers, so name the body the session route sends back.
  expect(/** @type {{ account: { id: string, email: string, name: string } }} */ (await api.json()))
    .toEqual({ account: { id: expect.any(String), email: 'dev@example.com', name: 'Jolo Developer' } });
  const page = await f.send('/account');
  const body = await page.text();
  expect(body).toContain('dev@example.com');
  expect(body).not.toContain('fixture-github-token');
  expect(body).not.toContain(token);
  expect(page.headers.get('cache-control')).toBe('no-store');
  expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  expect((await f.send('/')).headers.get('location')).toBe('/account');
});

test('callbacks require the initiating browser and exact state', async () => {
  const f = fixture();
  await f.begin();
  const missing = await f.send(f.callback(), { headers: { cookie: '' } });
  expect(missing.headers.get('location')).toBe('/?error=signin');
  expect(f.calls).toHaveLength(0);
  await f.begin();
  const mismatch = await f.send('/callback?code=fixture-code&state=wrong');
  expect(mismatch.headers.get('location')).toBe('/?error=signin');
  expect(f.calls).toHaveLength(0);
});

test.each(['state', 'code'])('duplicate %s callback parameters are rejected', async parameter => {
  const f = fixture();
  await f.begin();
  expect((await f.send(`${f.callback()}&${parameter}=extra`)).headers.get('location')).toBe('/?error=signin');
  expect(f.calls).toHaveLength(0);
});

test('a flow can be consumed only once, including simultaneous callbacks', async () => {
  const f = fixture();
  await f.begin();
  const cookie = `__Host-jolo_flow=${f.cookies.get('__Host-jolo_flow')}`;
  const request = () => new Request(`${ORIGIN}${f.callback()}`, { headers: { cookie } });
  const responses = await Promise.all([f.app.fetch(request()), f.app.fetch(request())]);
  expect(responses.map(r => r.headers.get('location')).sort()).toEqual(['/?error=signin', '/welcome']);
  expect(f.calls.filter(call => call.url.includes('access_token'))).toHaveLength(1);
  expect((await f.app.fetch(request())).headers.get('location')).toBe('/?error=signin');
});

test('expired flows and sessions are rejected and cleaned up', async () => {
  const f = fixture();
  await f.begin();
  f.advance(FLOW_SECONDS * 1000);
  expect((await f.send(f.callback())).headers.get('location')).toBe('/?error=signin');
  expect(f.calls).toHaveLength(0);
  await f.login();
  f.advance(SESSION_SECONDS * 1000);
  expect((await f.send('/api/session')).status).toBe(401);
  await createRepository(f.db, () => Date.now() + 2 * SESSION_SECONDS * 1000).cleanup();
  expect(f.sqlite.query('SELECT count(*) AS n FROM sessions').get().n).toBe(0);
});

test('logout requires POST, exact origin, and the session CSRF token; revocation is immediate', async () => {
  const f = fixture();
  await f.login();
  const token = f.cookies.get('__Host-jolo_session');
  const csrf = f.sqlite.query('SELECT csrf FROM sessions').get().csrf;
  const post = (origin, value) => f.send('/logout', { method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf: value }) });
  expect((await f.send('/logout')).status).toBe(404);
  expect((await post('https://jolo.build', csrf)).status).toBe(403);
  expect((await post(ORIGIN, 'invalid')).status).toBe(403);
  expect((await post(ORIGIN, 'x'.repeat(5000))).status).toBe(403);
  expect((await f.send('/api/session')).status).toBe(200);
  expect((await post(ORIGIN, csrf)).headers.get('location')).toBe('/');
  expect(f.cookies.has('__Host-jolo_session')).toBe(false);
  expect((await f.send('/api/session', { headers: { cookie: `__Host-jolo_session=${token}` } })).status).toBe(401);
});

test('a second login replaces this browser session and preserves the immutable account ID', async () => {
  const f = fixture();
  await f.login();
  const oldToken = f.cookies.get('__Host-jolo_session');
  const before = await (await f.send('/api/session')).json();
  f.identity.name = 'Updated name';
  await f.login();
  const after = await (await f.send('/api/session')).json();
  expect(after.account.id).toBe(before.account.id);
  expect(after.account.name).toBe('Updated name');
  expect((await f.send('/api/session', { headers: { cookie: `__Host-jolo_session=${oldToken}` } })).status).toBe(401);
  f.identity.id = 67890;
  await f.login();
  expect((await (await f.send('/api/session')).json()).account.id).not.toBe(before.account.id);
});

test('verified primary email is required and profile HTML is escaped', async () => {
  const f = fixture();
  f.emails[0].verified = false;
  expect((await f.login()).headers.get('location')).toBe('/?error=email');
  expect(f.sqlite.query('SELECT count(*) AS n FROM accounts').get().n).toBe(0);
  f.emails[0].verified = true;
  f.identity.name = '<script>alert(1)</script>';
  await f.login();
  const page = await (await f.send('/account')).text();
  expect(page).toContain('&lt;script&gt;');
  expect(page).not.toContain('<script>');
});

test('upstream failures do not expose their response or issue a session', async () => {
  const f = fixture();
  await f.begin();
  const app = createAccessApp(f.env, { fetch: async () => Response.json({ error: 'secret-error', error_description: 'private upstream data' }) });
  const response = await app.fetch(new Request(`${ORIGIN}${f.callback()}`, { headers: { cookie: `__Host-jolo_flow=${f.cookies.get('__Host-jolo_flow')}` } }));
  expect(response.headers.get('location')).toBe('/?error=signin');
  expect(await response.text()).not.toContain('private upstream data');
  expect(f.sqlite.query('SELECT count(*) AS n FROM sessions').get().n).toBe(0);
});

test('forwarded headers and return URLs cannot override the configured origin', async () => {
  const f = fixture();
  const response = await f.send('/login?redirect_uri=https://evil.example&returnTo=https://evil.example', { headers: { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'http', forwarded: 'host=evil.example;proto=http' } });
  expect(new URL(response.headers.get('location')).searchParams.get('redirect_uri')).toBe(`${ORIGIN}/callback`);
  expect((await f.app.fetch(new Request('https://evil.example/login'))).status).toBe(421);
  expect((await f.send('/token', { method: 'POST' })).status).toBe(404);
});

test('duplicate session cookies are rejected and signed-out routes are protected', async () => {
  const f = fixture();
  expect((await f.send('/account')).headers.get('location')).toBe('/');
  expect((await f.send('/api/session')).status).toBe(401);
  await f.login();
  const cookie = `__Host-jolo_session=${f.cookies.get('__Host-jolo_session')}`;
  expect((await f.send('/api/session', { headers: { cookie: `${cookie}; ${cookie}` } })).status).toBe(401);
});

test('missing configuration fails closed while rendering a useful landing page', async () => {
  const f = fixture({ GITHUB_CLIENT_SECRET: '' });
  expect(await (await f.send('/')).text()).toContain('Sign-in is not available yet');
  expect((await f.send('/login')).status).toBe(503);
  expect((await f.send('/health')).status).toBe(503);
  expect(f.calls).toHaveLength(0);
  expect((await worker.fetch(new Request(ORIGIN), {})).status).toBe(503);
  expect(() => configuration({ ACCESS_ORIGIN: 'http://access.jolo.build', ENVIRONMENT: 'production' })).toThrow();
});

test('local development uses host-only cookies without requiring HTTPS', async () => {
  const f = fixture({ ACCESS_ORIGIN: 'http://127.0.0.1:8788', ENVIRONMENT: 'development' });
  const response = await f.send('/login');
  expect(response.headers.getSetCookie()[0]).toStartWith('jolo_flow=');
  expect(response.headers.getSetCookie()[0]).not.toContain('Secure');
  expect(response.headers.has('strict-transport-security')).toBe(false);
});

test('rate-limited requests do not write a flow or call the provider', async () => {
  const f = fixture({ ACCESS_RATE_LIMIT: { limit: async () => ({ success: false }) } });
  const response = await f.send('/login');
  expect(response.status).toBe(429);
  expect(response.headers.get('retry-after')).toBe('60');
  expect(f.sqlite.query('SELECT count(*) AS n FROM login_flows').get().n).toBe(0);
  expect(f.calls).toHaveLength(0);
});

test('health checks the database and scheduled cleanup removes expired records', async () => {
  const f = fixture();
  expect((await f.send('/health')).status).toBe(200);
  await f.login();
  f.sqlite.exec('UPDATE sessions SET expires_at = 0');
  await worker.scheduled({}, f.env);
  expect(f.sqlite.query('SELECT count(*) AS n FROM sessions').get().n).toBe(0);
  f.sqlite.exec('DROP TABLE accounts');
  expect((await f.send('/health')).status).toBe(503);
});
