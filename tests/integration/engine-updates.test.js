import { expect, test } from 'bun:test';
import { createEngineUpdates } from '../../apps/desktop/src/main/engine-updates.js';
import { createRpcHandlers } from '../../apps/engine/src/rpc/handlers.js';

test('source reload waits for quiet edits and idle work, then requests once per boot', async () => {
  let time = 0, newest = 200, busy = true, reloads = 0;
  const status = { startedAt: new Date(100).toISOString(), engineBootId: 'old' };
  const connection = { connected: true, hello: { supportedMethods: ['engine.reload'] }, async call(method) {
    if (method === 'engine.status') return status;
    reloads++;
    if (busy) throw Object.assign(new Error('busy'), { code: 'conflict' });
    return { stopping: true };
  } };
  const monitor = createEngineUpdates({ roots: [], newestSourceTime: () => newest, client: () => connection, now: () => time,
    notice() { throw new Error('unexpected notice'); }, log: { info() {}, warn() {} } });
  await monitor.check();
  time = 1000; newest = 300; await monitor.check();
  time = 2000; await monitor.check(); expect(reloads).toBe(0);
  time = 3000; await monitor.check(); expect(reloads).toBe(1);
  busy = false; await monitor.check(); expect(reloads).toBe(2);
  await monitor.check(); expect(reloads).toBe(2);
  status.engineBootId = 'new'; status.startedAt = new Date(400).toISOString();
  await monitor.check(); expect(reloads).toBe(2);
  monitor.stop(); newest = 500; time = 9000; await monitor.check(); expect(reloads).toBe(2);
});

test('older engines receive one migration notice without an unsafe stop request', async () => {
  let time = 0;
  const notices = [];
  const connection = { connected: true, hello: { supportedMethods: ['engine.stop'] }, async call(method) {
    expect(method).toBe('engine.status');
    return { startedAt: new Date(100).toISOString(), engineBootId: 'old' };
  } };
  const monitor = createEngineUpdates({ roots: [], newestSourceTime: () => 200, client: () => connection,
    now: () => time, notice: body => notices.push(body), log: { info() {}, warn() {} } });
  await monitor.check(); time = 3000; await monitor.check(); await monitor.check();
  expect(notices).toHaveLength(1);
  expect(notices[0]).toContain('once');
});

test('idle reload refuses outstanding requests and closes admission before shutdown', async () => {
  /** @type {(value?: any) => void} */ let finishProbe, stopped = 0;
  // Only reload and the agent-model probe are exercised, so the other engine services stay absent.
  const handlers = createRpcHandlers(/** @type {any} */ ({ runs: { activeCount: 0, queuedCount: 0 }, terminals: { list: () => [] },
    agentModels: { list: () => new Promise(resolve => { finishProbe = resolve; }) }, stop: () => stopped++ }));
  const conn = { kind: 'desktop' };
  const probe = handlers['agent.models']({ agentId: 'agent' }, conn);
  await expect(handlers['engine.reload']({}, conn)).rejects.toMatchObject({ code: 'conflict' });
  finishProbe({ models: [] }); await probe;
  expect(await handlers['engine.reload']({}, conn)).toEqual({ stopping: true });
  await expect(handlers['agent.models']({ agentId: 'agent' }, conn)).rejects.toMatchObject({ code: 'unavailable' });
  await Bun.sleep(70); expect(stopped).toBe(1);
});
