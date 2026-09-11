import { expect, test } from 'bun:test';
import { BrowserBroker } from '../../apps/engine/src/browser/broker.js';
import { ToolDispatcher } from '../../apps/engine/src/tools/dispatcher.js';
import { createBrowserOpener } from '../../apps/desktop/src/main/browser-opener.js';
import { browserTarget } from '../../apps/desktop/src/renderer/browser-target.js';
import { createRpcHandlers } from '../../apps/engine/src/rpc/handlers.js';

const connection = () => ({ closeHooks: new Set(), notifications: [], notify(method, params) { this.notifications.push({ method, params }); } });
const request = (workspaceId, invocationId, signal = new AbortController().signal) => ({ workspaceId, invocationId, signal, operation: 'open', args: {}, leaseMs: 1000 });
const register = (broker, conn, workspaceId) => broker.register(conn, { workspaceId, tabId: `tab_${workspaceId}`, navigationRevision: 0, operations: ['navigate', 'snapshot'] }, 'grant');

test('a closed pane is discoverable only in advertised workspaces; opening waits for the correct host', async () => {
  const broker = new BrowserBroker({ storage: { appendEvent() {} }, log: {} });
  const desktop = connection(), other = connection();
  broker.setOpener(desktop, ['one']);
  const dispatcher = new ToolDispatcher({ browser: broker });
  expect(dispatcher.hasBrowser('one')).toBe(true);
  expect(dispatcher.hasBrowser('two')).toBe(false);
  const opened = broker.execute({ ...request('one', 'i1'), leaseMs: 60_000 });
  expect(desktop.notifications[0]).toMatchObject({ method: 'browser.open', params: { workspaceId: 'one', leaseMs: 15_000 } });
  const wrongHost = register(broker, other, 'one');
  const wrongWorkspace = register(broker, desktop, 'two');
  expect(() => broker.openResult(other, { invocationId: 'i1', capabilityId: wrongHost.capabilityId })).toThrow('different desktop');
  expect(() => broker.openResult(desktop, { invocationId: 'i1', capabilityId: wrongWorkspace.capabilityId })).toThrow('outside the requested workspace');
  const cap = register(broker, desktop, 'one');
  broker.openResult(desktop, { invocationId: 'i1', capabilityId: cap.capabilityId });
  expect((await opened).result.tabId).toBe('tab_one');
  expect(broker.pendingOpens.size).toBe(0);
});

test('cancel, closed workspace, timeout, and disconnect settle pending opens and reject late replies', async () => {
  for (const action of ['cancel', 'workspace', 'disconnect', 'timeout']) {
    const broker = new BrowserBroker({ storage: { appendEvent() {} }, log: {} });
    const conn = connection(), controller = new AbortController();
    broker.setOpener(conn, ['ws']);
    const outcome = broker.execute({ ...request('ws', action, controller.signal), leaseMs: 10 }).catch(error => error);
    if (action === 'cancel') controller.abort();
    if (action === 'workspace') broker.setOpener(conn, []);
    if (action === 'disconnect') for (const hook of conn.closeHooks) hook();
    expect(await outcome).toBeInstanceOf(Error);
    expect(broker.pendingOpens.size).toBe(0);
    expect(broker.openResult(conn, { invocationId: action, error: 'late' }).accepted).toBe(false);
    expect(conn.notifications.at(-1).method).toBe('browser.cancel');
  }
});

function desktopFixture() {
  const calls = [], messages = [], listeners = new Set(), hosts = new Map();
  let overlay = false;
  const bridge = { async rawCall(method, params) { calls.push({ method, params }); return {}; } };
  const opener = createBrowserOpener({ bridge, agent: { hosts, onRegistered(listener) { listeners.add(listener); } }, send: (method, params) => messages.push({ method, params }), isOverlayActive: () => overlay, log: { warn() {} } });
  const registerHost = (workspaceId = 'ws') => {
    hosts.set(1, { workspaceId, capabilityId: 'cap', guest: { isDestroyed: () => false } });
    for (const listener of listeners) listener();
  };
  opener.setWorkspaces({ workspaceIds: ['ws'] });
  return { opener, calls, messages, registerHost, overlay: value => { overlay = value; } };
}

test('run admission waits until the latest pane list is registered with the engine', async () => {
  const calls = []; let release;
  const bridge = { client: {}, rawCall(method, params) { calls.push(params.workspaceIds); return calls.length === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve({}); } };
  const opener = createBrowserOpener({ bridge, agent: { hosts: new Map(), onRegistered() {} }, send() {}, isOverlayActive: () => false, log: { warn() {} } });
  opener.setWorkspaces({ workspaceIds: ['old'] });
  await Promise.resolve(); await Promise.resolve();
  opener.setWorkspaces({ workspaceIds: ['new'] });
  let ready = false;
  const pending = opener.beforeRun().then(() => { ready = true; });
  await Promise.resolve();
  expect(ready).toBe(false);
  release({}); await pending;
  expect(calls.at(-1)).toEqual(['new']);
});

