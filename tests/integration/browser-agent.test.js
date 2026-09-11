import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { createBrowserAgent } from '../../apps/desktop/src/main/browser-agent.js';
import { BrowserBroker } from '../../apps/engine/src/browser/broker.js';

/**
 * The slice of Electron's `WebContents` the browser agent attaches to. The debugger arrives a line
 * after the guest itself, because it closes over the `send` this fixture was given.
 * @typedef {EventEmitter & {
 *   id: number,
 *   getURL: () => string,
 *   getTitle: () => string,
 *   isDestroyed: () => boolean,
 *   debugger?: EventEmitter & { sendCommand: (method: string, args?: any) => Promise<any> },
 * }} FakeGuest
 */

/**
 * @param {(method: string, args: any) => Promise<any>} [send] answers any CDP command the fixture
 *   does not handle itself, which is how a case stalls or redirects one command.
 */
async function fixture(send = async () => ({})) {
  const calls = [], replies = [];
  let overlay = false;
  /** @type {FakeGuest} */
  const guest = Object.assign(new EventEmitter(), { id: 1, getURL: () => 'http://fixture/', getTitle: () => 'Fixture', isDestroyed: () => false });
  guest.debugger = Object.assign(new EventEmitter(), { async sendCommand(method, args) {
    calls.push({ method, args });
    if (method === 'Accessibility.getFullAXTree') return { nodes: [{ nodeId: '1', role: { value: 'textbox' }, name: { value: 'Name' }, backendDOMNodeId: 11 }] };
    if (method === 'DOM.resolveNode') return { object: { objectId: 'field' } };
    return send(method, args);
  } });
  // No case here takes a screenshot, so the dependency bag deliberately leaves out `nativeImage`.
  const agent = createBrowserAgent(/** @type {Parameters<typeof createBrowserAgent>[0]} */ ({ bridge: { async rawCall(method, params) { if (method === 'browser.result') replies.push(params); return { capabilityId: 'cap' }; } }, log: { info() {}, warn() {} }, isOverlayActive: () => overlay }));
  const host = agent.attach(guest, 'ws');
  await Promise.resolve();
  let sequence = 0;
  const execute = (operation, args = {}, leaseMs = 2000) => {
    const invocationId = `i${++sequence}`;
    return { invocationId, done: agent.handleExecute({ invocationId, capabilityId: 'cap', navigationRevision: host.navigationRevision, operation, arguments: args, leaseMs }) };
  };
  return { calls, replies, guest, host, agent, execute, overlay: value => { overlay = value; } };
}

test('snapshot references never alias a later snapshot, and unknown snapshot ids are stale', async () => {
  const f = await fixture();
  for (let i = 0; i < 3; i++) await f.execute('snapshot').done;
  expect(f.replies.map(reply => reply.result.nodes[0].ref)).toEqual(['e1', 'e2', 'e3']);
  await f.execute('fill', { ref: 'e1', text: 'wrong' }).done;
  expect(f.replies.at(-1).status).toBe('stale');
  await f.execute('fill', { ref: 'e3', text: 'wrong', snapshotId: 'missing' }).done;
  expect(f.replies.at(-1).status).toBe('stale');
  expect(f.calls.some(call => call.method === 'Input.insertText')).toBe(false);
});

test('a cancelled focus cannot later insert text; a queued action is cancelled before it starts', async () => {
  /** @type {(value?: any) => void} */
  let release;
  const f = await fixture(async method => method === 'Runtime.callFunctionOn' ? new Promise(resolve => { release = resolve; }) : {});
  await f.execute('snapshot').done;
  const first = f.execute('fill', { ref: 'e1', text: 'late' });
  for (let i = 0; !release && i < 100; i++) await Bun.sleep(1);
  expect(release).toBeDefined();
  const second = f.execute('press', { key: 'Enter' });
  f.agent.handleCancel(second);
  f.agent.handleCancel(first);
  await Promise.all([first.done, second.done]);
  release({});
  await Bun.sleep(10);
  expect(f.replies.slice(-2).map(reply => reply.status)).toEqual(['cancelled', 'cancelled']);
  expect(f.calls.filter(call => call.method.startsWith('Input.'))).toHaveLength(0);
});

test('navigation during focus and host dialogs prevent input, and disconnect cancels operations', async () => {
  const f = await fixture(async method => { if (method === 'DOM.focus') f.guest.emit('did-navigate'); return {}; });
  await f.execute('snapshot').done;
  await f.execute('press', { ref: 'e1', key: 'Enter' }).done;
  expect(f.replies.at(-1).status).toBe('stale');
  f.overlay(true);
  await f.execute('press', { key: 'Enter' }).done;
  expect(f.replies.at(-1).error.code).toBe('host_overlay');
  f.overlay(false);
  const call = f.execute('press', { key: 'Enter' });
  f.agent.onDisconnected();
  await call.done;
  expect(f.replies.at(-1).status).toBe('cancelled');
  expect(f.calls.filter(call => call.method.startsWith('Input.'))).toHaveLength(0);
});

test('the broker scopes tab discovery, requires a choice for multiple tabs, and refuses already cancelled actions', async () => {
  const broker = new BrowserBroker({ storage: { appendEvent() {} }, log: {} });
  const conn = { closeHooks: new Set(), notify() { throw new Error('must not dispatch'); } };
  for (const [workspaceId, tabId] of [['one', 'a'], ['one', 'b'], ['two', 'c']]) broker.register(conn, { workspaceId, tabId, operations: ['snapshot'], navigationRevision: 0 }, 'grant');
  const signal = new AbortController().signal;
  const result = await broker.execute({ workspaceId: 'one', operation: 'tabs', args: {}, signal });
  expect(result.result.tabs.map(tab => tab.tabId)).toEqual(['a', 'b']);
  expect(() => broker.capabilityFor('one', 'snapshot')).toThrow('multiple browser tabs');
  expect(broker.capabilityFor('one', 'snapshot', 'b').tabId).toBe('b');
  expect(() => broker.capabilityFor('one', 'snapshot', 'c')).toThrow('does not support');
  expect(() => broker.execute({ workspaceId: 'one', operation: 'snapshot', args: {}, signal: AbortSignal.abort() })).toThrow('run cancelled');
});
