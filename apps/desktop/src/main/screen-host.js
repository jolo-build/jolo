// Host-side whole-desktop control: registers this Mac's display with the engine and executes admitted
// screen operations. Captures come from Electron; mouse and keyboard go through `engine screen-input`.
// The engine owns consent and intent; this module owns what only the desktop can know: where the
// screen is, whether the user has taken the mouse back, and the key that stops everything.
import { SCREEN_OPERATIONS, FRAME_MAX_BYTES } from '@jolo/protocol';

const SCREENSHOT_MAX_WIDTH = 1280;
const SCREENSHOT_MAX_HEIGHT = 800;
// Leave room for base64 expansion and the RPC envelope, as the browser host does.
const IMAGE_MAX_BYTES = Math.min(1024 * 1024, Math.floor((FRAME_MAX_BYTES - 16 * 1024) * 3 / 4));
export const STOP_ACCELERATOR = 'Alt+Escape';
// How long the overlay stays after the last operation of a run that has not ended yet.
const OVERLAY_IDLE_MS = 20_000;
// Input the user made within this margin of the agent's own last action is treated as the agent's.
const INPUT_MARGIN_S = 0.15;
const LABELS = { screenshot: 'Looking', zoom: 'Looking closer', pointer: 'Clicking', type: 'Typing', press: 'Pressing keys', scroll: 'Scrolling', wait: 'Waiting', windows: 'Finding windows', activate: 'Switching apps' };
const POINTER_LABELS = { move: 'Moving', drag: 'Dragging', double_click: 'Double-clicking', triple_click: 'Triple-clicking', right_click: 'Right-clicking', middle_click: 'Clicking' };
const ENDED = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'paused']);

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(undefined); }, ms);
  const onAbort = () => { clearTimeout(timer); reject(Object.assign(new Error('cancelled'), { code: 'cancelled' })); };
  signal?.addEventListener('abort', onAbort, { once: true });
});
const fail = (code, message) => Object.assign(new Error(message), { code });

