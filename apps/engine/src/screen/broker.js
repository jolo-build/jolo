// Screen broker: whole-desktop control. One desktop registers the display it can drive; the engine
// keeps authority, the dispatcher persists intent under a per-task consent grant, and each admitted
// operation goes to that one live host. Mirrors the browser broker, without tabs or navigation.
import { ProtocolError } from "@jolo/protocol";
import { newId } from "../storage/index.js";

export class ScreenHostUnavailableError extends ProtocolError {
  constructor(message) {
    super("unavailable", message, { code: "screen_host_unavailable" });
    this.hostUnavailable = true;
    this.screenHost = true;
  }
}

/** The user touched the mouse or keyboard while the agent held the screen; the run pauses. */
export class ScreenInterruptedError extends ProtocolError {
  constructor(message) {
    super("interrupted", message, { code: "user_input" });
    this.userInterrupted = true;
  }
}

export class ScreenBroker {
  constructor({ storage, log }) {
    this.storage = storage;
    this.log = log;
    /** @type {{ capabilityId: string, conn: any, display: any, operations: Set<string>, permissions: { accessibility: boolean, screenRecording: boolean } } | null} */
    this.host = null;
    /** @type {Map<string, { resolve: Function, reject: Function, host: any }>} */
    this.pending = new Map();
  }

  hasScreen() { return Boolean(this.host && !this.host.conn.closed); }

  describe() {
    if (!this.hasScreen()) return null;
    const { capabilityId, display, permissions } = this.host;
    return { capabilityId, display, permissions, operations: [...this.host.operations] };
  }

  /** The latest desktop to register wins: one person, one screen, one controller. */
  register(conn, params) {
    if (this.host && this.host.conn !== conn) this.unregister(this.host.capabilityId, "another desktop registered the screen");
    const capabilityId = newId("scr");
    this.host = { capabilityId, conn, display: params.display, operations: new Set(params.operations), permissions: params.permissions };
    conn.closeHooks.add(() => { if (this.host?.capabilityId === capabilityId) this.unregister(capabilityId, "desktop disconnected"); });
    this.log.info?.("screen host registered", { capabilityId, display: params.display });
    return this.host;
  }

  update(conn, { capabilityId, permissions }) {
    if (!this.host || this.host.capabilityId !== capabilityId || this.host.conn !== conn) throw new ProtocolError("not_found", "unknown screen capability for this desktop");
    this.host.permissions = permissions;
    return this.host;
  }

  unregister(capabilityId, reason = "unregistered") {
    if (!this.host || this.host.capabilityId !== capabilityId) return null;
    const host = this.host;
    this.host = null;
    for (const [invocationId, entry] of this.pending) {
      if (entry.host !== host) continue;
      this.pending.delete(invocationId);
      entry.reject(new ScreenHostUnavailableError(`screen host lost during ${invocationId}: ${reason}`));
    }
    return host;
  }

  /**
   * Dispatch one admitted operation and await the desktop's answer. The invocation already has durable intent.
   * @param {{ runId: string, invocationId: string, operation: string, args: Record<string, unknown>, leaseMs: number, signal: AbortSignal }} request
   */
  execute({ runId, invocationId, operation, args, leaseMs, signal }) {
    if (signal.aborted) throw new ProtocolError("interrupted", "run cancelled");
    const host = this.host;
    if (!host || host.conn.closed) throw new ScreenHostUnavailableError("open Jolo desktop on this Mac to let an agent use the screen");
    if (!host.operations.has(operation)) throw new ProtocolError("unavailable", `the desktop does not support screen ${operation}`);
    const needs = operation === 'wait' ? null : ['screenshot', 'zoom', 'windows'].includes(operation) ? 'screenRecording' : 'accessibility';
    if (needs && !host.permissions[needs]) {
      const setting = needs === 'screenRecording' ? 'Screen & System Audio Recording' : 'Accessibility';
      throw new ProtocolError("unavailable", `Jolo needs the ${setting} permission for this; turn it on in System Settings → Privacy & Security → ${setting}, then restart Jolo`, { code: `missing_${needs === 'screenRecording' ? 'screen_recording' : 'accessibility'}` });
    }
    return new Promise((resolve, reject) => {
      const settle = (fn) => (value) => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); this.pending.delete(invocationId); fn(value); };
      const timer = setTimeout(() => {
        host.conn.notify("screen.cancel", { invocationId, reason: "lease expired" });
        settle(reject)(new ProtocolError("interrupted", "the desktop did not answer within the lease", { code: "timeout" }));
      }, leaseMs);
      const onAbort = () => {
        host.conn.notify("screen.cancel", { invocationId, reason: "run cancelled" });
        settle(reject)(new ProtocolError("interrupted", "run cancelled"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(invocationId, { host, resolve: settle(resolve), reject: settle(reject) });
      host.conn.notify("screen.execute", { invocationId, capabilityId: host.capabilityId, runId, operation, arguments: args, leaseMs });
    });
  }

  /** Desktop reply for an outstanding operation; late or unknown replies are ignored. */
  result(conn, params) {
    const entry = this.pending.get(params.invocationId);
    if (!entry) return { accepted: false };
    if (entry.host.conn !== conn) throw new ProtocolError("permission_denied", "result from a different desktop");
    if (params.status === "ok") entry.resolve({ result: params.result ?? {}, screenshot: params.screenshot ?? null });
    else if (params.status === "interrupted") entry.reject(new ScreenInterruptedError(params.error?.message ?? "you used the mouse or keyboard, so the agent stopped; resume the task when you are ready"));
    else if (params.status === "cancelled") entry.reject(new ProtocolError("interrupted", params.error?.message ?? "screen operation cancelled"));
    else entry.reject(new ProtocolError("unavailable", params.error?.message ?? "screen operation failed", { code: params.error?.code ?? "screen_error" }));
    return { accepted: true };
  }
}
