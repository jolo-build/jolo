// Browser broker: hosts register ephemeral capabilities; the engine keeps
// authority, persists intent through the dispatcher, and routes admitted operations to a live host.
import { createHash } from "node:crypto";
import { ProtocolError } from "@jolo/protocol";
import { newId } from "../storage/index.js";

export class HostUnavailableError extends ProtocolError {
  constructor(message) {
    super("unavailable", message, { code: "browser_host_unavailable" });
    this.hostUnavailable = true;
  }
}

export class BrowserBroker {
  constructor({ storage, log }) {
    this.storage = storage;
    this.log = log;
    /** @type {Map<string, { capabilityId, conn, workspaceId, tabId, navigationRevision, url, title, operations, grantId }>} */
    this.capabilities = new Map();
    /** @type {Map<string, { resolve, reject, capability, timer }>} */
    this.pending = new Map();
    this.openers = new Map(); // desktop connection -> workspaces displayed in its panes
    this.pendingOpens = new Map();
  }

  capability(id) { return this.capabilities.get(id) ?? null; }

  hasHost(workspaceId) {
    for (const cap of this.capabilities.values()) if (cap.workspaceId === workspaceId && !cap.conn.closed) return true;
    return false;
  }

  hasBrowser(workspaceId) {
    return this.hasHost(workspaceId) || [...this.openers].some(([conn, workspaces]) => !conn.closed && workspaces.has(workspaceId));
  }

  setOpener(conn, workspaceIds) {
    if (!this.openers.has(conn)) conn.closeHooks.add(() => {
      this.openers.delete(conn);
      for (const entry of this.pendingOpens.values()) if (entry.conn === conn) entry.finish(new HostUnavailableError('desktop disconnected while opening the browser'));
    });
    const workspaces = new Set(workspaceIds);
    this.openers.set(conn, workspaces);
    for (const entry of this.pendingOpens.values()) if (entry.conn === conn && !workspaces.has(entry.workspaceId)) entry.finish(new HostUnavailableError('workspace pane closed while opening the browser'));
    return { registered: workspaces.size > 0 };
  }

