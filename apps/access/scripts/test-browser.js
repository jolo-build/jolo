// Opt-in graphical check: real Chromium forms, isolated cookies/SQLite, no GitHub calls.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testDatabase } from '../test/database.js';
import { createAccessApp } from '../src/worker.js';
import { createRepository } from '../src/storage.js';
import { signInPage, errorPage } from '../src/pages.js';
import { cookie, hashToken, randomToken, SESSION_SECONDS } from '../src/security.js';

const requireDesktop = createRequire(new URL('../../desktop/package.json', import.meta.url));
const electron = requireDesktop('electron');
const home = mkdtempSync(path.join(tmpdir(), 'jolo-access-browser-'));
const { sqlite, db } = testDatabase();
let time = Date.now(), app, approved, declined, credential;
const submissions = [];
const sessionToken = randomToken();
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const pathname = new URL(request.url).pathname;
  if (pathname === '/styles.css' || pathname === '/theme.js' || /^\/assets\/[a-z0-9.-]+$/.test(pathname)) return new Response(Bun.file(new URL('../public' + pathname, import.meta.url)));
  if (pathname === '/__fixture/session') return new Response(null, { status: 303, headers: { Location: '/__fixture/legacy', 'Set-Cookie': cookie('session', sessionToken, SESSION_SECONDS, false) } });
  if (pathname === '/__fixture/legacy') {
    const response = await app.fetch(new Request(approved.verification_uri_complete, { headers: request.headers }));
    response.headers.set('Referrer-Policy', 'no-referrer');
    return response;
  }
  if (pathname === '/__fixture/approve') return Response.redirect(approved.verification_uri_complete, 303);
  if (pathname === '/__fixture/decline') return Response.redirect(declined.verification_uri_complete, 303);
  if (pathname === '/__fixture/unavailable') return new Response(signInPage({ configured: false }), { headers: { 'Content-Type': 'text/html' } });
  if (pathname === '/__fixture/rate-limited') return new Response(errorPage(429), { status: 429, headers: { 'Content-Type': 'text/html' } });
  const response = await app.fetch(request);
  if (request.method === 'POST') {
    submissions.push({ path: pathname, origin: request.headers.get('origin'), referrer: request.headers.get('referer'), status: response.status });
    if (pathname === '/device/approve' && response.status === 200 && !credential) {
      time += 5000;
      const redeemed = await app.fetch(new Request(origin + '/device/token', { method: 'POST', body: new URLSearchParams({ client_id: 'jolo', device_code: approved.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }) }));
      assert.equal(redeemed.status, 200);
      credential = (await redeemed.json()).access_token;
    }
  }
  return response;
} });
const origin = `http://127.0.0.1:${server.port}`;
let child;
try {
  const repository = createRepository(db, () => time);
  const account = await repository.account({ id: 'browser-fixture', name: 'Browser fixture', email: 'browser@example.com' });
  await repository.saveSession(await hashToken(sessionToken), account.id, randomToken(), time + SESSION_SECONDS * 1000);
  app = createAccessApp({ ACCESS_ORIGIN: origin, ENVIRONMENT: 'development', ACCESS_DB: db, GITHUB_CLIENT_ID: 'fixture', GITHUB_CLIENT_SECRET: 'fixture', RESEND_API_KEY: 're_fixture', MAIL_FROM: 'Jolo <noreply@notifications.jolo.build>' }, { now: () => time, fetch: () => { throw new Error('Browser smoke must not contact GitHub'); }, mailFetch: async () => Response.json({id:'browser-mail-fixture'}) });
  const start = async (scope = 'account:read') => (await app.fetch(new Request(origin + '/device/code', { method: 'POST', body: new URLSearchParams({ client_id: 'jolo', device_name: 'Browser smoke device', scope }) }))).json();
  approved = await start('account:read tasks:read'); declined = await start();
  child = Bun.spawn([electron, fileURLToPath(new URL('browser-forms.mjs', import.meta.url))], { env: { ...process.env, JOLO_ACCESS_TEST_ORIGIN: origin, JOLO_ACCESS_TEST_HOME: home }, stdout: 'pipe', stderr: 'pipe' });
  const diagnostics = new Response(child.stderr).text();
  const code = await child.exited;
  const errors = await diagnostics;
  // Requests contain fixture data only; report headers, never cookies or form bodies.
  assert.equal(code, 0, `Browser forms failed: ${JSON.stringify(submissions)}\n${errors}`);
  assert.deepEqual(submissions.filter(s => ['/device/approve','/devices/revoke','/logout'].includes(s.path)).map(({ path, status }) => ({ path, status })), [
    { path: '/device/approve', status: 403 },
    { path: '/device/approve', status: 200 }, { path: '/device/approve', status: 200 },
    { path: '/devices/revoke', status: 303 }, { path: '/logout', status: 303 },
  ]);
  assert.equal(submissions[0].origin, 'null', 'Reproduce the old no-referrer policy failure');
  assert.equal(submissions[0].referrer, null);
  for (const submission of submissions.slice(1)) {
    assert.equal(submission.origin, origin, 'Native forms must retain their same-origin Origin header');
    assert.equal(submission.referrer, origin + '/', 'Referrers must never include approval codes or callback queries');
  }
  assert.equal(sqlite.query('SELECT state FROM device_flows').get().state, 'denied');
  assert.equal(await repository.getDevice(await hashToken(credential)), null);
  assert.equal(await repository.getSession(await hashToken(sessionToken)), null);
  assert.equal(sqlite.query('SELECT state FROM tasks').get().state, 'in_progress');
  assert.equal(sqlite.query('SELECT count(*) n FROM teams').get().n, 1);
  assert.equal(sqlite.query('SELECT count(*) n FROM task_labels').get().n, 1);
  assert.equal(sqlite.query('SELECT state FROM mail_outbox').get().state, 'sent');
  console.log('Browser task, team, label, archive and restore forms passed. Browser account forms passed: device approval and denial, device revocation, and browser sign-out.');
} finally {
  if (child && child.exitCode === null) { child.kill(); await child.exited; }
  server.stop(true); sqlite.close(); rmSync(home, { recursive: true, force: true });
}
