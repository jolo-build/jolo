// Host-side agent browser control: registers capabilities with the engine and
// executes admitted operations over the guest's debugger. Raw CDP never leaves this module.
import { nativeImage } from "electron";
import { projectAX } from "./ax-projection.mjs";

const OPERATIONS = ["navigate", "snapshot", "click", "type", "screenshot", "network"];
const NETWORK_RING = 200;
const SCREENSHOT_MAX_WIDTH = 1280;
const SCREENSHOT_MAX_HEIGHT = 800;
const SCREENSHOT_MAX_BYTES = 1024 * 1024;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createBrowserAgent({ bridge, log, isOverlayActive }) {
  /** @type {Map<number, any>} guest webContents id -> host record */
  const hosts = new Map();
  const inflight = new Map(); // invocationId -> AbortController

  const cdp = (host, method, params = {}) => host.guest.debugger.sendCommand(method, params);

  async function register(host) {
    if (host.guest.isDestroyed()) return;
    try {
      const result = await bridge.rawCall("browser.register", { workspaceId: host.workspaceId, tabId: host.tabId, navigationRevision: host.navigationRevision, url: host.guest.getURL(), title: host.guest.getTitle(), operations: OPERATIONS });
      host.capabilityId = result.capabilityId;
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
    const host = { guest, workspaceId, tabId: `tab_${guest.id}`, navigationRevision: 0, capabilityId: null, snapshots: [], network: [], requests: new Map() };
    hosts.set(guest.id, host);
    // Bounded network observation (§5.3): metadata only, a ring per tab, cleared on navigation.
    guest.debugger.on("message", (_event, method, params) => {
      if (method === "Network.requestWillBeSent") {
        const entry = { requestId: params.requestId, method: params.request?.method ?? "GET", url: String(params.request?.url ?? "").slice(0, 2048), type: params.type ?? "Other", status: null, size: 0, at: new Date().toISOString(), navigationRevision: host.navigationRevision };
        host.requests.set(params.requestId, entry);
        host.network.push(entry);
        if (host.network.length > NETWORK_RING) host.network.splice(0, host.network.length - NETWORK_RING);
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
    const navigated = () => { host.navigationRevision += 1; host.snapshots = []; host.network = host.network.filter((e) => e.navigationRevision === host.navigationRevision); void update(host); };
    guest.on("did-navigate", navigated);
    guest.on("did-navigate-in-page", navigated);
    guest.on("page-title-updated", () => void update(host));
    guest.on("render-process-gone", () => { host.snapshots = []; void update(host); });
    guest.on("destroyed", () => {
      hosts.delete(guest.id);
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
    const candidates = snapshotId ? host.snapshots.filter((s) => s.snapshot.snapshotId === snapshotId) : host.snapshots.slice(0, 1);
    for (const entry of candidates) {
      if (entry.snapshot.navigationRevision !== host.navigationRevision) return { stale: true };
      const backendNodeId = entry.references.get(ref);
      if (backendNodeId) return { backendNodeId };
    }
    return { stale: host.snapshots.length === 0 || host.snapshots[0].snapshot.navigationRevision !== host.navigationRevision, missing: true };
  }

  async function operate(host, operation, args, signal) {
    switch (operation) {
      case "navigate": {
        const url = new URL(args.url);
        if (!["http:", "https:"].includes(url.protocol)) throw Object.assign(new Error("only http(s) URLs can be opened"), { code: "invalid_url" });
        await new Promise((resolve, reject) => {
          const done = () => { cleanup(); resolve(); };
          const failed = (_event, code, description) => { if (code === -3) return; cleanup(); reject(Object.assign(new Error(`navigation failed: ${description || code}`), { code: "navigation_failed" })); };
          const onAbort = () => { cleanup(); host.guest.stop(); reject(Object.assign(new Error("cancelled"), { code: "cancelled" })); };
          const cleanup = () => { host.guest.off("did-finish-load", done); host.guest.off("did-fail-load", failed); signal.removeEventListener("abort", onAbort); };
          host.guest.on("did-finish-load", done);
          host.guest.on("did-fail-load", failed);
          signal.addEventListener("abort", onAbort, { once: true });
          host.guest.loadURL(url.href).catch(failed);
        });
        await sleep(50);
        return { result: { url: host.guest.getURL(), title: host.guest.getTitle(), navigationRevision: host.navigationRevision } };
      }
      case "snapshot": {
        await cdp(host, "Accessibility.enable");
        try {
          const { nodes } = await cdp(host, "Accessibility.getFullAXTree");
          const snapshotId = `snap_${host.navigationRevision}_${Date.now().toString(36)}`;
          const projected = projectAX(nodes, { snapshotId, navigationRevision: host.navigationRevision, maxNodes: args.maxNodes ?? 300 });
          host.snapshots = [projected, ...host.snapshots].slice(0, 2); // active snapshot plus one predecessor (§5.3)
          return { result: { ...projected.snapshot, url: host.guest.getURL(), title: host.guest.getTitle() } };
        } finally {
          await cdp(host, "Accessibility.disable").catch(() => {});
        }
      }
      case "click": {
        if (isOverlayActive()) throw Object.assign(new Error("a host dialog is open; browser input is suspended"), { code: "host_overlay" });
        const resolved = resolveReference(host, args.ref, args.snapshotId);
        if (resolved.stale) return { stale: true, message: "the page changed since that snapshot; take a new snapshot" };
        if (resolved.missing) throw Object.assign(new Error(`unknown reference ${args.ref}`), { code: "unknown_reference" });
        const point = await targetPoint(host, resolved.backendNodeId);
        await cdp(host, "Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
        const hit = await cdp(host, "DOM.getNodeForLocation", { x: point.x, y: point.y, ignorePointerEventsNone: false });
        if (!(await contains(host, resolved.backendNodeId, hit.backendNodeId))) throw Object.assign(new Error("the target is obscured by another element"), { code: "obscured" });
        if (isOverlayActive()) throw Object.assign(new Error("a host dialog opened; browser input is suspended"), { code: "host_overlay" });
        await cdp(host, "Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1 });
        await cdp(host, "Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1 });
        await sleep(100);
        return { result: { ref: args.ref, x: point.x, y: point.y, navigationRevision: host.navigationRevision, url: host.guest.getURL() } };
      }
      case "type": {
        if (isOverlayActive()) throw Object.assign(new Error("a host dialog is open; browser input is suspended"), { code: "host_overlay" });
        const resolved = resolveReference(host, args.ref, args.snapshotId);
        if (resolved.stale) return { stale: true, message: "the page changed since that snapshot; take a new snapshot" };
        if (resolved.missing) throw Object.assign(new Error(`unknown reference ${args.ref}`), { code: "unknown_reference" });
        await cdp(host, "DOM.scrollIntoViewIfNeeded", { backendNodeId: resolved.backendNodeId });
        await cdp(host, "DOM.focus", { backendNodeId: resolved.backendNodeId });
        await cdp(host, "Input.insertText", { text: args.text });
        if (args.submit) {
          await cdp(host, "Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
          await cdp(host, "Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
          await sleep(100);
        }
        return { result: { ref: args.ref, typed: args.text.length, submitted: Boolean(args.submit), navigationRevision: host.navigationRevision } };
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
          const withTimeout = (promise, ms, label) => Promise.race([promise, sleep(ms).then(() => { throw Object.assign(new Error(`${label} timed out`), { code: "capture_timeout" }); })]);
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
          for (let attempt = 0; attempt < 5; attempt += 1) {
            const resized = scale < 1 ? image.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: "good" }) : image;
            png = resized.toPNG();
            if (png.length <= SCREENSHOT_MAX_BYTES) {
              const size = resized.getSize();
              return { result: { url: host.guest.getURL(), title: host.guest.getTitle(), navigationRevision: host.navigationRevision }, screenshot: { base64: png.toString("base64"), width: size.width, height: size.height, mimeType: "image/png" } };
            }
            scale *= 0.7;
          }
          throw Object.assign(new Error("screenshot could not be reduced under 1 MiB"), { code: "limit_exceeded" });
        } finally {
          host.capturing = false;
        }
      }
      default:
        throw Object.assign(new Error(`unsupported operation ${operation}`), { code: "unsupported" });
    }
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
    if (params.navigationRevision !== host.navigationRevision && ["click", "type"].includes(params.operation)) return reply({ status: "stale", error: { code: "stale_reference", message: "the page navigated since the engine admitted this action" }, navigationRevision: host.navigationRevision });
    const controller = new AbortController();
    inflight.set(params.invocationId, controller);
    const lease = setTimeout(() => controller.abort(), params.leaseMs); // host-enforced lease, independent of the socket (§5.3)
    try {
      const outcome = await operate(host, params.operation, params.arguments, controller.signal);
      if (outcome.stale) return reply({ status: "stale", error: { code: "stale_reference", message: outcome.message }, navigationRevision: host.navigationRevision });
      return reply({ status: "ok", result: outcome.result, navigationRevision: host.navigationRevision, ...(outcome.screenshot ? { screenshot: outcome.screenshot } : {}) });
    } catch (error) {
      if (controller.signal.aborted) return reply({ status: "cancelled", error: { code: "cancelled", message: "operation cancelled or lease expired" }, navigationRevision: host.navigationRevision });
      log.warn("browser operation failed", { operation: params.operation, error: String(error?.message ?? error) });
      return reply({ status: "error", error: { code: String(error?.code ?? "browser_error").slice(0, 64), message: String(error?.message ?? error).slice(0, 1000) }, navigationRevision: host.navigationRevision });
    } finally {
      clearTimeout(lease);
      inflight.delete(params.invocationId);
    }
  }

  function handleCancel(params) {
    inflight.get(params.invocationId)?.abort();
  }

  return {
    attach,
    handleExecute,
    handleCancel,
    async onConnected() { for (const host of hosts.values()) await register(host); },
    onDisconnected() { for (const host of hosts.values()) host.capabilityId = null; },
    get hosts() { return hosts; },
  };
}
