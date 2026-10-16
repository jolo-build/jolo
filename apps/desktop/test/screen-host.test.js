import { expect, test } from 'bun:test';
import { createScreenHost, encodeImage, screenshotSize, STOP_ACCELERATOR, toDisplayPoint, toScreenshotRect } from '../src/main/screen-host.js';

/**
 * A native image standing in for Electron's. JPEG size shrinks with quality and pixels, at roughly a
 * real desktop's density: a 1280×800 capture fits the connection at the first quality.
 */
function fakeImage(width, height, log = [], density = 1000) {
  return {
    getSize: () => ({ width, height }),
    isEmpty: () => width === 0,
    toJPEG: quality => Buffer.alloc(Math.round(width * height * quality / density)),
    resize: ({ width: w, height: h }) => { log.push({ resize: [w, h] }); return fakeImage(w, h, log); },
    crop: rect => { log.push({ crop: rect }); return fakeImage(rect.width, rect.height, log); },
  };
}

/** A second display to the right of the main one, so global points and screenshot pixels differ. */
const DISPLAY = { id: 7, bounds: { x: 1800, y: 0, width: 1600, height: 1000 }, scaleFactor: 2 };

function fixture({ idleSeconds = 999, clock = { now: 1_000 }, empty = false, screenRecording = 'granted' } = {}) {
  const calls = [], replies = [], overlay = [], inputs = [], shortcuts = new Map(), images = [], reveals = [];
  const bridge = { async rawCall(method, params) { calls.push({ method, params }); if (method === 'screen.result') replies.push(params); return method === 'screen.register' ? { capabilityId: 'scr_1' } : {}; } };
  const electron = {
    desktopCapturer: { async getSources({ thumbnailSize }) { images.push(thumbnailSize); return [{ display_id: String(DISPLAY.id), thumbnail: fakeImage(empty ? 0 : thumbnailSize.width, thumbnailSize.height, images) }]; } },
    screen: { getAllDisplays: () => [DISPLAY], getPrimaryDisplay: () => DISPLAY, getDisplayNearestPoint: () => DISPLAY, getCursorScreenPoint: () => ({ x: 1900, y: 100 }) },
    globalShortcut: { register: (key, fn) => shortcuts.set(key, fn), unregister: key => shortcuts.delete(key), isRegistered: key => shortcuts.has(key) },
    systemPreferences: { getMediaAccessStatus: () => screenRecording },
  };
  const input = { async request(cmd, args) { inputs.push({ cmd, ...args }); if (cmd === 'idle') return { seconds: idleSeconds }; if (cmd === 'status') return { accessibility: true, screenRecording: true }; if (cmd === 'windows') return { windows: [{ app: 'Helium', title: 'Google', pid: 42, onscreen: true, bounds: { x: 1800, y: 50, width: 800, height: 500 } }, { app: 'Mail', title: '', pid: 9, onscreen: true, bounds: { x: 0, y: 0, width: 900, height: 900 } }] }; return { ok: true }; }, close() {} };
  const overlayFake = { show: async (display, patch) => { overlay.push({ show: patch }); }, hide: async () => { overlay.push({ hide: true }); }, beforeCapture: async () => overlay.push({ capture: 'before' }), afterCapture: () => overlay.push({ capture: 'after' }), destroy() {} };
  const host = createScreenHost({ bridge, log: { info() {}, warn() {} }, electron, overlay: overlayFake, input, reveal: reason => reveals.push(reason), now: () => clock.now });
  let sequence = 0;
  const execute = (operation, args = {}, runId = 'run_1') => host.handleExecute({ invocationId: `i${++sequence}`, capabilityId: 'scr_1', runId, operation, arguments: args, leaseMs: 5_000 }).then(() => replies.at(-1));
  return { host, calls, replies, overlay, inputs, shortcuts, images, reveals, clock, execute };
}

