// Host-side agent browser control: registers capabilities with the engine and
// executes admitted operations over the guest's debugger. Raw CDP never leaves this module.
import { projectAX } from "./ax-projection.js";
import { BROWSER_OPERATIONS, FRAME_MAX_BYTES } from '@jolo/protocol';

const OPERATIONS = BROWSER_OPERATIONS;
// Engines already running during a desktop update may predate computer use.
// This is the exact operation set accepted before hello advertised capabilities.
const LEGACY_OPERATIONS = ['navigate', 'snapshot', 'click', 'type', 'screenshot', 'network', 'fill', 'press', 'scroll', 'hover', 'select', 'history'];
const INPUT_OPERATIONS = new Set(['click', 'type', 'fill', 'press', 'scroll', 'hover', 'select', 'pointer']);
const CURSOR_ACTIONS = { navigate: 'navigate', history: 'navigate', snapshot: 'inspect', screenshot: 'screenshot', zoom: 'screenshot', network: 'network', wait: 'working' };
const NETWORK_RING = 200;
const SCREENSHOT_MAX_WIDTH = 1280;
const SCREENSHOT_MAX_HEIGHT = 800;
// Leave room for base64 expansion and the RPC envelope in both directions.
const SCREENSHOT_MAX_BYTES = Math.min(1024 * 1024, Math.floor((FRAME_MAX_BYTES - 16 * 1024) * 3 / 4));
const MODIFIER_FLAGS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
const MOUSE_BUTTONS = { left: 1, right: 2, middle: 4 };
// Key names the engine validates, as Chromium's `key`, `code` and Windows virtual key codes (§5.3).
const KEY_CODES = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, Insert: 45, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, PageUp: 33, PageDown: 34, Space: 32, ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, 112 + i])) };
const PUNCTUATION = { '`': ['Backquote', 192], '-': ['Minus', 189], '=': ['Equal', 187], '[': ['BracketLeft', 219], ']': ['BracketRight', 221], '\\': ['Backslash', 220], ';': ['Semicolon', 186], "'": ['Quote', 222], ',': ['Comma', 188], '.': ['Period', 190], '/': ['Slash', 191] };
const SHIFTED = { '~': '`', '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0', '_': '-', '+': '=', '{': '[', '}': ']', '|': '\\', ':': ';', '"': "'", '<': ',', '>': '.', '?': '/' };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round3 = value => Math.round(value * 1000) / 1000;
const modifierMask = modifiers => modifiers.reduce((value, modifier) => value | (MODIFIER_FLAGS[modifier] ?? 0), 0);

