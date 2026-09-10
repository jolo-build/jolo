// Host-side agent browser control: registers capabilities with the engine and
// executes admitted operations over the guest's debugger. Raw CDP never leaves this module.
import { projectAX } from "./ax-projection.mjs";
import { BROWSER_OPERATIONS, FRAME_MAX_BYTES } from '@jolo/protocol';

const OPERATIONS = BROWSER_OPERATIONS;
const INPUT_OPERATIONS = new Set(['click', 'type', 'fill', 'press', 'scroll', 'hover', 'select']);
const NETWORK_RING = 200;
const SCREENSHOT_MAX_WIDTH = 1280;
const SCREENSHOT_MAX_HEIGHT = 800;
// Leave room for base64 expansion and the RPC envelope in both directions.
const SCREENSHOT_MAX_BYTES = Math.min(1024 * 1024, Math.floor((FRAME_MAX_BYTES - 16 * 1024) * 3 / 4));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createBrowserAgent({ bridge, log, isOverlayActive, nativeImage }) {
  /** @type {Map<number, any>} guest webContents id -> host record */
  const hosts = new Map();
  const inflight = new Map(); // invocationId -> { controller, host }
  const registeredListeners = new Set();

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
    try {
      const result = await bridge.rawCall("browser.register", { workspaceId: host.workspaceId, tabId: host.tabId, navigationRevision: host.navigationRevision, url: host.guest.getURL(), title: host.guest.getTitle(), operations: OPERATIONS });
      host.capabilityId = result.capabilityId;
      for (const listener of registeredListeners) listener(host);
      log.info("browser capability registered", { capabilityId: host.capabilityId, workspaceId: host.workspaceId });
    } catch (error) {
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
    const host = { guest, workspaceId, tabId: `tab_${guest.id}`, navigationRevision: 0, capabilityId: null, snapshots: [], nextReference: 0, snapshotSequence: 0, queue: Promise.resolve(), network: [], requests: new Map() };
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
    const navigated = () => { host.navigationRevision += 1; host.snapshots = []; host.network = []; host.requests.clear(); void update(host); };
    guest.on("did-navigate", navigated);
    guest.on("did-navigate-in-page", (_event, _url, isMainFrame) => { if (isMainFrame) navigated(); });
    guest.on("page-title-updated", () => void update(host));
    guest.on("render-process-gone", () => { navigated(); for (const entry of inflight.values()) if (entry.host === host) entry.controller.abort(); });
    guest.on("destroyed", () => {
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
          const projected = projectAX(nodes, { snapshotId, navigationRevision, referenceStart: host.nextReference, maxNodes: args.maxNodes ?? 300 });
          host.nextReference += projected.snapshot.nodes.length;
          host.snapshots = [projected, ...host.snapshots].slice(0, 2); // active snapshot plus one predecessor (§5.3)
          return { result: { ...projected.snapshot, url: host.guest.getURL(), title: host.guest.getTitle() } };
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
        await cdp(host, "Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
        const hit = await cdp(host, "DOM.getNodeForLocation", { x: point.x, y: point.y, ignorePointerEventsNone: false });
        if (!(await contains(host, resolved.backendNodeId, hit.backendNodeId))) throw Object.assign(new Error("the target is obscured by another element"), { code: "obscured" });
        if (operation === 'hover') return { result: { ref: args.ref, ...point, navigationRevision: host.navigationRevision } };
        if (isOverlayActive()) throw Object.assign(new Error("a host dialog opened; browser input is suspended"), { code: "host_overlay" });
        await cdp(host, "Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1 });
        await host.guest.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1 });
        await sleep(100);
        return { result: { ref: args.ref, x: point.x, y: point.y, navigationRevision: host.navigationRevision, url: host.guest.getURL() } };
      }
      case "fill":
      case "type": {
        if (isOverlayActive()) throw Object.assign(new Error("a host dialog is open; browser input is suspended"), { code: "host_overlay" });
        const resolved = resolveReference(host, args.ref, args.snapshotId);
        if (resolved.stale) return { stale: true, message: "the page changed since that snapshot; take a new snapshot" };
        if (resolved.missing) throw Object.assign(new Error(`unknown reference ${args.ref}`), { code: "unknown_reference" });
        await cdp(host, "DOM.scrollIntoViewIfNeeded", { backendNodeId: resolved.backendNodeId });
        await nodeCall(host, resolved.backendNodeId, function() {
          if (this.disabled || this.readOnly || !(this.isContentEditable || this instanceof HTMLTextAreaElement || (this instanceof HTMLInputElement && ['text','search','email','url','tel','password','number'].includes(this.type)))) throw new Error('target is not an enabled editable field');
          this.focus();
        });
        if (operation === 'fill') await pressKey(host, 'a', [process.platform === 'darwin' ? 'Meta' : 'Control']);
        if (args.text) await cdp(host, "Input.insertText", { text: args.text });
        else if (operation === 'fill') await pressKey(host, 'Backspace', []);
        if (args.submit) {
          await pressKey(host, 'Enter', []);
          await sleep(100);
        }
        return { result: { ref: args.ref, typed: args.text.length, submitted: Boolean(args.submit), navigationRevision: host.navigationRevision } };
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
          }
          await pressKey(host, args.key, args.modifiers ?? []);
        } else if (operation === 'scroll') {
          const { cssVisualViewport: viewport } = await cdp(host, 'Page.getLayoutMetrics');
          const point = backendNodeId ? await targetPoint(host, backendNodeId) : { x: Math.floor(viewport.clientWidth / 2), y: Math.floor(viewport.clientHeight / 2) };
          await cdp(host, 'Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: args.deltaX ?? 0, deltaY: args.deltaY ?? 0 });
        } else {
          await cdp(host, 'DOM.scrollIntoViewIfNeeded', { backendNodeId });
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
        // One capture at a time per host (§5.3). CDP capture first; Electron's capturePage as the fallback.
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
          let { width, height } = image.getSize();
          let scale = Math.min(1, SCREENSHOT_MAX_WIDTH / width, SCREENSHOT_MAX_HEIGHT / height);
          let png = null;
          for (let attempt = 0; attempt < 8; attempt += 1) {
            const resized = scale < 1 ? image.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: "good" }) : image;
            png = resized.toPNG();
            if (png.length <= SCREENSHOT_MAX_BYTES) {
              const size = resized.getSize();
              return { result: { url: host.guest.getURL(), title: host.guest.getTitle(), navigationRevision: host.navigationRevision }, screenshot: { base64: png.toString("base64"), width: size.width, height: size.height, mimeType: "image/png" } };
            }
            scale *= 0.7;
          }
          throw Object.assign(new Error('screenshot could not be reduced to fit the browser connection'), { code: 'limit_exceeded' });
        } finally {
          host.capturing = false;
        }
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
    const codes = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, PageUp: 33, PageDown: 34, Space: 32 };
    const flags = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
    const mask = modifiers.reduce((value, modifier) => value | flags[modifier], 0);
    const code = /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : /^\d$/.test(key) ? `Digit${key}` : key;
    const value = key === 'Space' ? ' ' : key;
    const params = { key: value, code, windowsVirtualKeyCode: codes[key] ?? key.toUpperCase().charCodeAt(0), modifiers: mask };
    const text = (mask & 7) ? '' : key === 'Enter' ? '\r' : value.length === 1 ? value : '';
    await cdp(host, 'Input.dispatchKeyEvent', { type: 'keyDown', ...params, ...(text ? { text } : {}), ...((mask & 6) && key.toLowerCase() === 'a' ? { commands: ['selectAll'] } : {}) });
    // Release even if the key-down navigated or the run was just cancelled.
    await host.guest.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
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
    let unlock;
    const gate = new Promise(resolve => { unlock = resolve; });
    host.queue = previous.then(() => gate);
    let acquired = false;
    try {
      await previous;
      controller.signal.throwIfAborted();
      acquired = true;
      host.signal = controller.signal;
      host.inputOperation = INPUT_OPERATIONS.has(params.operation);
      host.expectedRevision = params.navigationRevision;
      if (host.inputOperation && params.navigationRevision !== host.navigationRevision) return reply({ status: 'stale', error: { code: 'stale_reference', message: 'the page navigated since the engine admitted this action' }, navigationRevision: host.navigationRevision });
      if (isOverlayActive() && (host.inputOperation || ['navigate', 'history'].includes(params.operation))) throw Object.assign(new Error('a host dialog is open; browser control is suspended'), { code: 'host_overlay' });
      const outcome = await operate(host, params.operation, params.arguments, controller.signal);
      controller.signal.throwIfAborted();
      if (outcome.stale) return reply({ status: "stale", error: { code: "stale_reference", message: outcome.message }, navigationRevision: host.navigationRevision });
      return reply({ status: "ok", result: outcome.result, navigationRevision: host.navigationRevision, ...(outcome.screenshot ? { screenshot: outcome.screenshot } : {}) });
    } catch (error) {
      if (controller.signal.aborted) return reply({ status: "cancelled", error: { code: "cancelled", message: "operation cancelled or lease expired" }, navigationRevision: host.navigationRevision });
      if (error?.code === 'stale_reference') return reply({ status: 'stale', error: { code: 'stale_reference', message: error.message }, navigationRevision: host.navigationRevision });
      log.warn("browser operation failed", { operation: params.operation, error: String(error?.message ?? error) });
      return reply({ status: "error", error: { code: String(error?.code ?? "browser_error").slice(0, 64), message: String(error?.message ?? error).slice(0, 1000) }, navigationRevision: host.navigationRevision });
    } finally {
      clearTimeout(lease);
      inflight.delete(params.invocationId);
      if (acquired) { host.signal = null; host.inputOperation = false; }
      unlock();
    }
  }

  function handleCancel(params) {
    inflight.get(params.invocationId)?.controller.abort();
  }

  return {
    attach,
    handleExecute,
    handleCancel,
    onRegistered(listener) { registeredListeners.add(listener); return () => registeredListeners.delete(listener); },
    async onConnected() { for (const host of hosts.values()) await register(host); },
    onDisconnected() { for (const entry of inflight.values()) entry.controller.abort(); for (const host of hosts.values()) host.capabilityId = null; },
    get hosts() { return hosts; },
  };
}