test('geometry: screenshots fit the bounds, and pixels map to global display points and back', () => {
  expect(screenshotSize(DISPLAY)).toEqual({ width: 1280, height: 800 });
  const space = { width: 1280, height: 800, bounds: DISPLAY.bounds };
  expect(toDisplayPoint(space, 640, 400)).toEqual({ x: 2600, y: 500 });
  expect(() => toDisplayPoint(space, 1281, 0)).toThrow('outside');
  expect(toScreenshotRect(space, { x: 1800, y: 50, width: 800, height: 500 })).toEqual({ x: 0, y: 40, width: 640, height: 400 });
  const log = [];
  const encoded = encodeImage(fakeImage(1000, 1000, log, 100), 600_000);
  expect(encoded).toMatchObject({ mimeType: 'image/jpeg', width: 1000, height: 1000 }); // quality 55 fits without shrinking
  expect(log).toEqual([]);
  const shrunk = encodeImage(fakeImage(2000, 2000, log, 100), 600_000);
  expect(shrunk.width).toBeLessThan(2000);
  expect(log[0]).toEqual({ resize: [1600, 1600] }); // every quality was tried before losing pixels
});

test('registration reports the display and permissions; a screenshot fixes the space and hides the overlay for the capture', async () => {
  const f = fixture();
  await f.host.onConnected();
  expect(f.calls[0]).toMatchObject({ method: 'screen.register', params: { platform: 'darwin', display: { id: 7, width: 1600, height: 1000, scale: 2 }, permissions: { accessibility: true, screenRecording: true } } });
  expect((await f.execute('pointer', { action: 'click', x: 1, y: 1 }))).toMatchObject({ status: 'error', error: { code: 'no_screenshot' } });
  const shot = await f.execute('screenshot');
  expect(shot).toMatchObject({ status: 'ok', result: { width: 1280, height: 800, cursor: { x: 80, y: 80 } }, screenshot: { mimeType: 'image/jpeg', width: 1280, height: 800 } });
  expect(f.images[0]).toEqual({ width: 1280, height: 800 });
  const captures = f.overlay.filter(entry => entry.capture).map(entry => entry.capture);
  expect(captures).toEqual(['before', 'after']);
  expect(f.shortcuts.has(STOP_ACCELERATOR)).toBe(true);
});

test('pointer, drag, scroll, type and keys go to the input helper in global points', async () => {
  const f = fixture();
  await f.host.onConnected();
  await f.execute('screenshot');
  await f.execute('pointer', { action: 'click', x: 640, y: 400, modifiers: ['Meta'] });
  expect(f.inputs.find(i => i.cmd === 'pointer')).toMatchObject({ action: 'click', from: { x: 1900, y: 100 }, to: { x: 2600, y: 500 }, dragTo: null, modifiers: ['Meta'] });
  expect(f.overlay.some(entry => entry.show?.click && entry.show.x === 2600)).toBe(true);
  await f.execute('pointer', { action: 'drag', x: 0, y: 0, toX: 1280, toY: 800 });
  expect(f.inputs.filter(i => i.cmd === 'pointer').at(-1)).toMatchObject({ to: { x: 1800, y: 0 }, dragTo: { x: 3400, y: 1000 } });
  await f.execute('scroll', { x: 128, y: 80, deltaY: 300 });
  expect(f.inputs.find(i => i.cmd === 'scroll')).toMatchObject({ at: { x: 1960, y: 100 }, deltaX: 0, deltaY: 300 });
  await f.execute('type', { text: 'cypho.io' });
  await f.execute('press', { key: 'Enter', modifiers: [], repeat: 1 });
  expect(f.inputs.filter(i => ['type', 'press'].includes(i.cmd))).toEqual([{ cmd: 'type', text: 'cypho.io' }, { cmd: 'press', key: 'Enter', modifiers: [], repeat: 1 }]);
  expect(f.replies.every(reply => reply.status === 'ok')).toBe(true);
});

test('zoom crops the full-resolution capture; windows come back in screenshot pixels on this display only', async () => {
  const f = fixture();
  await f.host.onConnected();
  await f.execute('screenshot');
  f.images.length = 0;
  const zoom = await f.execute('zoom', { x0: 0, y0: 0, x1: 640, y1: 400 });
  expect(f.images[0]).toEqual({ width: 3200, height: 2000 });
  expect(f.images.find(entry => entry.crop)).toEqual({ crop: { x: 0, y: 0, width: 1600, height: 1000 } });
  expect(zoom).toMatchObject({ status: 'ok', screenshot: { width: 1280, height: 800 } });
  const windows = await f.execute('windows');
  expect(windows.result.windows).toEqual([{ app: 'Helium', title: 'Google', pid: 42, onscreen: true, bounds: { x: 0, y: 40, width: 640, height: 400 } }]);
});

