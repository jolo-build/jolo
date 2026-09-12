// Exercise the production build in real Chromium without external services.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const requireDesktop = createRequire(new URL('../../desktop/package.json', import.meta.url));
const electron = requireDesktop('electron');
const home = mkdtempSync(path.join(tmpdir(), 'jolo-website-loading-'));
const dist = new URL('../dist/', import.meta.url);
const headers = await Bun.file(new URL('_headers', dist)).text();
const csp = headers.match(/Content-Security-Policy: (.+)/)?.[1];
assert(csp, 'The production security policy must be present');
let releaseVersion = '1.2.3';
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const pathname = new URL(request.url).pathname;
  if (pathname === '/test/publish-release') { releaseVersion = '1.2.4'; return new Response('ok'); }
  if (pathname === '/releases/latest.txt') return new Response(releaseVersion);
  if (pathname === '/releases/desktop.json') return Response.json({ version: releaseVersion, downloads: ['arm64', 'x64'].map(arch => ({ arch, url: `/releases/${releaseVersion}/jolo-desktop-darwin-${arch}.dmg`, checksum: `/releases/${releaseVersion}/jolo-desktop-darwin-${arch}.dmg.sha256` })) });
  const file = Bun.file(new URL(pathname === '/' ? 'index.html' : pathname.slice(1), dist));
  return await file.exists() ? new Response(file, { headers: { 'Content-Security-Policy': csp } }) : new Response('Not found', { status: 404 });
} });
let child;
try {
  child = Bun.spawn([electron, fileURLToPath(new URL('browser-loading.js', import.meta.url))], {
    env: { ...process.env, JOLO_WEBSITE_TEST_ORIGIN: `http://127.0.0.1:${server.port}`, JOLO_WEBSITE_TEST_HOME: home },
    stdout: 'inherit', stderr: 'pipe',
  });
  const diagnostics = new Response(child.stderr).text();
  const code = await child.exited;
  assert.equal(code, 0, `Website loading checks failed:\n${await diagnostics}`);
} finally {
  if (child && child.exitCode === null) { child.kill(); await child.exited; }
  server.stop(true);
  rmSync(home, { recursive: true, force: true });
}