test('desktop opening needs both renderer acknowledgement and completed guest registration, in either order', async () => {
  for (const hostFirst of [false, true]) {
    const f = desktopFixture();
    await f.opener.onConnected();
    expect(f.calls[0]).toEqual({ method: 'browser.setOpener', params: { workspaceIds: ['ws'] } });
    f.opener.handleOpen({ invocationId: 'i1', workspaceId: 'ws', leaseMs: 1000 });
    expect(f.messages[0].method).toBe('jolo:browserOpen');
    if (hostFirst) f.registerHost(); else f.opener.acknowledge({ invocationId: 'i1' });
    expect(f.calls).toHaveLength(1);
    if (hostFirst) f.opener.acknowledge({ invocationId: 'i1' }); else f.registerHost();
    expect(f.calls.at(-1)).toEqual({ method: 'browser.openResult', params: { invocationId: 'i1', capabilityId: 'cap' } });
  }
});

test('desktop cancels pending UI requests, refuses overlays and unadvertised workspaces', () => {
  const f = desktopFixture();
  f.opener.handleOpen({ invocationId: 'i1', workspaceId: 'ws', leaseMs: 1000 });
  f.opener.handleCancel({ invocationId: 'i1' });
  f.opener.acknowledge({ invocationId: 'i1' });
  f.registerHost();
  expect(f.calls).toHaveLength(0);
  expect(f.messages.at(-1).method).toBe('jolo:browserOpenCancel');
  f.overlay(true);
  f.opener.handleOpen({ invocationId: 'i2', workspaceId: 'ws', leaseMs: 1000 });
  expect(f.calls.at(-1).params.error).toContain('dialog');
  f.overlay(false);
  f.opener.handleOpen({ invocationId: 'i3', workspaceId: 'different', leaseMs: 1000 });
  expect(f.calls.at(-1).params.error).toContain('open this workspace');
  expect(f.messages.filter(message => message.method === 'jolo:browserOpen')).toHaveLength(1);
});

test('chat cannot replace another workspace browser, including concurrent opens before attachment', () => {
  for (const alreadyAttached of [false, true]) {
    const f = desktopFixture();
    f.opener.setWorkspaces({ workspaceIds: ['ws', 'other'] });
    if (alreadyAttached) f.registerHost('other');
    else f.opener.handleOpen({ invocationId: 'first', workspaceId: 'other', leaseMs: 1000 });
    f.opener.handleOpen({ invocationId: 'second', workspaceId: 'ws', leaseMs: 1000 });
    expect(f.calls.at(-1)).toMatchObject({ method: 'browser.openResult', params: { invocationId: 'second', errorCode: 'browser_busy' } });
    expect(f.messages.filter(message => message.method === 'jolo:browserOpen' && message.params.workspaceId === 'ws')).toHaveLength(0);
    if (!alreadyAttached) {
      f.opener.acknowledge({ invocationId: 'first' });
      f.registerHost('other');
      expect(f.calls.at(-1).params).toEqual({ invocationId: 'first', capabilityId: 'cap' });
    }
  }
});

test('renderer reveals an existing page in the same workspace and refuses to evict another workspace', () => {
  const panes = new Map([['a', { workspaceId: 'ws', hasBrowser: true }], ['b', { workspaceId: 'ws', hasBrowser: false }], ['c', { workspaceId: 'other', hasBrowser: false }]]);
  expect(browserTarget(panes, 'ws', 'b')[0]).toBe('a');
  expect(() => browserTarget(panes, 'other', 'c')).toThrow('another workspace');
  panes.get('a').hasBrowser = false;
  expect(browserTarget(panes, 'other', 'c')[0]).toBe('c');
  expect(() => browserTarget(panes, 'missing', 'c')).toThrow('no longer open');
});

test('busy replies leave other workspace operations pending and return a conflict', async () => {
  const broker = new BrowserBroker({ storage: { appendEvent() {} }, log: {} });
  const conn = connection();
  broker.setOpener(conn, ['one', 'two']);
  register(broker, conn, 'one');
  const first = broker.execute({ ...request('one', 'snapshot'), operation: 'snapshot' });
  const second = broker.execute(request('two', 'open')).catch(error => error);
  broker.openResult(conn, { invocationId: 'open', error: 'another workspace owns the browser', errorCode: 'browser_busy' });
  expect(await second).toMatchObject({ code: 'conflict', details: { code: 'browser_busy' } });
  expect(broker.pending.has('snapshot')).toBe(true);
  broker.result(conn, { invocationId: 'snapshot', status: 'ok', result: { nodes: [] } });
  expect((await first).result).toEqual({ nodes: [] });
});

test('stale and removed workspace ids do not poison valid opener registrations', async () => {
  const storage = { getWorkspace(id) { return id === 'live' ? { id } : id === 'removed' ? { id, removedAt: 'now' } : null; }, appendEvent() {} };
  const browser = new BrowserBroker({ storage, log: {} });
  const handlers = createRpcHandlers({ storage, browser });
  const conn = { ...connection(), kind: 'desktop' };
  expect(await handlers['browser.setOpener']({ workspaceIds: ['live', 'missing', 'removed', 'live'] }, conn)).toEqual({ registered: true });
  expect(browser.hasBrowser('live')).toBe(true);
  expect(browser.hasBrowser('removed')).toBe(false);
  expect(browser.hasBrowser('missing')).toBe(false);
  await expect(handlers['browser.setOpener']({ workspaceIds: ['live'] }, { ...conn, capability: { runId: 'guest' } })).rejects.toMatchObject({ code: 'permission_denied' });
  expect(await handlers['browser.setOpener']({ workspaceIds: ['missing'] }, conn)).toEqual({ registered: false });
  expect(browser.hasBrowser('live')).toBe(false);
});