test('input from the user since the previous action hands the screen back; input older than it does not', async () => {
  const clock = { now: 1_000 };
  const busy = fixture({ idleSeconds: 0.5, clock });
  await busy.host.onConnected();
  await busy.execute('screenshot'); // first action: no baseline, never interrupted
  clock.now += 5_000; // five seconds of agent thinking; the user moved the mouse half a second ago
  expect(await busy.execute('pointer', { action: 'click', x: 1, y: 1 })).toMatchObject({ status: 'interrupted', error: { code: 'user_input' } });
  expect(busy.inputs.some(i => i.cmd === 'pointer')).toBe(false);
  expect(busy.shortcuts.has(STOP_ACCELERATOR)).toBe(false);
  // After the pause, the resumed task starts a fresh baseline instead of tripping again.
  expect(await busy.execute('screenshot')).toMatchObject({ status: 'ok' });
  const idle = fixture({ idleSeconds: 30, clock: { now: 1_000 } });
  await idle.host.onConnected();
  await idle.execute('screenshot');
  expect(await idle.execute('screenshot')).toMatchObject({ status: 'ok' });
});

test('a paused task hands the screen back: the click that resumes it is not read as a takeover', async () => {
  const clock = { now: 1_000 };
  const f = fixture({ idleSeconds: 0.5, clock });
  await f.host.onConnected();
  await f.execute('screenshot');
  f.host.onEvent({ type: 'run.state', runId: 'run_1', payload: { state: 'paused' } }); // e.g. a command needs approval
  expect(f.overlay.at(-1)).toEqual({ hide: true });
  expect(f.reveals).toEqual(['paused']);
  clock.now += 30_000; // the user clicks Allow in Jolo half a second before the next action
  expect(await f.execute('pointer', { action: 'click', x: 1, y: 1 })).toMatchObject({ status: 'ok' });
  expect(f.inputs.some(i => i.cmd === 'pointer')).toBe(true);
});

test('a terminal state returns to Jolo after the control overlay was already released', async () => {
  const f = fixture();
  await f.host.onConnected();
  await f.execute('screenshot');
  f.host.onEvent({ type: 'run.state', runId: 'run_1', payload: { state: 'paused' } });
  f.host.onEvent({ type: 'run.state', runId: 'run_1', payload: { state: 'cancelled' } });
  expect(f.reveals).toEqual(['paused', 'cancelled']);
});

test('Option+Escape cancels the run holding the screen, and a finished run releases the key and overlay', async () => {
  const f = fixture();
  await f.host.onConnected();
  await f.execute('screenshot');
  f.shortcuts.get(STOP_ACCELERATOR)();
  expect(f.calls.find(call => call.method === 'run.cancel')?.params).toEqual({ runId: 'run_1' });
  expect(f.shortcuts.has(STOP_ACCELERATOR)).toBe(false);
  expect(f.overlay.at(-1)).toEqual({ hide: true });
  expect(f.reveals).toEqual(['stopped']);
  const g = fixture();
  await g.host.onConnected();
  await g.execute('screenshot', {}, 'run_2');
  g.host.onEvent({ type: 'run.state', runId: 'run_2', payload: { state: 'completed' } });
  expect(g.shortcuts.has(STOP_ACCELERATOR)).toBe(false);
  expect(g.overlay.at(-1)).toEqual({ hide: true });
  expect(g.reveals).toEqual(['completed']);
  // A new run on the same desktop must take its own screenshot: coordinates never carry across runs.
  expect(await g.execute('pointer', { action: 'click', x: 1, y: 1 }, 'run_2')).toMatchObject({ error: { code: 'no_screenshot' } });
});

test('an empty capture reports the missing Screen Recording permission', async () => {
  const f = fixture({ empty: true, screenRecording: 'denied' });
  await f.host.onConnected();
  expect(f.calls[0].params.permissions.screenRecording).toBe(false);
  expect(await f.execute('screenshot')).toMatchObject({ status: 'error', error: { code: 'missing_screen_recording' } });
  expect(await f.host.handleExecute({ invocationId: 'x', capabilityId: 'someone_else', runId: 'r', operation: 'screenshot', arguments: {}, leaseMs: 100 }).then(() => f.replies.at(-1))).toMatchObject({ error: { code: 'unknown_capability' } });
});
