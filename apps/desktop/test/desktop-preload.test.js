import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../src/preload/index.cjs', import.meta.url), 'utf8');
function preload(argv) {
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
