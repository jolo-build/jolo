import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare, convertV4MiniflareOptions, Response } = wranglerRequire('miniflare');
const { build } = wranglerRequire('esbuild');
const bundle = await build({ bundle: true, format: 'esm', platform: 'browser', write: false,
  stdin: { resolveDir: fileURLToPath(new URL('../src/', import.meta.url)), contents: `
    import { authenticateGoogle } from './google-auth.js';
    export default { async fetch() {
      try { return Response.json(await authenticateGoogle({ GOOGLE_CLIENT_ID: 'runtime-client', GOOGLE_CLIENT_SECRET: 'runtime-secret' },
        'https://access.jolo.build', 'runtime-code', { verifier: 'runtime-verifier', nonce: 'runtime-nonce' })); }
      catch (error) { return Response.json({ reason: error.reason }, { status: 502 }); }
    }};` },
});
const pair = await generateKeyPair('RS256');
const key = { ...await exportJWK(pair.publicKey), kid: 'runtime-key', alg: 'RS256', use: 'sig' };
let mode = 'success';
const calls = [];
const runtime = new Miniflare(convertV4MiniflareOptions({
  name: 'google-runtime', compatibilityDate: '2026-09-09', modules: true, script: bundle.outputFiles[0].text,
  outboundService: async request => {
    calls.push(request.url);
    if (request.url === 'https://oauth2.googleapis.com/token') {
      const body = new URLSearchParams(await request.text());
      assert.equal(body.get('client_secret'), 'runtime-secret');
      assert.equal(body.get('code_verifier'), 'runtime-verifier');
      assert.equal(body.get('redirect_uri'), 'https://access.jolo.build/callback/google');
      if (mode === 'redirect') return new Response(null, { status: 302, headers: { Location: 'https://unexpected.example' } });
      const now = Math.floor(Date.now() / 1000);
      const id_token = await new SignJWT({ iss: 'https://accounts.google.com', aud: 'runtime-client', sub: 'google-runtime', iat: now, exp: now + 3600,
        nonce: mode === 'nonce' ? 'wrong' : 'runtime-nonce', email: 'runtime@example.com', email_verified: mode !== 'unverified', name: 'Google runtime' })
        .setProtectedHeader({ alg: 'RS256', kid: 'runtime-key' }).sign(pair.privateKey);
      return Response.json({ id_token });
    }
    assert.equal(request.url, 'https://www.googleapis.com/oauth2/v3/certs');
    return Response.json({ keys: [key] });
  },
}));
try {
  const response = await runtime.dispatchFetch('https://fixture.example');
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), { id: 'google-runtime', email: 'runtime@example.com', name: 'Google runtime' });
  for (const [next, reason] of [['nonce', 'google_id_token'], ['unverified', 'google_email'], ['redirect', 'google_token_http']]) {
    mode = next;
    const rejected = await runtime.dispatchFetch('https://fixture.example');
    assert.equal(rejected.status, 502);
    assert.deepEqual(await rejected.json(), { reason });
  }
  assert(!calls.some(url => url.includes('unexpected.example')));
  console.log('Google workerd checks passed: code exchange, signed identity verification, nonce/email rejection and upstream redirect rejection.');
} finally { await runtime.dispose(); }
