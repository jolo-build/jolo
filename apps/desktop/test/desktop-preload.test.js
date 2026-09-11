import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../src/preload/index.cjs', import.meta.url), 'utf8');

/**
 * The object the preload hands to `contextBridge.exposeInMainWorld`. The preload is evaluated as
 * source inside a VM sandbox, so the checker cannot follow it there; this records the part of the
 * bridge these tests reach for. `prepareVisualization` is optional because an older desktop, which
 * is exactly what the first test stands in for, withholds the newer handlers. Its parameter carries
 * an index signature because the preload deliberately forwards only `sessionId` and `path` and drops
 * whatever else the renderer passed, which is the behaviour the second test checks.
 * @typedef {{
 *   call: (method: string, params?: unknown) => Promise<unknown>,
 *   homeDirectory: () => Promise<string | null>,
 *   prepareVisualization?: (params: { sessionId: string, path: string, [key: string]: unknown }) => Promise<unknown>,
 * }} PreloadApi
 */

/**
 * @param {string[]} argv the process argv the preload reads its feature flag from
 * @returns {{ api: PreloadApi, calls: unknown[][] }}
 */
function preload(argv) {
  /** @type {PreloadApi} */
  let api;
  const calls = [];
  runInNewContext(source, {
    process: { argv, platform: 'darwin', env: {} },
    require: () => ({
      contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } },
      ipcRenderer: { on() {}, send() {}, invoke: async (...args) => { calls.push(args); return 'response'; } },
    }),
  });
  return { api, calls };
}

test('a reloaded preload does not invoke handlers missing from an older desktop', async () => {
  const { api, calls } = preload(['electron']);
  expect(await api.homeDirectory()).toBeNull();
  expect(api.prepareVisualization).toBeUndefined();
  expect(calls).toEqual([]);
  await api.call('engine.status', {});
  expect(calls).toEqual([['jolo:call', { method: 'engine.status', params: {} }]]);
});

test('a current desktop exposes the new handlers through the narrow bridge', async () => {
  const { api, calls } = preload(['electron', '--jolo-desktop-api=1']);
  await api.homeDirectory();
  await api.prepareVisualization({ sessionId: 'chat', path: '/repo/preview.html', ignored: true });
  expect(calls).toEqual([
    ['jolo:homeDirectory'],
    ['jolo:visualization:prepare', { sessionId: 'chat', path: '/repo/preview.html' }],
  ]);
});
