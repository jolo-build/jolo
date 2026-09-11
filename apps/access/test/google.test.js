import { expect, test } from 'bun:test';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { fixture } from './fixture.js';
import { createRepository } from '../src/storage.js';
import { FLOW_SECONDS } from '../src/security.js';

const pair = await generateKeyPair('RS256');
const otherPair = await generateKeyPair('RS256');
const publicKey = { ...await exportJWK(pair.publicKey), kid: 'fixture-key', alg: 'RS256', use: 'sig' };

function googleFixture(overrides = {}) {
  let authorization;
  const claims = {}, calls = [], control = {};
  const f = fixture({ GOOGLE_CLIENT_ID: 'google-client', GOOGLE_CLIENT_SECRET: 'google-secret', ...overrides }, {
    fetch: async (url, init) => {
      url = String(url); calls.push(url);
      expect(init.redirect).toBe('manual');
      if (url === 'https://oauth2.googleapis.com/token') {
        const form = new URLSearchParams(init.body);
        expect(form.get('client_id')).toBe('google-client');
        expect(form.get('client_secret')).toBe('google-secret');
        expect(form.get('grant_type')).toBe('authorization_code');
        expect(form.get('redirect_uri')).toBe(`${f.env.ACCESS_ORIGIN}/callback/google`);
        expect(Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(form.get('code_verifier')))).toString('base64url')).toBe(authorization.searchParams.get('code_challenge'));
        if (control.mode === 'token_redirect') return new Response(null, { status: 302, headers: { Location: 'https://evil.example' } });
        if (control.mode === 'token_invalid') return Response.json({ id_token: 'not-a-jwt', access_token: 'secret-token' });
        const now = Math.floor(f.now() / 1000);
        const id_token = await new SignJWT({ iss: 'https://accounts.google.com', aud: 'google-client', sub: '12345', iat: now, exp: now + 3600,
          nonce: authorization.searchParams.get('nonce'), email: 'dev@example.com', email_verified: true, name: 'Google Developer', ...claims })
          .setProtectedHeader({ alg: 'RS256', kid: control.mode === 'unknown_key' ? 'other-key' : 'fixture-key' })
          .sign(control.mode === 'bad_signature' ? otherPair.privateKey : pair.privateKey);
        return Response.json({ id_token, access_token: 'secret-google-token', token_type: 'Bearer' });
      }
      expect(url).toBe('https://www.googleapis.com/oauth2/v3/certs');
      if (control.mode === 'keys_redirect') return new Response(null, { status: 302, headers: { Location: 'https://evil.example' } });
      return Response.json({ keys: [publicKey] });
    },
  });
  const begin = async (suffix = '') => (authorization = await f.begin('/login/google' + suffix));
  const callback = () => `/callback/google?code=google-code&state=${authorization.searchParams.get('state')}`;
  const login = async () => { await begin(); return f.send(callback()); };
  return { ...f, begin, callback, login, claims, calls, control };
}

test('Google uses code + PKCE + nonce, creates a session, and records the provider', async () => {
  const f = googleFixture();
  const url = await f.begin();
  expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
  expect(url.searchParams.get('scope')).toBe('openid email profile');
  expect(url.searchParams.get('response_type')).toBe('code');
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(url.searchParams.get('nonce')).toMatch(/^[a-f0-9]{64}$/);
  expect(url.searchParams.get('redirect_uri')).toBe(`${f.env.ACCESS_ORIGIN}/callback/google`);
  const response = await f.send(f.callback());
  expect(response.headers.get('location')).toBe('/account');
  expect(f.cookies.has('__Host-jolo_session')).toBe(true);
  expect(f.cookies.has('__Host-jolo_flow')).toBe(false);
  const account = (await (await f.send('/api/session')).json()).account;
  expect(account.email).toBe('dev@example.com');
  expect(await (await f.send('/account')).text()).toContain('<dd>Google</dd>');
  expect(f.sqlite.query('SELECT provider, provider_key FROM accounts').get()).toEqual({ provider: 'google', provider_key: 'google:12345' });
  expect(JSON.stringify(f.sqlite.query('SELECT * FROM sessions').all())).not.toContain('secret-google-token');
  f.claims.email = 'updated@example.com';
  await f.login();
  expect((await (await f.send('/api/session')).json()).account).toMatchObject({ id: account.id, email: 'updated@example.com' });
});

test('matching Google and GitHub email addresses and subject IDs never merge accounts', async () => {
  const f = googleFixture();
  const github = await createRepository(f.db).account({ id: '12345', email: 'dev@example.com', name: 'GitHub user' });
  await f.login();
  expect((await (await f.send('/api/session')).json()).account.id).not.toBe(github.id);
  expect(f.sqlite.query('SELECT count(*) AS n FROM accounts').get().n).toBe(2);
});

test('Google can be the only provider, and device sign-in retains the approval code', async () => {
  const f = googleFixture({ GITHUB_CLIENT_ID: '', GITHUB_CLIENT_SECRET: '' });
  expect((await f.send('/health')).status).toBe(200);
  const page = await (await f.send('/?user_code=ABCD-EFGH')).text();
  expect(page).toContain('href="/login/google?user_code=ABCD-EFGH"');
  expect(page).not.toContain('Continue with GitHub');
  expect((await f.send('/login')).status).toBe(503);
  await f.begin('?user_code=ABCD-EFGH&return_to=https://evil.example');
  expect((await f.send(f.callback())).headers.get('location')).toBe('/device?user_code=ABCD-EFGH');
  expect((await fixture().send('/login/google')).status).toBe(503);
});