/** The screenshot size for a display: its pixels, fitted inside the screenshot bounds. */
export function screenshotSize(display) {
  const width = Math.round(display.bounds.width * display.scaleFactor), height = Math.round(display.bounds.height * display.scaleFactor);
  const scale = Math.min(1, SCREENSHOT_MAX_WIDTH / width, SCREENSHOT_MAX_HEIGHT / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Screenshot pixels → global display points, through the geometry the model saw. */
export function toDisplayPoint(space, x, y) {
  if (x > space.width || y > space.height) throw fail('outside_screen', `(${x}, ${y}) lies outside the ${space.width}×${space.height} screenshot`);
  return { x: space.bounds.x + x * space.bounds.width / space.width, y: space.bounds.y + y * space.bounds.height / space.height };
}

/** Global display points → screenshot pixels. */
export function toScreenshotRect(space, rect) {
  const sx = space.width / space.bounds.width, sy = space.height / space.bounds.height;
  return { x: Math.round((rect.x - space.bounds.x) * sx), y: Math.round((rect.y - space.bounds.y) * sy), width: Math.round(rect.width * sx), height: Math.round(rect.height * sy) };
}

/** JPEG within the connection's byte cap: lower quality first, then fewer pixels. */
export function encodeImage(image, maxBytes = IMAGE_MAX_BYTES) {
  let current = image;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    for (const quality of [82, 68, 55]) {
      const bytes = current.toJPEG(quality);
      if (bytes.length <= maxBytes) {
        const size = current.getSize();
        return { base64: bytes.toString('base64'), width: size.width, height: size.height, mimeType: 'image/jpeg' };
      }
    }
    const size = current.getSize();
    current = current.resize({ width: Math.max(1, Math.round(size.width * 0.8)), height: Math.max(1, Math.round(size.height * 0.8)), quality: 'good' });
  }
  throw fail('limit_exceeded', 'the screenshot could not be reduced to fit the engine connection');
}

/**
 * @param {{
 *   bridge: { rawCall: (method: string, params: any) => Promise<any> },
 *   log: any,
 *   electron: { desktopCapturer: any, screen: any, globalShortcut: any, systemPreferences: any },
 *   overlay: { show: Function, hide: Function, beforeCapture: Function, afterCapture: Function, destroy: Function },
 *   input: { request: (cmd: string, args?: any) => Promise<any>, close: () => void },
 *   reveal?: (reason: string) => void,
 *   now?: () => number,
 * }} deps
 */
export function createScreenHost({ bridge, log, electron, overlay, input, reveal = () => {}, now = Date.now }) {
  const { desktopCapturer, screen, globalShortcut, systemPreferences } = electron;
  let capabilityId = null;
  let queue = Promise.resolve();
  /** @type {Map<string, { controller: AbortController, runId: string }>} */
  const inflight = new Map();
  /** @type {Map<string, { runId: string, displayId: number, space: any, lastActionAt: number | null }>} */
  const sessions = new Map();
  let active = null; // the run currently shown in the overlay
  let idleTimer = null;

  const displayFor = (session) => screen.getAllDisplays().find(display => display.id === session.displayId) ?? screen.getPrimaryDisplay();
  const permissions = async () => {
    const helper = await input.request('status').catch(error => { log.warn('screen input status failed', { error: String(error?.message ?? error) }); return { accessibility: false, screenRecording: false }; });
    const capture = systemPreferences.getMediaAccessStatus?.('screen');
    return { accessibility: Boolean(helper.accessibility), screenRecording: capture ? capture === 'granted' : Boolean(helper.screenRecording) };
  };

  const stop = () => {
    const runId = active;
    if (!runId) return;
    for (const entry of inflight.values()) if (entry.runId === runId) entry.controller.abort();
    void bridge.rawCall('run.cancel', { runId }).catch(error => log.warn('stopping the screen run failed', { error: String(error?.message ?? error) }));
    end(runId, { revealReason: 'stopped' });
  };
  const begin = (runId, display) => {
    if (active !== runId) {
      if (active) end(active);
      active = runId;
      try { if (!globalShortcut.isRegistered(STOP_ACCELERATOR)) globalShortcut.register(STOP_ACCELERATOR, stop); }
      catch (error) { log.warn('could not register the screen stop key', { error: String(error?.message ?? error) }); }
    }
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (active === runId) end(runId, { keepSession: true }); }, OVERLAY_IDLE_MS);
    idleTimer.unref?.();
    return display;
  };
  const end = (runId, { keepSession = false, revealReason = null } = {}) => {
    if (!keepSession) sessions.delete(runId);
    if (active === runId) {
      active = null;
      clearTimeout(idleTimer);
      try { globalShortcut.unregister(STOP_ACCELERATOR); } catch { /* already gone */ }
      void overlay.hide();
    }
    if (revealReason) {
      try { reveal(revealReason); }
      catch (error) { log.warn('could not return to Jolo after screen control', { error: String(error?.message ?? error) }); }
    }
  };
  const showAt = (display, point, label, click = false) => overlay.show(display, { ...(point ? { x: point.x, y: point.y } : {}), label: `Jolo · ${label}`, click }).catch(() => {});

  async function capture(display, size, signal) {
    await overlay.beforeCapture();
    try {
      signal.throwIfAborted();
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
      const source = sources.find(entry => String(entry.display_id) === String(display.id)) ?? (sources.length === 1 ? sources[0] : null);
      const image = source?.thumbnail;
      if (!image || image.isEmpty()) throw fail('missing_screen_recording', 'Jolo cannot see the screen: turn on Jolo in System Settings → Privacy & Security → Screen & System Audio Recording, then restart Jolo');
      return image;
    } finally { overlay.afterCapture(); }
  }

  const needSpace = (session, display) => {
    if (!session.space) throw fail('no_screenshot', 'take a screen_screenshot first; coordinates are pixels of the latest screenshot');
    const bounds = display.bounds;
    if (bounds.x !== session.space.bounds.x || bounds.y !== session.space.bounds.y || bounds.width !== session.space.bounds.width || bounds.height !== session.space.bounds.height) throw fail('stale_screenshot', 'the display changed since the last screenshot; take a new screen_screenshot');
    return session.space;
  };

  async function operate(session, operation, args, signal) {
    const display = displayFor(session);
    const cursor = () => screen.getCursorScreenPoint();
    switch (operation) {
      case 'screenshot': {
        await showAt(display, cursor(), LABELS.screenshot);
        const image = await capture(display, screenshotSize(display), signal);
        const screenshot = encodeImage(image);
        session.space = { width: screenshot.width, height: screenshot.height, bounds: { ...display.bounds } };
        const point = cursor();
        const inside = point.x >= display.bounds.x && point.y >= display.bounds.y && point.x < display.bounds.x + display.bounds.width && point.y < display.bounds.y + display.bounds.height;
        const at = inside ? toScreenshotRect(session.space, { x: point.x, y: point.y, width: 0, height: 0 }) : null;
        return { result: { width: screenshot.width, height: screenshot.height, display: { width: display.bounds.width, height: display.bounds.height, scale: display.scaleFactor }, ...(at ? { cursor: { x: at.x, y: at.y } } : {}) }, screenshot };
      }
      case 'zoom': {
        const space = needSpace(session, display);
        await showAt(display, cursor(), LABELS.zoom);
        const full = { width: Math.round(display.bounds.width * display.scaleFactor), height: Math.round(display.bounds.height * display.scaleFactor) };
        const image = await capture(display, full, signal);
        const actual = image.getSize();
        const factor = actual.width / space.width;
        const clamp = (value, max) => Math.max(0, Math.min(max, Math.round(value * factor)));
        const rect = { x: clamp(args.x0, actual.width), y: clamp(args.y0, actual.height) };
        rect.width = clamp(args.x1, actual.width) - rect.x;
        rect.height = clamp(args.y1, actual.height) - rect.y;
        if (rect.width < 1 || rect.height < 1) throw fail('outside_screen', `the region lies outside the ${space.width}×${space.height} screenshot`);
        const cropped = image.crop(rect);
        const size = cropped.getSize();
        const fit = Math.min(1, SCREENSHOT_MAX_WIDTH / size.width, SCREENSHOT_MAX_HEIGHT / size.height);
        const screenshot = encodeImage(fit < 1 ? cropped.resize({ width: Math.round(size.width * fit), height: Math.round(size.height * fit), quality: 'good' }) : cropped);
        return { result: { region: [args.x0, args.y0, args.x1, args.y1], scale: Math.round(screenshot.width / (args.x1 - args.x0) * 1000) / 1000 }, screenshot };
      }
      case 'pointer': {
        const space = needSpace(session, display);
        const to = toDisplayPoint(space, args.x, args.y);
        const dragTo = args.action === 'drag' ? toDisplayPoint(space, args.toX, args.toY) : null;
        await showAt(display, to, POINTER_LABELS[args.action] ?? LABELS.pointer);
        await input.request('pointer', { action: args.action, from: cursor(), to, dragTo, modifiers: args.modifiers ?? [] });
        if (dragTo) await showAt(display, dragTo, POINTER_LABELS.drag);
        if (args.action !== 'move') await showAt(display, dragTo ?? to, POINTER_LABELS[args.action] ?? LABELS.pointer, true);
        return { result: { action: args.action, x: args.x, y: args.y, ...(dragTo ? { toX: args.toX, toY: args.toY } : {}) } };
      }
      case 'type': {
        await showAt(display, cursor(), LABELS.type);
        await input.request('type', { text: args.text });
        return { result: { typed: args.text.length } };
      }
      case 'press': {
        await showAt(display, cursor(), LABELS.press);
        await input.request('press', { key: args.key, modifiers: args.modifiers ?? [], repeat: args.repeat ?? 1 });
        return { result: { key: args.key, modifiers: args.modifiers ?? [], repeat: args.repeat ?? 1 } };
      }
      case 'scroll': {
        const at = args.x !== undefined ? toDisplayPoint(needSpace(session, display), args.x, args.y) : null;
        await showAt(display, at ?? cursor(), LABELS.scroll);
        await input.request('scroll', { at, deltaX: args.deltaX ?? 0, deltaY: args.deltaY ?? 0 });
        return { result: { deltaX: args.deltaX ?? 0, deltaY: args.deltaY ?? 0, ...(at ? { x: args.x, y: args.y } : {}) } };
      }
      case 'wait': {
        await showAt(display, cursor(), LABELS.wait);
        await sleep(args.ms ?? 1000, signal);
        return { result: { waitedMs: args.ms ?? 1000 } };
      }
      case 'windows': {
        await showAt(display, cursor(), LABELS.windows);
        const space = session.space ?? { ...screenshotSize(display), bounds: { ...display.bounds } };
        const { windows } = await input.request('windows', { includeOffscreen: Boolean(args.includeOffscreen) });
        const visible = windows.map(window => ({ app: window.app, title: window.title, pid: window.pid, onscreen: window.onscreen, bounds: toScreenshotRect(space, window.bounds) }))
          .filter(window => window.bounds.x < space.width && window.bounds.y < space.height && window.bounds.x + window.bounds.width > 0 && window.bounds.y + window.bounds.height > 0);
        return { result: { windows: visible, space: { width: space.width, height: space.height }, ...(session.space ? {} : { note: 'bounds are in the space the next screenshot will use' }) } };
      }
      case 'activate': {
        await showAt(display, cursor(), LABELS.activate);
        const outcome = await input.request('activate', { pid: args.pid });
        return { result: outcome };
      }
      default:
        throw fail('unsupported', `unsupported screen operation ${operation}`);
    }
  }

  async function handleExecute(params) {
    const reply = body => bridge.rawCall('screen.result', { invocationId: params.invocationId, ...body }).catch(error => log.warn('screen.result rejected', { error: String(error?.message ?? error) }));
    if (!capabilityId || params.capabilityId !== capabilityId) return reply({ status: 'error', error: { code: 'unknown_capability', message: 'this desktop no longer provides the screen' } });
    const controller = new AbortController();
    inflight.set(params.invocationId, { controller, runId: params.runId });
    const lease = setTimeout(() => controller.abort(), params.leaseMs);
    // One screen: operations from every run run strictly in order. The executor runs at once, so
    // the gate's resolve is in hand before anything awaits.
    const previous = queue;
    /** @type {(value?: unknown) => void} */
    let unlock = () => {};
    const gate = new Promise(resolve => { unlock = resolve; });
    queue = previous.then(() => gate);
    try {
      await previous;
      controller.signal.throwIfAborted();
      let session = sessions.get(params.runId);
      if (!session) {
        const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
        session = { runId: params.runId, displayId: display.id, space: null, lastActionAt: null };
        sessions.set(params.runId, session);
      }
      // The user touched the mouse or keyboard since the agent's previous action: hand the screen back.
      if (session.lastActionAt !== null) {
        const { seconds } = await input.request('idle');
        if (seconds < (now() - session.lastActionAt) / 1000 - INPUT_MARGIN_S) {
          session.lastActionAt = null;
          end(params.runId, { keepSession: true });
          return reply({ status: 'interrupted', error: { code: 'user_input', message: 'The user used the mouse or keyboard, so Jolo stopped controlling the screen. Wait for the user to resume the task, then take a new screenshot before acting.' } });
        }
      }
      begin(params.runId, displayFor(session));
      const outcome = await operate(session, params.operation, params.arguments ?? {}, controller.signal);
      controller.signal.throwIfAborted();
      session.lastActionAt = now();
      return reply({ status: 'ok', result: outcome.result, ...(outcome.screenshot ? { screenshot: outcome.screenshot } : {}) });
    } catch (error) {
      if (controller.signal.aborted) return reply({ status: 'cancelled', error: { code: 'cancelled', message: 'screen operation cancelled or lease expired' } });
      log.warn('screen operation failed', { operation: params.operation, error: String(error?.message ?? error) });
      return reply({ status: 'error', error: { code: String(error?.code ?? 'screen_error').slice(0, 64), message: String(error?.message ?? error).slice(0, 1000) } });
    } finally {
      clearTimeout(lease);
      inflight.delete(params.invocationId);
      unlock();
    }
  }

  return {
    operations: SCREEN_OPERATIONS,
    async onConnected() {
      try {
        const display = screen.getPrimaryDisplay();
        const result = await bridge.rawCall('screen.register', { platform: 'darwin', display: { id: display.id, width: display.bounds.width, height: display.bounds.height, scale: display.scaleFactor }, operations: [...SCREEN_OPERATIONS], permissions: await permissions() });
        capabilityId = result.capabilityId;
        log.info('screen capability registered', { capabilityId });
      } catch (error) {
        capabilityId = null;
        log.warn('screen registration failed', { error: String(error?.message ?? error) });
      }
    },
    onDisconnected() {
      capabilityId = null;
      for (const entry of inflight.values()) entry.controller.abort();
      if (active) end(active);
    },
    handleExecute,
    handleCancel(params) { inflight.get(params.invocationId)?.controller.abort(); },
    /** Hide the overlay and release the stop key as soon as the run holding the screen stops. */
    onEvent(event) {
      if (event.type !== 'run.state' || !ENDED.has(event.payload?.state) || !sessions.has(event.runId)) return;
      const paused = event.payload.state === 'paused';
      // While a run is paused the user has the machine, and resuming it takes a click in Jolo: the
      // next action starts a fresh input baseline instead of reading that click as a takeover.
      if (paused) sessions.get(event.runId).lastActionAt = null;
      end(event.runId, { keepSession: paused, revealReason: event.payload.state });
    },
    stop,
    dispose() {
      if (active) end(active);
      overlay.destroy();
      input.close();
    },
  };
}
