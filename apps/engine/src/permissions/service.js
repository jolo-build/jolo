// Grants, permission requests, and policy checks.
import { EventEmitter } from "node:events";
import { ProtocolError } from "@jolo/protocol";

export const SCOPES = Object.freeze({ inspect: "inspect", browse: "browse", edit: "edit", execute: "execute" });

/** Thrown by authorize() when a user decision is required before execution. */
export class PermissionRequired extends Error {
  constructor(toolClass) {
    super(`${toolClass} requires user approval`);
    this.name = "PermissionRequired";
    this.code = "permission_required";
    this.toolClass = toolClass;
  }
}

export class PermissionService {
  constructor({ storage }) {
    this.storage = storage;
    this.events = new EventEmitter();
  }

  grantScope(scope, constraints) {
    const existing = this.storage.findStandingGrant({ scope, workspaceId: constraints.workspaceId, runId: constraints.runId });
    if (existing) return { grant: existing, created: false };
    return { grant: this.storage.insertGrant({ scope, constraints }), created: true };
  }

  /** Attaching the inline browser, via the Browser button or chat, permits browsing in that workspace. */
  grantBrowse(workspaceId) {
    return this.grantScope(SCOPES.browse, { workspaceId });
  }

  /** Opening a project permits scoped inspection of its workspace (§10.1 default policy). */
  grantInspect(workspaceId) {
    return this.grantScope(SCOPES.inspect, { workspaceId });
  }

  /** Starting an editing task permits structured file edits within the workspace for that task (§10.1). */
  grantEdit(workspaceId, runId) {
    return this.grantScope(SCOPES.edit, { workspaceId, runId });
  }

  /**
   * Resolve the grant that authorizes a tool class in a workspace. Throws permission_denied when policy
   * forbids it outright and PermissionRequired when a user decision could allow it.
   */
  authorize({ toolClass, workspaceId, runId, approvedPermissionId, argumentDigest, toolName }) {
    if (toolClass === "read" || toolClass === 'browser_open') {
      const grant = this.storage.findGrant({ scope: SCOPES.inspect, workspaceId });
      if (!grant) throw new ProtocolError("permission_denied", "no inspection grant for this workspace");
      return grant;
    }
    if (toolClass === "browser_read" || toolClass === "browser_action") {
      const grant = this.storage.findGrant({ scope: SCOPES.browse, workspaceId });
      if (!grant) throw new ProtocolError("permission_denied", "no browsing grant for this workspace; call browser_open first");
      return grant;
    }
    if (toolClass === "mutation") {
      const grant = this.storage.findGrantWithLifetime({ scope: SCOPES.edit, workspaceId, runId });
      if (!grant) throw new ProtocolError("permission_denied", "no editing grant for this workspace and task");
      return grant;
    }
    if (toolClass === "process") {
      const grant = this.storage.findExecuteGrant({ workspaceId, runId, argumentDigest, toolName });
      if (grant) return grant;
      throw new PermissionRequired(toolClass);
    }
    throw new ProtocolError("permission_denied", `unknown tool class ${toolClass}`);
  }

  request({ run, workspaceId, tool, argumentDigest, summary, cwd }) {
    const permission = this.storage.transaction(() => {
      const created = this.storage.insertPermission({ runId: run.id, sessionId: run.sessionId, workspaceId, tool: tool.name, request: { argumentDigest, ...summary, cwd, isolation: "none" } });
      this.storage.appendEvent({ sessionId: run.sessionId, runId: run.id, type: "permission.requested", payload: { permissionId: created.id, runId: run.id, workspaceId, tool: tool.name, summary: summary.summary, ...(summary.argv ? { argv: summary.argv } : {}), ...(summary.script ? { script: summary.script } : {}), cwd, isolation: "none", revision: created.revision } });
      return created;
    });
    return permission;
  }

  /** An interactive client submits the user's decision; the first valid resolution wins (§10.1). */
  resolve({ permissionId, decision, expectedRevision }) {
    const resolved = this.storage.transaction(() => {
      const permission = this.storage.getPermission(permissionId);
      if (!permission) throw new ProtocolError("not_found", "unknown permission request");
      if (permission.state !== "pending") throw new ProtocolError("conflict", `permission already ${permission.state}`, { state: permission.state });
      if (expectedRevision !== undefined && expectedRevision !== permission.revision) throw new ProtocolError("conflict", "permission revision moved", { revision: permission.revision });
      let grantId = null;
      if (decision === "allow_once") grantId = this.storage.insertGrant({ scope: SCOPES.execute, constraints: { workspaceId: permission.workspaceId, runId: permission.runId, argumentDigest: permission.request.argumentDigest, toolName: permission.tool, once: true } }).id;
      if (decision === "allow_run") grantId = this.grantScope(SCOPES.execute, { workspaceId: permission.workspaceId, runId: permission.runId }).grant.id;
      if (decision === "allow_project") grantId = this.grantScope(SCOPES.execute, { workspaceId: permission.workspaceId }).grant.id;
      if (grantId) this.storage.appendEvent({ type: "grant.created", payload: { grantId, scope: SCOPES.execute, workspaceId: permission.workspaceId } });
      const updated = this.storage.resolvePermission(permissionId, { state: decision === "deny" ? "denied" : "allowed", decision, grantId });
      this.storage.appendEvent({ sessionId: permission.sessionId, runId: permission.runId, type: "permission.resolved", payload: { permissionId, decision, revision: updated.revision, grantId } });
      return updated;
    });
    this.events.emit("resolved", resolved);
    return resolved;
  }

  /** Wait for a pending permission to be resolved, or for the run to be cancelled. */
  waitForResolution(permissionId, signal) {
    return new Promise((resolve, reject) => {
      const current = this.storage.getPermission(permissionId);
      if (!current) return reject(new ProtocolError("not_found", "unknown permission request"));
      if (signal.aborted) return reject(new ProtocolError("interrupted", "run cancelled while awaiting permission"));
      if (current.state !== "pending") return resolve(current);
      const onResolved = (permission) => { if (permission.id === permissionId) { cleanup(); resolve(permission); } };
      const onAbort = () => { cleanup(); reject(new ProtocolError("interrupted", "run cancelled while awaiting permission")); };
      const cleanup = () => { this.events.off("resolved", onResolved); signal.removeEventListener("abort", onAbort); };
      this.events.on("resolved", onResolved);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
