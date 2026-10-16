import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { createBrowserAgent } from '../../apps/desktop/src/main/browser-agent.js';
import { BrowserBroker } from '../../apps/engine/src/browser/broker.js';
import { HostDialogs } from '../../apps/desktop/src/main/host-dialogs.js';

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
 * A native image standing in for Electron's: a capture at device resolution whose crops and resizes
 * are recorded, so a case can check the geometry the host applied.
 * @param {number} width @param {number} height @param {any[]} log
 * @returns {any}
 */
function fakeImage(width, height, log) {
  return {
    getSize: () => ({ width, height }),
    resize: ({ width: w, height: h }) => { log.push({ resize: [w, h] }); return fakeImage(w, h, log); },
    crop: rect => { log.push({ crop: rect }); return fakeImage(rect.width, rect.height, log); },
    toPNG: () => Buffer.alloc(64, 1),
  };
}

/**
 * @param {(method: string, args: any) => Promise<any>} [send] answers any CDP command the fixture
 *   does not handle itself, which is how a case stalls or redirects one command.
 * @param {any} [dialogs] host dialogs whose overlay gates input
 * @param {{ width: number, height: number } | null} [capture] the device-pixel size a screenshot captures
 */
async function fixture(send = async () => ({}), dialogs = null, capture = null) {
  const calls = [], replies = [], cursors = [], images = [];
  let overlay = false;
  /** @type {FakeGuest} */
  const guest = Object.assign(new EventEmitter(), { id: 1, getURL: () => 'http://fixture/', getTitle: () => 'Fixture', isDestroyed: () => false, invalidate() {} });
  guest.debugger = Object.assign(new EventEmitter(), { async sendCommand(method, args) {
    calls.push({ method, args });
    if (method === 'Accessibility.getFullAXTree') return { nodes: [{ nodeId: '1', role: { value: 'textbox' }, name: { value: 'Name' }, backendDOMNodeId: 11 }] };
    if (method === 'DOM.resolveNode') return { object: { objectId: 'field' } };
    return send(method, args);
  } });
  // Only the screenshot cases pass a capture size; the others leave `nativeImage` out on purpose.
  const nativeImage = capture ? { createFromBuffer: () => fakeImage(capture.width, capture.height, images) } : undefined;
  const agent = createBrowserAgent(/** @type {Parameters<typeof createBrowserAgent>[0]} */ ({ onCursor: payload => cursors.push(payload), nativeImage, bridge: { async rawCall(method, params) { if (method === 'browser.result') replies.push(params); return { capabilityId: 'cap' }; } }, log: { info() {}, warn() {} }, isOverlayActive: () => dialogs ? dialogs.active : overlay, waitForOverlay: dialogs ? signal => dialogs.wait(signal) : null }));
  const host = agent.attach(guest, 'ws');
  await Promise.resolve();
  let sequence = 0;
  const execute = (operation, args = {}, leaseMs = 2000) => {
    const invocationId = `i${++sequence}`;
    return { invocationId, done: agent.handleExecute({ invocationId, capabilityId: 'cap', navigationRevision: host.navigationRevision, operation, arguments: args, leaseMs }) };
  };
  return { calls, replies, cursors, images, guest, host, agent, execute, overlay: value => { overlay = value; } };
}

/** A 1000×500 CSS viewport captured at device pixel ratio 2, with an editable element focused unless told otherwise. */
function visionFixture({ focused = true } = {}) {
  return fixture(async method => {
    if (method === 'Page.captureScreenshot') return { data: 'AAAA' };
    if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: 1000, clientHeight: 500 } };
    if (method === 'Runtime.evaluate') return { result: { value: focused } };
    return {};
  }, null, { width: 2000, height: 1000 });
}