  open({ workspaceId, invocationId, leaseMs, signal }) {
    leaseMs = Math.min(15_000, leaseMs); // Native run budgets can exceed the pane-opening protocol's bound.
    const conn = [...this.openers].find(([conn, workspaces]) => !conn.closed && workspaces.has(workspaceId))?.[0];
    if (!conn) {
      // Hosts without the newer pane-opening protocol can still reuse an attached tab.
      if (this.hasHost(workspaceId)) return Promise.resolve({ result: this.tab(this.capabilityFor(workspaceId, 'navigate')) });
      throw new HostUnavailableError('open this workspace in Jolo desktop to use its inline browser');
    }
    return new Promise((resolve, reject) => {
      const finish = (error, capability) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        this.pendingOpens.delete(invocationId);
        if (error) { conn.notify('browser.cancel', { invocationId, reason: 'browser opening cancelled' }); reject(error); }
        else resolve({ result: this.tab(capability) });
      };
      const onAbort = () => finish(new ProtocolError('interrupted', 'run cancelled'));
      const timer = setTimeout(() => finish(new HostUnavailableError('inline browser did not open within the lease')), leaseMs);
      this.pendingOpens.set(invocationId, { conn, workspaceId, finish });
      signal.addEventListener('abort', onAbort, { once: true });
      conn.notify('browser.open', { invocationId, workspaceId, leaseMs });
    });
  }

  openResult(conn, params) {
    const entry = this.pendingOpens.get(params.invocationId);
    if (!entry) return { accepted: false };
    if (entry.conn !== conn) throw new ProtocolError('permission_denied', 'result from a different desktop');
    const capability = this.capability(params.capabilityId);
    if (params.error) entry.finish(params.errorCode === 'browser_busy' ? new ProtocolError('conflict', params.error, { code: 'browser_busy' }) : new HostUnavailableError(params.error));
    else if (!capability || capability.conn !== conn || capability.workspaceId !== entry.workspaceId) throw new ProtocolError('permission_denied', 'browser opened outside the requested workspace');
    else entry.finish(null, capability);
    return { accepted: true };
  }

  tab(cap) { return { tabId: cap.tabId, url: cap.url, title: cap.title, navigationRevision: cap.navigationRevision, operations: [...cap.operations] }; }

  register(conn, params, grantId) {
    const capabilityId = newId("cap");
    const capability = { capabilityId, conn, workspaceId: params.workspaceId, tabId: params.tabId, navigationRevision: params.navigationRevision, url: params.url, title: params.title, operations: new Set(params.operations), grantId };
    this.capabilities.set(capabilityId, capability);
    conn.closeHooks.add(() => this.unregister(capabilityId, "host disconnected"));
    this.emit("registered", capability);
    return capability;
  }

  update(conn, params) {
    const capability = this.capabilities.get(params.capabilityId);
    if (!capability || capability.conn !== conn) throw new ProtocolError("not_found", "unknown capability for this host");
    capability.navigationRevision = params.navigationRevision;
    if (params.url !== undefined) capability.url = params.url;
    if (params.title !== undefined) capability.title = params.title;
    this.emit("updated", capability);
    return capability;
  }

  unregister(capabilityId, reason = "unregistered") {
    const capability = this.capabilities.get(capabilityId);
    if (!capability) return null;
    this.capabilities.delete(capabilityId);
    for (const [invocationId, entry] of this.pending) {
      if (entry.capability === capability) {
        this.pending.delete(invocationId);
        entry.reject(new HostUnavailableError(`browser host lost during ${invocationId}: ${reason}`));
      }
    }
    this.emit("unregistered", capability);
    return capability;
  }

  emit(status, capability) {
    this.storage.appendEvent({ type: "browser.host", payload: { status, capabilityId: capability.capabilityId, workspaceId: capability.workspaceId, tabId: capability.tabId, navigationRevision: capability.navigationRevision, ...(capability.url ? { url: capability.url } : {}), ...(capability.title ? { title: capability.title } : {}) } });
  }

  capabilityFor(workspaceId, operation, tabId) {
    const live = [...this.capabilities.values()].filter((cap) => cap.workspaceId === workspaceId && !cap.conn.closed);
    if (live.length === 0) throw new HostUnavailableError("no browser host is attached for this workspace");
    if (!tabId && live.length > 1) throw new ProtocolError('conflict', 'multiple browser tabs are attached; use browser_tabs and provide tabId');
    const capable = live.find((cap) => (!tabId || cap.tabId === tabId) && cap.operations.has(operation));
    if (!capable) throw new ProtocolError("unavailable", `the attached browser host does not support ${operation}`);
    return capable;
  }

  /**
   * Dispatch one admitted operation and await the host's result. The invocation already has durable intent.
   * @param {{ workspaceId: string, invocationId: string, operation: string, args: Record<string, unknown>, leaseMs: number, signal: AbortSignal }} request
   */
  execute({ workspaceId, invocationId, operation, args, leaseMs, signal }) {
    if (signal.aborted) throw new ProtocolError('interrupted', 'run cancelled');
    if (operation === 'open') return this.open({ workspaceId, invocationId, leaseMs, signal });
    if (operation === 'tabs') return Promise.resolve({ result: { tabs: [...this.capabilities.values()].filter(cap => cap.workspaceId === workspaceId && !cap.conn.closed).map(cap => this.tab(cap)), canOpen: [...this.openers].some(([conn, workspaces]) => !conn.closed && workspaces.has(workspaceId)) } });
    const capability = this.capabilityFor(workspaceId, operation, args.tabId);
    const argumentDigest = `sha256:${createHash("sha256").update(JSON.stringify(args)).digest("hex")}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(invocationId);
        signal.removeEventListener('abort', onAbort);
        capability.conn.notify("browser.cancel", { invocationId, reason: "lease expired" });
        reject(new ProtocolError("interrupted", "browser host did not answer within the lease", { code: "timeout" }));
      }, leaseMs);
      const onAbort = () => {
        clearTimeout(timer);
        this.pending.delete(invocationId);
        capability.conn.notify("browser.cancel", { invocationId, reason: "run cancelled" });
        reject(new ProtocolError("interrupted", "run cancelled"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(invocationId, { capability, timer, resolve: (value) => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); resolve(value); }, reject: (error) => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); reject(error); } });
      capability.conn.notify("browser.execute", { invocationId, capabilityId: capability.capabilityId, operation, arguments: args, navigationRevision: capability.navigationRevision, leaseMs, argumentDigest });
    });
  }

  /** Host reply for an outstanding operation; late or unknown replies are ignored but reported. */
  result(conn, params) {
    const entry = this.pending.get(params.invocationId);
    if (!entry) return { accepted: false };
    if (entry.capability.conn !== conn) throw new ProtocolError("permission_denied", "result from a different host");
    this.pending.delete(params.invocationId);
    if (params.navigationRevision !== undefined) entry.capability.navigationRevision = params.navigationRevision;
    if (params.status === "ok") entry.resolve({ result: params.result ?? {}, screenshot: params.screenshot ?? null, capability: entry.capability });
    else if (params.status === "stale") entry.reject(new ProtocolError("conflict", params.error?.message ?? "page changed; take a new snapshot", { code: "stale_reference" }));
    else if (params.status === "cancelled") entry.reject(new ProtocolError("interrupted", params.error?.message ?? "browser operation cancelled"));
    else entry.reject(new ProtocolError("unavailable", params.error?.message ?? "browser operation failed", { code: params.error?.code ?? "browser_error" }));
    return { accepted: true };
  }
}
