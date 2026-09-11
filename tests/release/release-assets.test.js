import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { writeReleaseArchive } from '../../scripts/release-assets.js';
import worker from '../../deploy/website-worker.js';

test('split release assets reconstruct byte-for-byte at the original installer URL', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jolo-parts-'));
  const name = 'jolo-cli-darwin-arm64.tar.gz', bytes = Buffer.from('a release larger than a single asset');
  const sha = createHash('sha256').update(bytes).digest('hex');
  try {
    await writeReleaseArchive(dir, name, bytes, sha, 8);
    const env = { ASSETS: { async fetch(request) {
      try { return new Response(readFileSync(path.join(dir, new URL(request.url).pathname.split('/').at(-1)))); }
      catch { return new Response('missing', { status: 404 }); }
    } } };
    const request = new Request(`https://jolo.example/releases/1.0.0/${name}`);
    const response = await worker.fetch(request, env);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get('etag')).toBe(`"${sha}"`);
    const head = await worker.fetch(new Request(request, { method: 'HEAD' }), env);
    expect(head.headers.get('content-length')).toBe(String(bytes.length));
    expect(await head.text()).toBe('');
    const cached = await worker.fetch(new Request(request, { headers: { 'If-None-Match': `"${sha}"` } }), env);
    expect(cached.status).toBe(304);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