test('a screenshot fixes the coordinate space; pointer input is mapped through it and refused before one exists', async () => {
  const f = await visionFixture();
  await f.execute('pointer', { action: 'click', x: 1, y: 1 }).done;
  expect(f.replies.at(-1)).toMatchObject({ status: 'error', error: { code: 'no_screenshot' } });
  await f.execute('screenshot').done;
  const shot = f.replies.at(-1);
  expect(shot.screenshot).toMatchObject({ width: 1280, height: 640, mimeType: 'image/png' }); // 2000×1000 within 1280×800
  expect(shot.result).toMatchObject({ scale: 1.28, viewport: { width: 1000, height: 500 } });
  expect(f.images).toEqual([{ resize: [1280, 640] }]);
  await f.execute('pointer', { action: 'click', x: 640, y: 320, modifiers: ['Control'] }).done;
  expect(f.replies.at(-1)).toMatchObject({ status: 'ok', result: { action: 'click', x: 500, y: 250 } });
  const mouse = f.calls.filter(call => call.method === 'Input.dispatchMouseEvent').map(call => call.args);
  expect(mouse.map(args => args.type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
  expect(mouse[1]).toMatchObject({ x: 500, y: 250, button: 'left', clickCount: 1, modifiers: 2 });
  f.calls.length = 0;
  await f.execute('pointer', { action: 'double_click', x: 0, y: 0 }).done;
  expect(f.calls.filter(call => call.method === 'Input.dispatchMouseEvent').map(call => call.args.clickCount)).toEqual([undefined, 1, 1, 2, 2]);
  f.calls.length = 0;
  await f.execute('pointer', { action: 'right_click', x: 10, y: 10 }).done;
  expect(f.calls.find(call => call.args?.type === 'mousePressed').args).toMatchObject({ button: 'right', buttons: 2 });
  await f.execute('pointer', { action: 'click', x: 1281, y: 10 }).done;
  expect(f.replies.at(-1)).toMatchObject({ status: 'error', error: { code: 'outside_viewport' } });
  expect(f.cursors.at(-1)).toMatchObject({ visible: false });
});

test('drag, coordinate scrolling, zoom and wait work in screenshot space', async () => {
  const f = await visionFixture();
  await f.execute('screenshot').done;
  f.calls.length = 0;
  await f.execute('pointer', { action: 'drag', x: 0, y: 0, toX: 1280, toY: 640 }).done;
  expect(f.replies.at(-1)).toMatchObject({ status: 'ok', result: { action: 'drag', x: 0, y: 0, toX: 1000, toY: 500 } });
  const drag = f.calls.filter(call => call.method === 'Input.dispatchMouseEvent').map(call => call.args);
  expect(drag.map(args => args.type)).toEqual(['mouseMoved', 'mousePressed', 'mouseMoved', 'mouseMoved', 'mouseMoved', 'mouseMoved', 'mouseReleased']);
  expect(drag[3]).toMatchObject({ x: 500, y: 250, buttons: 1 });
  expect(drag.at(-1)).toMatchObject({ x: 1000, y: 500, buttons: 0 });
  f.calls.length = 0;
  await f.execute('scroll', { x: 128, y: 64, deltaY: 300 }).done;
  expect(f.calls.find(call => call.args?.type === 'mouseWheel').args).toMatchObject({ x: 100, y: 50, deltaY: 300 });
  f.images.length = 0;
  await f.execute('zoom', { x0: 0, y0: 0, x1: 640, y1: 320 }).done;
  expect(f.replies.at(-1)).toMatchObject({ status: 'ok', result: { region: [0, 0, 640, 320], scale: 1.563 }, screenshot: { width: 1000, height: 500 } });
  expect(f.images).toEqual([{ crop: { x: 0, y: 0, width: 1000, height: 500 } }]); // half the screenshot is half the capture, kept at device resolution
  await f.execute('zoom', { x0: 1280, y0: 640, x1: 1290, y1: 650 }).done;
  expect(f.replies.at(-1)).toMatchObject({ status: 'error', error: { code: 'outside_viewport' } });
  const started = Date.now();
  await f.execute('wait', { ms: 120 }).done;
  expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  expect(f.replies.at(-1)).toMatchObject({ status: 'ok', result: { waitedMs: 120 } });
});

test('typing without a reference needs a focused editable, and keys cover shifted characters and combinations', async () => {
  const unfocused = await visionFixture({ focused: false });
  await unfocused.execute('type', { text: 'x' }).done;
  expect(unfocused.replies.at(-1)).toMatchObject({ status: 'error', error: { code: 'invalid_target' } });
  expect(unfocused.calls.some(call => call.method === 'Input.insertText')).toBe(false);
  const f = await visionFixture();
  await f.execute('type', { text: 'hello', submit: true }).done;
  expect(f.replies.at(-1)).toMatchObject({ status: 'ok', result: { typed: 5, submitted: true } });
  expect(f.calls.find(call => call.method === 'Input.insertText').args).toEqual({ text: 'hello' });
  f.calls.length = 0;
  await f.execute('press', { key: '?', modifiers: [], repeat: 2 }).done;
  const keys = f.calls.filter(call => call.method === 'Input.dispatchKeyEvent').map(call => call.args);
  expect(keys).toHaveLength(4);
  expect(keys[0]).toMatchObject({ type: 'keyDown', key: '?', code: 'Slash', windowsVirtualKeyCode: 191, modifiers: 8, text: '?' });
  f.calls.length = 0;
  await f.execute('press', { key: 's', modifiers: ['Control'] }).done;
  const combo = f.calls.find(call => call.method === 'Input.dispatchKeyEvent').args;
  expect(combo).toMatchObject({ key: 's', code: 'KeyS', modifiers: 2 });
  expect(combo.text).toBeUndefined();
  f.calls.length = 0;
  await f.execute('press', { key: 'F5', modifiers: [] }).done;
  expect(f.calls.find(call => call.method === 'Input.dispatchKeyEvent').args).toMatchObject({ key: 'F5', code: 'F5', windowsVirtualKeyCode: 116 });
});

test('read-only browser work shows a busy cursor before any pointer input and clears on cancellation', async () => {
  for (const cancel of [false, true]) {
    /** @type {(value?: any) => void} */
    let release;
    const f = await fixture(async method => method === 'Accessibility.enable' ? new Promise(resolve => { release = resolve; }) : {});
    const call = f.execute('snapshot');
    for (let i = 0; !release && i < 100; i++) await Bun.sleep(1);
    expect(release).toBeDefined();
    expect(f.cursors.at(-1)).toMatchObject({ guestId: 1, visible: true, busy: true, action: 'inspect' });
    expect(f.calls.some(call => call.method.startsWith('Input.'))).toBe(false);
    if (cancel) f.agent.handleCancel(call);
    release({});
    await call.done;
    expect(f.cursors.at(-1)).toMatchObject(cancel ? { visible: false } : { visible: true, busy: false, action: 'inspect' });
    f.agent.onDisconnected();
    expect(f.cursors.at(-1).visible).toBe(false);
  }
});

test('browser input waits for approval, resumes on close, and cancelled input never resumes', async () => {
  for (const cancel of [false, true]) {
    const dialogs = new HostDialogs();
    const f = await fixture(undefined, dialogs);
    dialogs.set(true);
    const call = f.execute('press', {key:'Enter'});
    await Bun.sleep(1);
    expect(f.replies).toHaveLength(0);
    expect(f.calls.some(call => call.method.startsWith('Input.'))).toBe(false);
    if (cancel) f.agent.handleCancel(call);
    dialogs.set(false);
    await call.done;
    expect(f.replies.at(-1).status).toBe(cancel ? 'cancelled' : 'ok');
    expect(f.calls.some(call => call.method.startsWith('Input.'))).toBe(!cancel);
    expect(dialogs.listeners.size).toBe(0);
  }
});

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
