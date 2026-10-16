import { expect, test } from 'bun:test';
import { BrowserBroker } from '../../apps/engine/src/browser/broker.js';
import { ToolDispatcher } from '../../apps/engine/src/tools/dispatcher.js';
import { createBrowserOpener } from '../../apps/desktop/src/main/browser-opener.js';
import { browserTarget } from '../../apps/desktop/src/renderer/browser-target.js';
import { HostDialogs } from '../../apps/desktop/src/main/host-dialogs.js';
import { createRpcHandlers } from '../../apps/engine/src/rpc/handlers.js';

const connection = () => ({ closeHooks: new Set(), notifications: [], notify(method, params) { this.notifications.push({ method, params }); } });
const request = (workspaceId, invocationId, signal = new AbortController().signal) => ({ workspaceId, invocationId, signal, operation: 'open', args: {}, leaseMs: 1000 });
const register = (broker, conn, workspaceId) => broker.register(conn, { workspaceId, tabId: `tab_${workspaceId}`, navigationRevision: 0, operations: ['navigate', 'snapshot'] }, 'grant');

test('a closed pane is discoverable only in advertised workspaces; opening waits for the correct host', async () => {
  const broker = new BrowserBroker({ storage: { appendEvent() {} }, log: {} });
  const desktop = connection(), other = connection();
  broker.setOpener(desktop, ['one']);
  // Only `hasBrowser` is asked of the dispatcher here, so the rest of its dependencies stay absent.
  const dispatcher = new ToolDispatcher(/** @type {ConstructorParameters<typeof ToolDispatcher>[0]} */ ({ browser: broker }));
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

test('browser opening survives a brief desktop restart for a workspace that was already open', async () => {
  const broker = new BrowserBroker({ storage: { appendEvent() {} }, log: {} });
  const before = connection(), after = connection();
  broker.setOpener(before, ['one']);
  for (const hook of before.closeHooks) hook();
  expect(broker.hasBrowser('one')).toBe(true);

  const opened = broker.execute(request('one', 'reconnect'));
  expect(broker.pendingOpens.size).toBe(1);
  expect(before.notifications).toHaveLength(0);

  broker.setOpener(after, ['one']);
  expect(after.notifications).toEqual([{ method: 'browser.open', params: { invocationId: 'reconnect', workspaceId: 'one', leaseMs: 1000 } }]);
  const capability = register(broker, after, 'one');
  broker.openResult(after, { invocationId: 'reconnect', capabilityId: capability.capabilityId });
  expect((await opened).result.tabId).toBe('tab_one');
  expect(broker.pendingOpens.size).toBe(0);
});

test('a pending browser open transfers to the replacement desktop connection', async () => {
  const broker = new BrowserBroker({ storage: { appendEvent() {} }, log: {} });
  const before = connection(), after = connection();
  broker.setOpener(before, ['one']);
  const opened = broker.execute(request('one', 'transfer'));
  expect(before.notifications[0].method).toBe('browser.open');

  for (const hook of before.closeHooks) hook();
  expect(broker.pendingOpens.size).toBe(1);
  broker.setOpener(after, ['one']);
  const capability = register(broker, after, 'one');
  broker.openResult(after, { invocationId: 'transfer', capabilityId: capability.capabilityId });
  expect((await opened).result.tabId).toBe('tab_one');
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
    expect(conn.notifications.at(-1).method).toBe(action === 'disconnect' ? 'browser.open' : 'browser.cancel');
  }
});

function desktopFixture(waitForDialog = false) {
  const calls = [], messages = [], listeners = new Set(), hosts = new Map();
  const dialogs = new HostDialogs();
  const bridge = { async rawCall(method, params) { calls.push({ method, params }); return {}; } };
  const opener = createBrowserOpener({ bridge, agent: { hosts, onRegistered(listener) { listeners.add(listener); } }, send: (method, params) => messages.push({ method, params }), isOverlayActive: () => dialogs.active, waitForOverlay: waitForDialog ? signal => dialogs.wait(signal) : null, log: { warn() {} } });
  const registerHost = (workspaceId = 'ws') => {
    hosts.set(workspaceId, { workspaceId, capabilityId: 'cap', guest: { isDestroyed: () => false } });
    for (const listener of listeners) listener();
  };
  opener.setWorkspaces({ workspaceIds: ['ws'] });
  return { opener, calls, messages, registerHost, dialogs, overlay: value => dialogs.set(value) };
}

test('browser opening waits for approval UI and resumes once without changing the original lease', async () => {
  const f = desktopFixture(true);
  f.overlay(true);
  f.opener.handleOpen({ invocationId:'approval', workspaceId:'ws', leaseMs:1000 });
  expect(f.messages).toHaveLength(0);
  expect(f.calls).toHaveLength(0);
  expect(f.dialogs.listeners.size).toBe(1);
  f.overlay(false);
  await Promise.resolve();
  expect(f.messages[0].method).toBe('jolo:browserOpen');
  f.opener.acknowledge({ invocationId:'approval' });
  f.registerHost();
  expect(f.calls.at(-1).params).toEqual({invocationId:'approval',capabilityId:'cap'});
  expect(f.dialogs.listeners.size).toBe(0);
});

test('cancel, expiry, workspace removal and disconnect prevent late opens after approval', async () => {
  for (const action of ['cancel','expiry','workspace','disconnect']) {
    const f = desktopFixture(true);
    f.overlay(true);
    f.opener.handleOpen({ invocationId:action, workspaceId:'ws', leaseMs:action==='expiry'?10:1000 });
    if (action==='cancel') f.opener.handleCancel({invocationId:action});
    if (action==='workspace') f.opener.setWorkspaces({workspaceIds:[]});
    if (action==='disconnect') f.opener.onDisconnected();
    if (action==='expiry') await Bun.sleep(25);
    f.overlay(false); await Promise.resolve();
    expect(f.messages.some(message=>message.method==='jolo:browserOpen')).toBe(false);
    expect(f.dialogs.listeners.size).toBe(0);
  }
});

test('run admission waits until the latest pane list is registered with the engine', async () => {
  const calls = [];
  /** @type {(value?: any) => void} */ let release;
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

test('a pane switch during run admission publishes the new workspace before proceeding', async () => {
  const calls = [];
  /** @type {(value?: any) => void} */ let release;
  const bridge = { rawCall(method, params) { calls.push(params.workspaceIds); return calls.length === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve({}); } };
  const opener = createBrowserOpener({ bridge, agent: { hosts: new Map(), onRegistered() {} }, send() {}, isOverlayActive: () => false, log: { warn() {} } });
  opener.setWorkspaces({ workspaceIds: ['old'] });
  const admission = opener.beforeRun();
  await Promise.resolve(); await Promise.resolve();
  opener.setWorkspaces({ workspaceIds: ['new'] });
  release({});
  await admission;
  expect(calls).toEqual([['old'], ['new']]);
});

test('failed browser registration blocks run admission and can be retried', async () => {
  let unavailable = true;
  const warnings = [];
  const bridge = { async rawCall() { if (unavailable) throw new Error('desktop socket disconnected'); return {}; } };
  const opener = createBrowserOpener({ bridge, agent: { hosts: new Map(), onRegistered() {} }, send() {}, isOverlayActive: () => false, log: { warn: (message, fields) => warnings.push(fields.error) } });
  opener.setWorkspaces({ workspaceIds: ['ws'] });
  await opener.onConnected();
  expect(warnings).toEqual(['desktop socket disconnected']);
  await expect(opener.beforeRun()).rejects.toThrow('desktop socket disconnected');
  unavailable = false;
  await opener.beforeRun();
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

test('different workspaces can open independent browsers, including concurrent attachment', () => {
  for (const alreadyAttached of [false, true]) {
    const f = desktopFixture();
    f.opener.setWorkspaces({ workspaceIds: ['ws', 'other'] });
    if (alreadyAttached) f.registerHost('other');
    else f.opener.handleOpen({ invocationId: 'first', workspaceId: 'other', leaseMs: 1000 });
    f.opener.handleOpen({ invocationId: 'second', workspaceId: 'ws', leaseMs: 1000 });
    expect(f.messages.filter(message => message.method === 'jolo:browserOpen' && message.params.workspaceId === 'ws')).toHaveLength(1);
    f.opener.acknowledge({ invocationId: 'second' });
    f.registerHost('ws');
    expect(f.calls.at(-1)).toMatchObject({ method: 'browser.openResult', params: { invocationId: 'second', capabilityId: 'cap' } });
    if (!alreadyAttached) {
      f.opener.acknowledge({ invocationId: 'first' });
      f.registerHost('other');
      expect(f.calls.at(-1).params).toEqual({ invocationId: 'first', capabilityId: 'cap' });
    }
  }
});

test('renderer routes each workspace independently without evicting an existing browser', () => {
  const panes = new Map([['a', { workspaceId: 'ws', hasBrowser: true }], ['b', { workspaceId: 'ws', hasBrowser: false }], ['c', { workspaceId: 'other', hasBrowser: false }]]);
  expect(browserTarget(panes, 'ws', 'b')[0]).toBe('a');
  expect(browserTarget(panes, 'other', 'c')[0]).toBe('c');
  expect(panes.get('a').hasBrowser).toBe(true);
  expect(() => browserTarget(panes, 'missing', 'c')).toThrow('no longer open');
});

test('renderer routes background opens to a retained workspace without changing the active workspace', () => {
  const pane = { workspaceId: 'current', browserWorkspaceIds: ['background', 'current'], hasBrowser: false };
  const panes = new Map([['a', pane]]);
  expect(browserTarget(panes, 'background', 'a')).toEqual(['a', pane]);
  expect(pane.workspaceId).toBe('current');
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
  // Only the browser handlers run here, so the rest of the engine's services are left out.
  const handlers = createRpcHandlers(/** @type {import('../../apps/engine/src/rpc/handlers.js').RpcDependencies} */ ({ storage, browser }));
  const conn = { ...connection(), kind: 'desktop' };
  expect(await handlers['browser.setOpener']({ workspaceIds: ['live', 'missing', 'removed', 'live'] }, conn)).toEqual({ registered: true });
  expect(browser.hasBrowser('live')).toBe(true);
  expect(browser.hasBrowser('removed')).toBe(false);
  expect(browser.hasBrowser('missing')).toBe(false);
  await expect(handlers['browser.setOpener']({ workspaceIds: ['live'] }, { ...conn, capability: { runId: 'guest' } })).rejects.toMatchObject({ code: 'permission_denied' });
  expect(await handlers['browser.setOpener']({ workspaceIds: ['missing'] }, conn)).toEqual({ registered: false });
  expect(browser.hasBrowser('live')).toBe(false);
});

test('browser open carries its originating chat through the engine notification', async () => {
  const broker = new BrowserBroker({ storage: { appendEvent() {} }, log: {} });
  const desktop = connection();
  broker.setOpener(desktop, ['shared']);
  const opened = broker.execute({ ...request('shared', 'chat-open'), sessionId: 'origin-chat' });
  expect(desktop.notifications[0].params.sessionId).toBe('origin-chat');
  const cap = register(broker, desktop, 'shared');
  broker.openResult(desktop, { invocationId: 'chat-open', capabilityId: cap.capabilityId });
  await opened;
});

test('a background chat wins over the active chat and its browser in the same workspace', () => {
  const panes = new Map([
    ['active', { workspaceId: 'shared', sessionId: 'other', hasBrowser: true }],
    ['owner', { workspaceId: 'different', sessionId: 'third', browserChatScopes: [{ workspaceId: 'shared', sessionId: 'origin' }] }],
  ]);
  expect(browserTarget(panes, 'shared', 'active', 'origin')[0]).toBe('owner');
  expect(() => browserTarget(panes, 'shared', 'active', 'missing')).toThrow('chat is no longer open');
});

test('chat-specific open waits for the selected guest instead of any registered workspace guest', async () => {
  const calls = [], messages = [], listeners = [];
  const hosts = new Map([['other', { workspaceId: 'shared', tabId: 'tab_other', capabilityId: 'cap_other', guest: { isDestroyed: () => false } }]]);
  const opener = createBrowserOpener({ bridge: { rawCall: async (method, params) => { calls.push({ method, params }); } }, agent: { hosts, onRegistered: fn => listeners.push(fn) }, send: (method, params) => messages.push({ method, params }), isOverlayActive: () => false, log: { warn() {} } });
  opener.setWorkspaces({ workspaceIds: ['shared'] });
  opener.handleOpen({ invocationId: 'open-origin', workspaceId: 'shared', sessionId: 'origin', leaseMs: 1000 });
  expect(messages.find(m => m.method === 'jolo:browserOpen').params.sessionId).toBe('origin');
  opener.acknowledge({ invocationId: 'open-origin', tabId: 'tab_origin' });
  expect(calls.filter(c => c.method === 'browser.openResult')).toHaveLength(0);
  hosts.set('origin', { workspaceId: 'shared', tabId: 'tab_origin', capabilityId: 'cap_origin', guest: { isDestroyed: () => false } });
  for (const notify of listeners) notify();
  expect(calls.find(c => c.method === 'browser.openResult').params.capabilityId).toBe('cap_origin');
});