export function createBrowserAgent({ bridge, log, isOverlayActive, waitForOverlay = null, nativeImage, onCursor = null }) {
  /** @type {Map<number, any>} guest webContents id -> host record */
  const hosts = new Map();
  const inflight = new Map(); // invocationId -> { controller, host }
  const registeredListeners = new Set();
  const registrationFailedListeners = new Set();

  function clearCursor(host) {
    host.cursor = null;
    try { onCursor?.({ guestId: host.guest.id, visible: false }); } catch { /* visual feedback is best effort */ }
  }

  function publishCursor(host, action = host.cursor?.action ?? 'working') {
    if (!onCursor || host.guest.isDestroyed() || host.signal?.aborted || isOverlayActive()) return;
    // Park the indicator near the top left until an operation has a real pointer target.
    host.cursor = { x: .08, y: .08, ...host.cursor, action };
    try { onCursor({ guestId: host.guest.id, visible: true, ...host.cursor, busy: Boolean(host.cursorOperation) }); } catch { /* visual feedback is best effort */ }
  }

  async function showCursor(host, point, action) {
    if (!onCursor) return;
    try {
      const { cssVisualViewport: viewport } = await cdp(host, 'Page.getLayoutMetrics');
      if (isOverlayActive() || host.expectedRevision !== host.navigationRevision) return;
      // Fractions align the host overlay with the guest even when their zoom levels differ.
      host.cursor = { x: point.x / viewport.clientWidth, y: point.y / viewport.clientHeight, action };
      publishCursor(host);
    } catch { /* cursor feedback must never fail an otherwise valid input operation */ }
  }

  async function showNodeCursor(host, backendNodeId, action) {
    if (!onCursor) return;
    try { await showCursor(host, await targetPoint(host, backendNodeId), action); } catch { /* some editable nodes have no visible quad */ }
  }

  const cdp = async (host, method, params = {}) => {
    host.signal?.throwIfAborted();
    if ((method.startsWith('Input.') || method === 'DOM.focus' || method === 'Runtime.callFunctionOn') && host.inputOperation) {
      if (isOverlayActive()) throw Object.assign(new Error('a host dialog is open; browser input is suspended'), { code: 'host_overlay' });
      if (host.expectedRevision !== host.navigationRevision) throw Object.assign(new Error('the page changed; take a new snapshot'), { code: 'stale_reference' });
    }
    const pending = host.guest.debugger.sendCommand(method, params);
    const signal = host.signal;
    if (!signal) return pending;
    let onAbort;
    try {
      return await Promise.race([pending, new Promise((_, reject) => {
        onAbort = () => reject(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      })]);
    } finally { signal.removeEventListener('abort', onAbort); }
  };

  async function register(host) {
    if (host.guest.isDestroyed()) return;
    host.registrationError = null;
    try {
      const supported = bridge.client?.hello?.supportedBrowserOperations ?? LEGACY_OPERATIONS;
      const operations = OPERATIONS.filter(operation => supported.includes(operation));
      if (!operations.length) throw new Error('desktop and engine have no browser controls in common; restart Jolo to update both');
      const result = await bridge.rawCall("browser.register", { workspaceId: host.workspaceId, tabId: host.tabId, navigationRevision: host.navigationRevision, url: host.guest.getURL(), title: host.guest.getTitle(), operations });
      if (host.guest.isDestroyed()) { void bridge.rawCall('browser.unregister', { capabilityId: result.capabilityId }).catch(() => {}); return; }
      host.capabilityId = result.capabilityId;
      for (const listener of registeredListeners) listener(host);
      log.info("browser capability registered", { capabilityId: host.capabilityId, workspaceId: host.workspaceId });
    } catch (error) {
      host.registrationError = `Inline browser registration failed: ${String(error?.message ?? error).slice(0, 800)}`;
      for (const listener of registrationFailedListeners) listener(host);
      log.warn("browser registration failed", { error: String(error?.message ?? error) });
    }
  }

  async function update(host) {
    if (!host.capabilityId || host.guest.isDestroyed()) return;
    try {
      await bridge.rawCall("browser.update", { capabilityId: host.capabilityId, navigationRevision: host.navigationRevision, url: host.guest.getURL(), title: host.guest.getTitle() });
    } catch (error) {
      log.warn("browser update failed", { error: String(error?.message ?? error) });
    }
  }

  function attach(guest, workspaceId) {
    // `screenshotSpace` is the geometry of the latest screenshot: pointer coordinates are read in it (§5.3).
    const host = { guest, workspaceId, tabId: `tab_${guest.id}`, navigationRevision: 0, capabilityId: null, snapshots: [], nextReference: 0, snapshotSequence: 0, queue: Promise.resolve(), network: [], requests: new Map(), screenshotSpace: null };
    hosts.set(guest.id, host);
    // Bounded network observation (§5.3): metadata only, a ring per tab, cleared on navigation.
    guest.debugger.on("message", (_event, method, params) => {
      if (method === "Network.requestWillBeSent") {
        const entry = { requestId: params.requestId, method: params.request?.method ?? "GET", url: String(params.request?.url ?? "").slice(0, 2048), type: params.type ?? "Other", status: null, size: 0, at: new Date().toISOString(), navigationRevision: host.navigationRevision };
        host.requests.set(params.requestId, entry);
        host.network.push(entry);
        if (host.network.length > NETWORK_RING) for (const removed of host.network.splice(0, host.network.length - NETWORK_RING)) host.requests.delete(removed.requestId);
      } else if (method === "Network.responseReceived") {
        const entry = host.requests.get(params.requestId);
        if (entry) { entry.status = params.response?.status ?? null; entry.mimeType = params.response?.mimeType ?? null; }
      } else if (method === "Network.loadingFinished") {
        const entry = host.requests.get(params.requestId);
        if (entry) { entry.size = params.encodedDataLength ?? 0; host.requests.delete(params.requestId); }
      } else if (method === "Network.loadingFailed") {
        const entry = host.requests.get(params.requestId);
        if (entry) { entry.error = String(params.errorText ?? "failed").slice(0, 100); host.requests.delete(params.requestId); }
      }
    });
    cdp(host, "Network.enable", { maxTotalBufferSize: 0, maxResourceBufferSize: 0 }).catch((error) => log.warn("network observation unavailable", { error: String(error?.message ?? error) }));
    const navigated = () => { clearCursor(host); host.navigationRevision += 1; host.snapshots = []; host.network = []; host.requests.clear(); if (host.cursorOperation) publishCursor(host, CURSOR_ACTIONS[host.cursorOperation] ?? 'working'); void update(host); };
    guest.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) clearCursor(host); });
    guest.on("did-navigate", navigated);
    guest.on("did-navigate-in-page", (_event, _url, isMainFrame) => { if (isMainFrame) navigated(); });
    guest.on("page-title-updated", () => void update(host));
    guest.on("render-process-gone", () => { navigated(); for (const entry of inflight.values()) if (entry.host === host) entry.controller.abort(); });
    guest.on("destroyed", () => {
      clearCursor(host);
      hosts.delete(guest.id);
      for (const entry of inflight.values()) if (entry.host === host) entry.controller.abort();
      if (host.capabilityId) bridge.rawCall("browser.unregister", { capabilityId: host.capabilityId }).catch(() => {});
    });
    void register(host);
    return host;
  }

  function findByCapability(capabilityId) {
    for (const host of hosts.values()) if (host.capabilityId === capabilityId) return host;
    return null;
  }

  function resolveReference(host, ref, snapshotId) {
    const candidates = snapshotId ? host.snapshots.filter((s) => s.snapshot.snapshotId === snapshotId) : host.snapshots;
    if (snapshotId && !candidates.length) return { stale: true };
    for (const entry of candidates) {
      if (entry.snapshot.navigationRevision !== host.navigationRevision) return { stale: true };
      const backendNodeId = entry.references.get(ref);
      if (backendNodeId) return { backendNodeId };
    }
    return { stale: host.snapshots.length === 0 || Number(ref.slice(1)) <= host.nextReference, missing: true };
  }

  async function operate(host, operation, args, signal) {
    switch (operation) {
      case "navigate": {
        const url = new URL(args.url);
        if (!["http:", "https:"].includes(url.protocol)) throw Object.assign(new Error("only http(s) URLs can be opened"), { code: "invalid_url" });
        await navigateAndWait(host, () => host.guest.loadURL(url.href), signal);
        await sleep(50);
        return { result: { url: host.guest.getURL(), title: host.guest.getTitle(), navigationRevision: host.navigationRevision } };
      }
      case "snapshot": {
        await cdp(host, "Accessibility.enable");
        try {
          const navigationRevision = host.navigationRevision;
          const { nodes } = await cdp(host, "Accessibility.getFullAXTree");
          if (navigationRevision !== host.navigationRevision) return { stale: true, message: 'the page navigated during the snapshot; take a new snapshot' };
          const snapshotId = `snap_${navigationRevision}_${++host.snapshotSequence}`;
          const projected = projectAX(nodes, { snapshotId, navigationRevision, referenceStart: host.nextReference, maxNodes: args.maxNodes ?? 300, offset: args.offset ?? 0 });
          host.nextReference += projected.snapshot.nodes.length;
          host.snapshots = [projected, ...host.snapshots].slice(0, 2); // active snapshot plus one predecessor (§5.3)
          const metrics = await cdp(host, 'Page.getLayoutMetrics');
          const viewport = metrics.cssLayoutViewport ?? metrics.layoutViewport;
          const content = metrics.cssContentSize ?? metrics.contentSize;
          // Scroll position is a convenience for the model; a snapshot without it is still a valid snapshot.
          const scroll = viewport && content ? { y: viewport.pageY, height: viewport.clientHeight, contentHeight: content.height, atBottom: viewport.pageY + viewport.clientHeight >= content.height - 2 } : undefined;
          return { result: { ...projected.snapshot, url: host.guest.getURL(), title: host.guest.getTitle(), ...(scroll ? { scroll } : {}) } };
        } finally {
          await host.guest.debugger.sendCommand('Accessibility.disable').catch(() => {});
        }
      }
      case "hover":
      case "click": {
        if (isOverlayActive()) throw Object.assign(new Error("a host dialog is open; browser input is suspended"), { code: "host_overlay" });
        const resolved = resolveReference(host, args.ref, args.snapshotId);
        if (resolved.stale) return { stale: true, message: "the page changed since that snapshot; take a new snapshot" };
        if (resolved.missing) throw Object.assign(new Error(`unknown reference ${args.ref}`), { code: "unknown_reference" });
        const point = await targetPoint(host, resolved.backendNodeId);
        await showCursor(host, point, 'move');
        await cdp(host, "Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
        // Mouse input uses viewport coordinates; DOM hit testing uses document coordinates.
        const { cssVisualViewport: viewport } = await cdp(host, 'Page.getLayoutMetrics');
        const hit = await cdp(host, "DOM.getNodeForLocation", { x: Math.round(point.x + viewport.pageX), y: Math.round(point.y + viewport.pageY), ignorePointerEventsNone: false });
        if (!(await contains(host, resolved.backendNodeId, hit.backendNodeId))) throw Object.assign(new Error("the target is obscured by another element"), { code: "obscured" });
        if (operation === 'hover') return { result: { ref: args.ref, ...point, navigationRevision: host.navigationRevision } };
        if (isOverlayActive()) throw Object.assign(new Error("a host dialog opened; browser input is suspended"), { code: "host_overlay" });
        await cdp(host, "Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1 });
        await host.guest.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1 });
        await showCursor(host, point, 'click');
        await sleep(100);
        return { result: { ref: args.ref, x: point.x, y: point.y, navigationRevision: host.navigationRevision, url: host.guest.getURL() } };
      }
      case "fill":
      case "type": {
        if (isOverlayActive()) throw Object.assign(new Error("a host dialog is open; browser input is suspended"), { code: "host_overlay" });
        let filled = false;
        if (args.ref) {
          const resolved = resolveReference(host, args.ref, args.snapshotId);
          if (resolved.stale) return { stale: true, message: "the page changed since that snapshot; take a new snapshot" };
          if (resolved.missing) throw Object.assign(new Error(`unknown reference ${args.ref}`), { code: "unknown_reference" });
          await cdp(host, "DOM.scrollIntoViewIfNeeded", { backendNodeId: resolved.backendNodeId });
          await nodeCall(host, resolved.backendNodeId, function() {
            if (this.disabled || this.readOnly || !(this.isContentEditable || this instanceof HTMLTextAreaElement || (this instanceof HTMLInputElement && ['text','search','email','url','tel','password','number'].includes(this.type)))) throw new Error('target is not an enabled editable field');
            this.focus();
          });
          await showNodeCursor(host, resolved.backendNodeId, 'type');
          if (operation === 'fill') filled = await nodeCall(host, resolved.backendNodeId, function(text) {
            if (!(this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement)) return false;
            // Set the referenced field itself: keyboard focus can return to the
            // host composer while the browser cursor overlay is being updated.
            // Use the native setter so React and other controlled inputs observe
            // the ensuing input event rather than swallowing it as unchanged.
            const prototype = this instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            Object.getOwnPropertyDescriptor(prototype, 'value').set.call(this, text);
            this.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
            this.dispatchEvent(new Event('change', { bubbles: true }));
            if (this.value !== text) throw new Error('the field rejected the supplied value');
            return true;
          }, [args.text]);
        } else await requireFocusedEditable(host); // a pointer click put the caret there
        if (!filled) {
          if (operation === 'fill') await pressKey(host, 'a', [process.platform === 'darwin' ? 'Meta' : 'Control']);
          if (args.text) await cdp(host, "Input.insertText", { text: args.text });
          else if (operation === 'fill') await pressKey(host, 'Backspace', []);
        }
        if (args.submit) {
          await pressKey(host, 'Enter', []);
          await sleep(100);
        }
        return { result: { ...(args.ref ? { ref: args.ref } : {}), typed: args.text.length, submitted: Boolean(args.submit), navigationRevision: host.navigationRevision } };
      }
      case 'press':
      case 'scroll':
      case 'select': {
        let backendNodeId;
        if (args.ref) {
          const resolved = resolveReference(host, args.ref, args.snapshotId);
          if (resolved.stale) return { stale: true, message: 'the page changed; take a new snapshot' };
          if (resolved.missing) throw Object.assign(new Error(`unknown reference ${args.ref}`), { code: 'unknown_reference' });
          backendNodeId = resolved.backendNodeId;
        }
        if (operation === 'press') {
          if (backendNodeId) {
            await cdp(host, 'DOM.scrollIntoViewIfNeeded', { backendNodeId });
            await cdp(host, 'DOM.focus', { backendNodeId });
            await showNodeCursor(host, backendNodeId, 'type');
          }
          for (let count = 0; count < (args.repeat ?? 1); count += 1) await pressKey(host, args.key, args.modifiers ?? []);
        } else if (operation === 'scroll') {
          const viewport = await cssViewport(host);
          const point = backendNodeId ? await targetPoint(host, backendNodeId)
            : args.x !== undefined && args.y !== undefined ? screenshotPoint(host, args.x, args.y, viewport)
            : { x: Math.floor(viewport.width / 2), y: Math.floor(viewport.height / 2) };
          await showCursor(host, point, 'scroll');
          await cdp(host, 'Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: args.deltaX ?? 0, deltaY: args.deltaY ?? 0 });
        } else {
          await cdp(host, 'DOM.scrollIntoViewIfNeeded', { backendNodeId });
          await showNodeCursor(host, backendNodeId, 'click');
          await nodeCall(host, backendNodeId, function(values) {
            if (!(this instanceof HTMLSelectElement) || this.disabled) throw new Error('target is not an enabled native select');
            if (!this.multiple && values.length !== 1) throw new Error('select accepts only one value');
            const options = Array.from(this.options);
            if (values.some(value => !options.some(option => option.value === value && !option.disabled && !option.parentElement?.disabled))) throw new Error('option value is missing or disabled');
            for (const option of options) option.selected = values.includes(option.value);
            this.dispatchEvent(new Event('input', { bubbles: true }));
            this.dispatchEvent(new Event('change', { bubbles: true }));
          }, [args.values]);
        }
        await sleep(100);
        return { result: { ...(args.ref ? { ref: args.ref } : {}), navigationRevision: host.navigationRevision, url: host.guest.getURL() } };
      }
      case 'history': {
        if (args.action === 'reload') await navigateAndWait(host, () => cdp(host, 'Page.reload'), signal);
        else {
          const history = await cdp(host, 'Page.getNavigationHistory');
          const entry = history.entries[history.currentIndex + (args.action === 'back' ? -1 : 1)];
          if (!entry) throw Object.assign(new Error(`cannot go ${args.action}`), { code: 'no_history' });
          await navigateAndWait(host, () => cdp(host, 'Page.navigateToHistoryEntry', { entryId: entry.id }), signal);
        }
        return { result: { url: host.guest.getURL(), title: host.guest.getTitle(), navigationRevision: host.navigationRevision } };
      }
      case "network": {
        const entries = host.network.filter((e) => e.navigationRevision === host.navigationRevision && (!args.filter || e.url.includes(args.filter))).slice(-(args.maxEntries ?? 50)).map((e) => ({ method: e.method, url: e.url, status: e.status, type: e.type, mimeType: e.mimeType ?? null, size: e.size, error: e.error ?? null, at: e.at }));
        return { result: { navigationRevision: host.navigationRevision, url: host.guest.getURL(), entries, truncated: host.network.length >= NETWORK_RING } };
      }
      case "screenshot": {
        const { image, viewport } = await captureViewport(host, signal);
        const screenshot = encodeBounded(image);
        // Later pointer coordinates are read in this image; the CSS size says whether it is still current.
        host.screenshotSpace = { width: screenshot.width, height: screenshot.height, cssWidth: viewport.width, cssHeight: viewport.height };
        const scale = viewport.width > 0 ? round3(screenshot.width / viewport.width) : 1;
        return { result: { url: host.guest.getURL(), title: host.guest.getTitle(), navigationRevision: host.navigationRevision, scale, viewport }, screenshot };
      }
      case 'zoom': {
        const { image, viewport } = await captureViewport(host, signal);
        const size = image.getSize();
        // The region arrives in screenshot pixels; the capture holds the viewport at device resolution.
        const space = host.screenshotSpace && host.screenshotSpace.cssWidth === viewport.width && host.screenshotSpace.cssHeight === viewport.height
          ? host.screenshotSpace : boundedSize(size);
        const factor = size.width / space.width;
        const clamp = (value, max) => Math.max(0, Math.min(max, Math.round(value * factor)));
        const rect = { x: clamp(args.x0, size.width), y: clamp(args.y0, size.height) };
        rect.width = clamp(args.x1, size.width) - rect.x;
        rect.height = clamp(args.y1, size.height) - rect.y;
        if (rect.width < 1 || rect.height < 1) throw Object.assign(new Error(`the region lies outside the ${space.width}×${space.height} screenshot`), { code: 'outside_viewport' });
        const screenshot = encodeBounded(image.crop(rect));
        return { result: { url: host.guest.getURL(), title: host.guest.getTitle(), navigationRevision: host.navigationRevision, region: [args.x0, args.y0, args.x1, args.y1], scale: round3(screenshot.width * factor / rect.width) }, screenshot };
      }
      case 'pointer': {
        if (isOverlayActive()) throw Object.assign(new Error("a host dialog is open; browser input is suspended"), { code: "host_overlay" });
        const viewport = await cssViewport(host);
        const from = screenshotPoint(host, args.x, args.y, viewport);
        const modifiers = modifierMask(args.modifiers ?? []);
        await showCursor(host, from, args.action === 'move' ? 'move' : 'click');
        await cdp(host, "Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y, modifiers });
        if (args.action === 'move') return { result: { action: 'move', ...from, navigationRevision: host.navigationRevision } };
        if (isOverlayActive()) throw Object.assign(new Error("a host dialog opened; browser input is suspended"), { code: "host_overlay" });
        if (args.action === 'drag') {
          const to = screenshotPoint(host, args.toX, args.toY, viewport);
          await cdp(host, "Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1, modifiers });
          for (const step of [0.25, 0.5, 0.75, 1]) await cdp(host, "Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(from.x + (to.x - from.x) * step), y: Math.round(from.y + (to.y - from.y) * step), button: "left", buttons: 1, modifiers });
          // Release even if the drag navigated or the run was just cancelled.
          await host.guest.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1, modifiers });
          await showCursor(host, to, 'click');
          await sleep(100);
          return { result: { action: 'drag', ...from, toX: to.x, toY: to.y, navigationRevision: host.navigationRevision, url: host.guest.getURL() } };
        }
        const button = args.action === 'right_click' ? 'right' : args.action === 'middle_click' ? 'middle' : 'left';
        const clicks = args.action === 'double_click' ? 2 : args.action === 'triple_click' ? 3 : 1;
        for (let count = 1; count <= clicks; count += 1) {
          await cdp(host, "Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button, buttons: MOUSE_BUTTONS[button], clickCount: count, modifiers });
          await host.guest.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: from.x, y: from.y, button, buttons: 0, clickCount: count, modifiers });
        }
        await showCursor(host, from, 'click');
        await sleep(100);
        return { result: { action: args.action, ...from, navigationRevision: host.navigationRevision, url: host.guest.getURL() } };
      }
      case 'wait': {
        const ms = args.ms ?? 1000;
        await new Promise((resolve, reject) => {
          const onAbort = () => { clearTimeout(timer); reject(Object.assign(new Error('cancelled'), { code: 'cancelled' })); };
          const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(undefined); }, ms);
          signal.addEventListener('abort', onAbort, { once: true });
        });
        return { result: { waitedMs: ms, navigationRevision: host.navigationRevision, url: host.guest.getURL() } };
      }
      default:
        throw Object.assign(new Error(`unsupported operation ${operation}`), { code: "unsupported" });
    }
  }

  function navigateAndWait(host, start, signal) {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        host.guest.off('did-finish-load', done); host.guest.off('did-navigate-in-page', inPage);
        host.guest.off('did-fail-load', failed); signal.removeEventListener('abort', onAbort);
      };
      const done = () => { cleanup(); resolve(); };
      const inPage = (_event, _url, mainFrame) => { if (mainFrame) done(); };
      const fail = error => { cleanup(); reject(error); };
      const failed = (_event, code, description, _url, mainFrame) => { if (mainFrame !== false) fail(Object.assign(new Error(`navigation failed: ${description || code}`), { code: 'navigation_failed' })); };
      const onAbort = () => { cleanup(); if (!host.guest.isDestroyed()) host.guest.stop(); reject(Object.assign(new Error('cancelled'), { code: 'cancelled' })); };
      host.guest.on('did-finish-load', done); host.guest.on('did-navigate-in-page', inPage); host.guest.on('did-fail-load', failed);
      signal.addEventListener('abort', onAbort, { once: true });
      Promise.resolve().then(start).catch(fail);
    });
  }

  async function nodeCall(host, backendNodeId, fn, values = []) {
    const { object } = await cdp(host, 'DOM.resolveNode', { backendNodeId });
    try {
      const result = await cdp(host, 'Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: fn.toString(), arguments: values.map(value => ({ value })), returnByValue: true });
      if (result.exceptionDetails) throw Object.assign(new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text), { code: 'invalid_target' });
      return result.result?.value;
    } finally { await host.guest.debugger.sendCommand('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {}); }
  }

  async function pressKey(host, key, modifiers) {
    // A shifted character names its unshifted key with Shift held; the `key` value stays the character.
    const base = SHIFTED[key] ?? key;
    const mask = modifierMask(modifiers) | (SHIFTED[key] || /^[A-Z]$/.test(key) ? MODIFIER_FLAGS.Shift : 0);
    const code = /^[a-z]$/i.test(base) ? `Key${base.toUpperCase()}` : /^\d$/.test(base) ? `Digit${base}` : PUNCTUATION[base]?.[0] ?? base;
    const value = key === 'Space' ? ' ' : key;
    const params = { key: value, code, windowsVirtualKeyCode: KEY_CODES[base] ?? PUNCTUATION[base]?.[1] ?? base.toUpperCase().charCodeAt(0), modifiers: mask };
    const text = (mask & 7) ? '' : key === 'Enter' ? '\r' : value.length === 1 ? value : '';
    await cdp(host, 'Input.dispatchKeyEvent', { type: 'keyDown', ...params, ...(text ? { text } : {}), ...((mask & 6) && key.toLowerCase() === 'a' ? { commands: ['selectAll'] } : {}) });
    // Release even if the key-down navigated or the run was just cancelled.
    await host.guest.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
  }

  async function cssViewport(host) {
    const { cssVisualViewport: viewport } = await cdp(host, 'Page.getLayoutMetrics');
    return { width: viewport.clientWidth, height: viewport.clientHeight };
  }

  /** The element with keyboard focus must be an enabled editable field; a pointer click usually put it there. */
  async function requireFocusedEditable(host) {
    const { result } = await cdp(host, 'Runtime.evaluate', { returnByValue: true, expression: "(() => { const e = document.activeElement; if (!e || e === document.body || e.disabled || e.readOnly) return false; return Boolean(e.isContentEditable || e instanceof HTMLTextAreaElement || (e instanceof HTMLInputElement && ['text','search','email','url','tel','password','number'].includes(e.type))); })()" });
    if (!result?.value) throw Object.assign(new Error('no editable field has keyboard focus; click a field first or pass a snapshot ref'), { code: 'invalid_target' });
  }

  /** Screenshot pixels → CSS pixels of the viewport, through the geometry of the latest screenshot. */
  function screenshotPoint(host, x, y, viewport) {
    const space = host.screenshotSpace;
    if (!space) throw Object.assign(new Error('take a browser_screenshot first; coordinates are pixels of the latest screenshot'), { code: 'no_screenshot' });
    if (space.cssWidth !== viewport.width || space.cssHeight !== viewport.height) throw Object.assign(new Error('the viewport changed since the last screenshot; take a new browser_screenshot'), { code: 'stale_screenshot' });
    if (x > space.width || y > space.height) throw Object.assign(new Error(`(${x}, ${y}) lies outside the ${space.width}×${space.height} screenshot`), { code: 'outside_viewport' });
    return { x: Math.round(x * viewport.width / space.width), y: Math.round(y * viewport.height / space.height) };
  }

  /** The size a capture is shown at: within the screenshot bounds, aspect preserved. */
  function boundedSize({ width, height }) {
    const scale = Math.min(1, SCREENSHOT_MAX_WIDTH / width, SCREENSHOT_MAX_HEIGHT / height);
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
  }

  /** One capture at a time per host (§5.3). CDP capture first; Electron's capturePage as the fallback. */
  async function captureViewport(host, signal) {
    if (host.capturing) throw Object.assign(new Error("another capture is in flight"), { code: "busy" });
    host.capturing = true;
    try {
      const withTimeout = async (promise, ms, label) => {
        let timer;
        try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(`${label} timed out`), { code: 'capture_timeout' })), ms); })]); }
        finally { clearTimeout(timer); }
      };
      let image;
      host.guest.invalidate(); // schedule a repaint so an idle compositor still produces a frame
      try {
        const shot = await withTimeout(cdp(host, "Page.captureScreenshot", { format: "png", fromSurface: true }), 8_000, "CDP capture");
        image = nativeImage.createFromBuffer(Buffer.from(shot.data, "base64"));
      } catch (error) {
        if (signal.aborted) throw error;
        log.warn("CDP capture failed; falling back to capturePage", { error: String(error?.message ?? error) });
        image = await withTimeout(host.guest.capturePage(), 8_000, "capturePage");
      }
      return { image, viewport: await cssViewport(host) };
    } finally {
      host.capturing = false;
    }
  }

  /** Encode within the screenshot bounds and the connection's byte cap, shrinking until it fits. */
  function encodeBounded(image) {
    const { width, height } = image.getSize();
    let scale = Math.min(1, SCREENSHOT_MAX_WIDTH / width, SCREENSHOT_MAX_HEIGHT / height);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const resized = scale < 1 ? image.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: "good" }) : image;
      const png = resized.toPNG();
      if (png.length <= SCREENSHOT_MAX_BYTES) {
        const size = resized.getSize();
        return { base64: png.toString("base64"), width: size.width, height: size.height, mimeType: "image/png" };
      }
      scale *= 0.7;
    }
    throw Object.assign(new Error('screenshot could not be reduced to fit the browser connection'), { code: 'limit_exceeded' });
  }

  async function targetPoint(host, backendNodeId) {
    await cdp(host, "DOM.scrollIntoViewIfNeeded", { backendNodeId });
    const { quads } = await cdp(host, "DOM.getContentQuads", { backendNodeId });
    const { cssVisualViewport: viewport } = await cdp(host, "Page.getLayoutMetrics");
    const point = quads.map((q) => ({ x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 })).find((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.y >= 0 && p.x < viewport.clientWidth && p.y < viewport.clientHeight);
    if (!point) throw Object.assign(new Error("the target has no visible area in the viewport"), { code: "not_visible" });
    return { x: Math.round(point.x), y: Math.round(point.y) };
  }

  /** True when the hit-tested node is the target or one of its descendants (composed tree). */
  async function contains(host, targetId, hitId) {
    if (!hitId) return false;
    if (targetId === hitId) return true;
    const target = await cdp(host, "DOM.resolveNode", { backendNodeId: targetId });
    const hit = await cdp(host, "DOM.resolveNode", { backendNodeId: hitId });
    try {
      const verdict = await cdp(host, "Runtime.callFunctionOn", { objectId: target.object.objectId, functionDeclaration: "function(h){ let n = h; while (n) { if (n === this) return true; n = n.parentNode || (n.host ?? null); } return false; }", arguments: [{ objectId: hit.object.objectId }], returnByValue: true });
      return Boolean(verdict.result?.value);
    } finally {
      await cdp(host, "Runtime.releaseObject", { objectId: target.object.objectId }).catch(() => {});
      await cdp(host, "Runtime.releaseObject", { objectId: hit.object.objectId }).catch(() => {});
    }
  }

  async function handleExecute(params) {
    const host = findByCapability(params.capabilityId);
    const reply = (body) => bridge.rawCall("browser.result", { invocationId: params.invocationId, ...body }).catch((error) => log.warn("browser.result rejected", { error: String(error?.message ?? error) }));
    if (!host || host.guest.isDestroyed()) return reply({ status: "error", error: { code: "unknown_capability", message: "capability is not registered on this host" } });
    const controller = new AbortController();
    inflight.set(params.invocationId, { controller, host });
    const lease = setTimeout(() => controller.abort(), params.leaseMs); // host-enforced lease, independent of the socket (§5.3)
    // Serialize observations and input so snapshots cannot be replaced mid-action.
    const previous = host.queue;
    // The executor runs at once, so the gate's resolve is in hand before anything awaits, and `finally` calls it.
    /** @type {(value?: unknown) => void} */
    let unlock;
    const gate = new Promise(resolve => { unlock = resolve; });
    host.queue = previous.then(() => gate);
    let acquired = false;
    let completed = false;
    try {
      await previous;
      controller.signal.throwIfAborted();
      acquired = true;
      host.signal = controller.signal;
      host.inputOperation = INPUT_OPERATIONS.has(params.operation);
      host.expectedRevision = params.navigationRevision;
      if (isOverlayActive() && (host.inputOperation || ['navigate', 'history'].includes(params.operation)) && waitForOverlay) {
        await waitForOverlay(controller.signal);
        controller.signal.throwIfAborted();
      }
      if (host.inputOperation && params.navigationRevision !== host.navigationRevision) return reply({ status: 'stale', error: { code: 'stale_reference', message: 'the page navigated since the engine admitted this action' }, navigationRevision: host.navigationRevision });
      if (isOverlayActive() && (host.inputOperation || ['navigate', 'history'].includes(params.operation))) throw Object.assign(new Error('a host dialog is open; browser control is suspended'), { code: 'host_overlay' });
      host.cursorOperation = params.operation;
      publishCursor(host, CURSOR_ACTIONS[params.operation] ?? 'working');
      const outcome = await operate(host, params.operation, params.arguments, controller.signal);
      controller.signal.throwIfAborted();
      if (outcome.stale) return reply({ status: "stale", error: { code: "stale_reference", message: outcome.message }, navigationRevision: host.navigationRevision });
      completed = true;
      return reply({ status: "ok", result: outcome.result, navigationRevision: host.navigationRevision, ...(outcome.screenshot ? { screenshot: outcome.screenshot } : {}) });
    } catch (error) {
      if (acquired) clearCursor(host);
      if (controller.signal.aborted) return reply({ status: "cancelled", error: { code: "cancelled", message: "operation cancelled or lease expired" }, navigationRevision: host.navigationRevision });
      if (error?.code === 'stale_reference') return reply({ status: 'stale', error: { code: 'stale_reference', message: error.message }, navigationRevision: host.navigationRevision });
      log.warn("browser operation failed", { operation: params.operation, error: String(error?.message ?? error) });
      return reply({ status: "error", error: { code: String(error?.code ?? "browser_error").slice(0, 64), message: String(error?.message ?? error).slice(0, 1000) }, navigationRevision: host.navigationRevision });
    } finally {
      clearTimeout(lease);
      inflight.delete(params.invocationId);
      if (acquired) {
        host.cursorOperation = null;
        if (completed) publishCursor(host); else clearCursor(host);
        host.signal = null; host.inputOperation = false;
      }
      unlock();
    }
  }

  function handleCancel(params) {
    const entry = inflight.get(params.invocationId);
    if (entry) { entry.controller.abort(); clearCursor(entry.host); }
  }

  return {
    attach,
    handleExecute,
    handleCancel,
    onRegistered(listener) { registeredListeners.add(listener); return () => registeredListeners.delete(listener); },
    onRegistrationFailed(listener) { registrationFailedListeners.add(listener); return () => registrationFailedListeners.delete(listener); },
    retryRegistration(workspaceId) {
      for (const host of hosts.values()) if (host.workspaceId === workspaceId && !host.capabilityId && host.registrationError) void register(host);
    },
    async onConnected() { for (const host of hosts.values()) await register(host); },
    onDisconnected() { for (const entry of inflight.values()) entry.controller.abort(); for (const host of hosts.values()) { host.capabilityId = null; clearCursor(host); } },
    get hosts() { return hosts; },
  };
}
