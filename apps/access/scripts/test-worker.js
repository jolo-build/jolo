import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Exercise the exact workerd runtime shipped with this app's pinned Wrangler.
// Bun's fetch implementation accepts options that workerd may reject.
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare, convertV4MiniflareOptions, Response } = wranglerRequire('miniflare');
const source = new URL('../src/', import.meta.url);
let mode = 'success';
const requests = [];
const runtime = new Miniflare(convertV4MiniflareOptions({
  name: 'jolo-access-runtime-test',
  compatibilityDate: '2026-09-09',
  modulesRoot: fileURLToPath(source),
  modules: [
    {
      type: 'ESModule', path: fileURLToPath(new URL('runtime-test.js', source)),
      contents: `import { authenticate } from './auth.js';
        export default { async fetch() {
          try {
            const identity = await authenticate({ GITHUB_CLIENT_ID: 'fixture-client', GITHUB_CLIENT_SECRET: 'fixture-secret' }, 'https://access.jolo.build', 'fixture-code', 'fixture-verifier');
            return Response.json(identity);
          } catch (error) { return Response.json({ reason: error.reason }, { status: 502 }); }
        } };`,
    },
    ...['auth.js', 'identity.js', 'security.js', 'errors.js'].map(name => ({
      type: 'ESModule', path: fileURLToPath(new URL(name, source)), contents: readFileSync(new URL(name, source), 'utf8'),
    })),
  ],
  outboundService: async request => {
    const url = new URL(request.url);
    requests.push(url.origin + url.pathname);
    if (url.origin === 'https://github.com' && url.pathname === '/login/oauth/access_token') {
      assert.equal(request.method, 'POST');
      const body = new URLSearchParams(await request.text());
      assert.equal(body.get('client_secret'), 'fixture-secret');
      assert.equal(body.get('code_verifier'), 'fixture-verifier');
      if (mode === 'token_redirect') return new Response(null, { status: 302, headers: { Location: 'https://unexpected.example/' } });
      return Response.json({ access_token: 'fixture-access-token', token_type: 'bearer' });
    }
    assert.equal(url.origin, 'https://api.github.com');
    assert.equal(request.headers.get('authorization'), 'Bearer fixture-access-token');
    if (mode === 'identity_redirect') return new Response(null, { status: 302, headers: { Location: 'https://unexpected.example/' } });
    if (url.pathname === '/user') return Response.json({ id: 123, name: 'Fixture account' });
    assert.equal(url.pathname, '/user/emails');
    return Response.json([{ email: 'fixture@example.com', primary: true, verified: true }]);
  },
}));

try {
  const signedIn = await runtime.dispatchFetch('https://access.jolo.build/');
  assert.equal(signedIn.status, 200, 'GitHub exchange must run successfully inside workerd');
  assert.deepEqual(await signedIn.json(), { id: '123', name: 'Fixture account', email: 'fixture@example.com' });
  assert.equal(requests.length, 3);
  mode = 'token_redirect';
  const tokenRedirect = await runtime.dispatchFetch('https://access.jolo.build/');
  assert.deepEqual(await tokenRedirect.json(), { reason: 'github_token_http' });
  mode = 'identity_redirect';
  const identityRedirect = await runtime.dispatchFetch('https://access.jolo.build/');
  assert.deepEqual(await identityRedirect.json(), { reason: 'github_identity_http' });
  assert(!requests.some(url => url.includes('unexpected.example')));
  console.log('Worker runtime checks passed: GitHub exchange, profile lookup, and rejection of upstream redirects.');
} finally {
  await runtime.dispose();
}