test('a Google browser session approves a scoped device credential and signs out normally', async () => {
  const f = googleFixture();
  const post = (path, values, authenticated = false) => f.send(path, { method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(authenticated ? { origin: f.env.ACCESS_ORIGIN } : {}) }, body: new URLSearchParams(values) });
  const flow = await (await post('/device/code', { client_id: 'jolo', device_name: 'Google laptop', scope: 'account:read tasks:read' })).json();
  const signin = (await f.send(`/device?user_code=${flow.user_code}`)).headers.get('location');
  expect(await (await f.send(signin)).text()).toContain(`/login/google?user_code=${flow.user_code}`);
  await f.begin(`?user_code=${flow.user_code}`);
  const callback = await f.send(f.callback());
  expect(await (await f.send(callback.headers.get('location'))).text()).toContain('Google laptop');
  const { csrf } = f.sqlite.query('SELECT csrf FROM sessions').get();
  expect((await post('/device/approve', { csrf, user_code: flow.user_code, decision: 'approved' }, true)).status).toBe(200);
  f.advance(5000);
  const token = await (await post('/device/token', { client_id: 'jolo', device_code: flow.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' })).json();
  expect(token.scope).toBe('account:read tasks:read');
  const headers = { authorization: `Bearer ${token.access_token}`, cookie: '' };
  expect((await (await f.send('/api/device/session', { headers })).json()).account.email).toBe('dev@example.com');
  expect((await post('/logout', { csrf }, true)).status).toBe(303);
  expect((await f.send('/api/session')).status).toBe(401);
  expect((await f.send('/api/device/session', { headers })).status).toBe(200);
});

test('state mismatch, expiry, denial, duplicate parameters, missing cookie and provider mix-ups never exchange a code', async () => {
  for (const mode of ['state', 'expiry', 'denied', 'duplicate', 'cookie', 'provider']) {
    const f = googleFixture(); await f.begin();
    let callback = f.callback();
    if (mode === 'state') callback = '/callback/google?code=x&state=wrong';
    if (mode === 'expiry') f.advance((FLOW_SECONDS + 1) * 1000);
    if (mode === 'denied') callback += '&error=access_denied';
    if (mode === 'duplicate') callback += '&code=second-code';
    if (mode === 'cookie') f.cookies.clear();
    if (mode === 'provider') callback = callback.replace('/callback/google', '/callback');
    expect((await f.send(callback)).headers.get('location')).toBe('/?error=signin');
    expect(f.calls).toHaveLength(0);
    expect(f.sqlite.query('SELECT count(*) AS n FROM sessions').get().n).toBe(0);
  }
  const f = googleFixture(); await f.begin();
  const callback = f.callback(), cookie = `__Host-jolo_flow=${f.cookies.get('__Host-jolo_flow')}`;
  await f.send(callback);
  const count = f.calls.length;
  expect((await f.send(callback, { headers: { cookie } })).headers.get('location')).toBe('/?error=signin');
  expect(f.calls.length).toBe(count);
});

test('Google rejects invalid signature, issuer, audience, time, nonce and unverified email', async () => {
  for (const claims of [{ iss: 'https://evil.example' }, { aud: 'other-client' }, { exp: 1 }, { iat: 9999999999 },
    { nonce: 'wrong' }, { nonce: undefined }, { email_verified: false }, { email_verified: 'true' }, { sub: '' },
    { email: 'bad' }, { azp: 'other-client' }, { aud: ['google-client', 'other-client'] }]) {
    const f = googleFixture(); Object.assign(f.claims, claims);
    expect((await f.login()).headers.get('location')).toMatch(/^\/\?error=(signin|email)$/);
    expect(f.sqlite.query('SELECT count(*) AS n FROM accounts').get().n).toBe(0);
    expect(f.sqlite.query('SELECT count(*) AS n FROM sessions').get().n).toBe(0);
  }
  for (const mode of ['bad_signature', 'unknown_key', 'token_invalid', 'token_redirect', 'keys_redirect']) {
    const f = googleFixture(); f.control.mode = mode;
    const response = await f.login();
    expect(response.headers.get('location')).toBe('/?error=signin');
    expect(await response.text()).not.toContain('secret');
    expect(f.sqlite.query('SELECT count(*) AS n FROM accounts').get().n).toBe(0);
  }
});

test('Google endpoints are rate limited and incomplete Google configuration stays hidden', async () => {
  const f = googleFixture({ ACCESS_RATE_LIMIT: { limit: async () => ({ success: false }) } });
  expect((await f.send('/login/google')).status).toBe(429);
  expect((await f.send('/callback/google?code=x&state=x')).status).toBe(429);
  expect(f.calls).toHaveLength(0);
  const missing = googleFixture({ GOOGLE_CLIENT_SECRET: '' });
  expect(await (await missing.send('/')).text()).not.toContain('Continue with Google');
  expect((await missing.send('/login/google')).status).toBe(503);
});
