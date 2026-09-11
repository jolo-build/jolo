import { expect, test } from 'bun:test';
import { createVisualizationStore, readVisualization, MAX_VISUALIZATION_BYTES } from '../src/main/visualization-host.js';

function fixture(text = '<h1>Preview</h1>') {
  const bytes = Buffer.from(text), reads = [];
  const call = async (method, params) => {
    if (method === 'session.page') return { session: { projectId: 'project', workspaceId: 'workspace' } };
    if (method === 'workspace.list') return { workspaces: [{ id: 'other', path: '/other', present: true }, { id: 'workspace', path: '/workspace', present: true }] };
    if (method !== 'workspace.readFile') throw new Error('unexpected method');
    reads.push(params);
    if (params.path === 'denied.html') throw new Error('read permission denied');
    const chunk = bytes.subarray(params.offset, params.offset + params.maxBytes);
    return { text: chunk.toString('base64'), bytes: chunk.length, truncated: params.offset + chunk.length < bytes.length };
  };
  return { call, reads };
}
const request = { sessionId: 'session', path: '/workspace/preview.html' };
test('previews read only from the session workspace and preserve UTF-8 across bounded chunks', async () => {
  const text = `<div>${'🌍'.repeat(90_000)}</div>`, { call, reads } = fixture(text);
  expect(await readVisualization(call, request)).toBe(text);
  expect(reads.length).toBeGreaterThan(1);
  expect(reads.every(item => item.workspaceId === 'workspace' && item.path === 'preview.html' && item.maxBytes <= 65536)).toBe(true);
  await expect(readVisualization(call, { ...request, path: '/other/preview.html' })).rejects.toThrow('outside');
  await expect(readVisualization(call, { ...request, path: '../preview.html' })).rejects.toThrow('outside');
  await expect(readVisualization(call, { ...request, path: 'denied.html' })).rejects.toThrow('permission');
});
test('non-HTML, oversized, binary, and removed workspace files fail without a partial preview', async () => {
  await expect(readVisualization(fixture().call, { ...request, path: '/workspace/secret.txt' })).rejects.toThrow('HTML');
  await expect(readVisualization(fixture('x'.repeat(MAX_VISUALIZATION_BYTES + 1)).call, request)).rejects.toThrow('1 MB');
  await expect(readVisualization(fixture('a\0b').call, request)).rejects.toThrow('HTML text');
  await expect(readVisualization(async method => method === 'session.page' ? { session: { projectId: 'p', workspaceId: 'w' } } : { workspaces: [] }, request)).rejects.toThrow('unavailable');
});
test('preview URLs serve only prepared documents, enforce isolation, and are revoked on release or reload', async () => {
  const store = createVisualizationStore(fixture().call), preview = await store.prepare(request);
  const response = store.response(new Request(preview.url));
  expect(await response.text()).toContain('<h1>Preview</h1>');
  expect(response.headers.get('content-security-policy')).toContain('sandbox allow-scripts');
  expect(response.headers.get('content-security-policy')).not.toContain('allow-same-origin');
  expect(response.headers.get('content-security-policy')).toContain("connect-src 'none'");
  expect(store.response(new Request(`${preview.url}/../../secret`)).status).toBe(404);
  store.release(preview.url);
  expect(store.response(new Request(preview.url)).status).toBe(404);
  const next = await store.prepare(request); store.clear();
  expect(store.has(next.url)).toBe(false);
});
