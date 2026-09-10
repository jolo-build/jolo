// Policy-checked dispatcher: registry → validation → permission → durable intent → private adapter (§10.1).
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import path from 'node:path';
import { ProtocolError } from "@jolo/protocol";
import { TOOL_RESULT_MAX_BYTES } from "./registry.js";
import { PermissionRequired } from "../permissions/service.js";

const EXCERPT_BYTES = 32 * 1024;

const canonical = (value) => JSON.stringify(value, Object.keys(value ?? {}).sort());

export class ToolDispatcher {
  /**
   * @param {{ registry: any, permissions: any, storage: any, log: any, env: { path: string, ripgrep: string | null, git: string | null } }} options
   */
  constructor(options) {
    this.registry = options.registry;
    this.permissions = options.permissions;
    this.storage = options.storage;
    this.log = options.log;
    this.env = options.env;
    this.browser = options.browser ?? null; // BrowserBroker; absent in headless-only configurations
    this.supervisor = options.supervisor ?? null;
    this.patchesDir = options.patchesDir ?? null;
    this.search = options.search ?? null;
  }

  /**
   * Execute one admitted tool call. Never throws for model-caused failures; returns a structured result.
   * @param {{ run: any, workspace: { id: string, root: string }, call: { callId: string, name: string, arguments: unknown }, signal: AbortSignal, deadlineMs?: number, approvedPermissionId?: string | null, onOutput?: (text: string) => void, hooks?: { onChanges?: Function, onCheck?: Function } }} request
   */
  hasBrowser(workspaceId) { return Boolean(this.browser?.hasHost(workspaceId)); }
  executionClass(name) { return this.registry.get(name)?.executionClass; }
  searchContext(workspace, signal) { return { workspace: { id: workspace.id, root: workspace.path }, env: this.env, search: this.search, signal }; }

  async invoke({ run, workspace, call, signal, deadlineMs, approvedPermissionId = null, onOutput, messageId = null, hooks = {} }) {
    const startedAt = Date.now();
    let tool;
    let args;
    let grant;
    const fail = (error, status) => this.reject({ run, call, error, status, startedAt });
    try {
      ({ tool, args } = this.registry.validate(call.name, call.arguments));
    } catch (error) {
      return fail(error, "error");
    }
    const argumentDigest = `sha256:${createHash("sha256").update(canonical(args)).digest("hex")}`;
    try {
      grant = this.permissions.authorize({ toolClass: tool.executionClass, workspaceId: workspace.id, runId: run.id, approvedPermissionId, argumentDigest, toolName: tool.name });
    } catch (error) {
      if (error instanceof PermissionRequired) {
        const summary = tool.permissionSummary ? tool.permissionSummary(args) : { summary: `${tool.name} ${JSON.stringify(args)}`.slice(0, 500) };
        const permission = this.permissions.request({ run, workspaceId: workspace.id, tool, argumentDigest, summary, cwd: args.cwd ?? "." });
        return { status: "permission_required", permissionId: permission.id, invocationId: null, output: null, truncated: false, resultArtifactId: null };
      }
      return fail(error, "denied");
    }
    const invocation = this.storage.transaction(() => {
      const created = this.storage.insertInvocation({ runId: run.id, providerCallId: call.callId, name: tool.name, argumentDigest, grantId: grant?.id ?? null });
      if (grant?.constraints?.once) this.storage.expireGrant(grant.id); // a one-time approval covers exactly one admitted invocation
      this.storage.appendEvent({ sessionId: run.sessionId, runId: run.id, type: "tool.started", payload: { invocationId: created.id, callId: call.callId, name: tool.name, argumentDigest, preview: `${tool.name} ${JSON.stringify(args)}`.slice(0, 200) } });
      return created;
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("deadline")), deadlineMs ?? tool.deadlineMs);
    const onAbort = () => controller.abort(new Error("cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    let status = "ok";
    let result;
    let error = null;
    try {
      this.storage.updateInvocation(invocation.id, { state: "running" });
      const leaseMs = deadlineMs ?? tool.deadlineMs;
      const ctx = {
        workspace,
        sessionId: run.sessionId,
        storage: this.storage,
        signal: controller.signal,
        env: this.env,
        search: this.search,
        storeArtifact: (kind, buffer) => this.storeArtifact(run.sessionId, kind, buffer),
        invocationId: invocation.id,
        deadlineMs: leaseMs,
        patchesDir: this.patchesDir,
        supervisor: this.supervisor,
        onOutput,
        reportChanges: (changes, extra = {}) => {
          this.search?.invalidate(workspace.root);
          const detail = { invocationId: invocation.id, tool: tool.name, changes, ...(messageId ? { messageId } : {}), ...(extra.diffArtifactId ? { diffArtifactId: extra.diffArtifactId } : {}) };
          this.storage.appendEvent({ sessionId: run.sessionId, runId: run.id, type: "files.changed", payload: detail });
          hooks.onChanges?.(changes);
        },
        recordCheck: (check) => hooks.onCheck?.({ invocationId: invocation.id, at: new Date().toISOString(), ...check }),
        browser: this.browser ? { execute: (operation, operationArgs) => this.browser.execute({ workspaceId: workspace.id, invocationId: invocation.id, operation, args: operationArgs, leaseMs: Math.max(1_000, leaseMs - 500), signal: controller.signal }) } : null,
      };
      if (tool.browserOperation && !ctx.browser) throw new ProtocolError("unavailable", "browser tools are not available in this engine", { code: "browser_host_unavailable" });
      if (tool.executionClass === "process" && !ctx.supervisor) throw new ProtocolError("unavailable", "command execution is not available in this engine");
      result = await tool.execute(ctx, args);
      if (tool.executionClass === 'process') this.search?.invalidate(workspace.root);
    } catch (caught) {
      error = caught;
      status = signal.aborted ? "cancelled" : controller.signal.aborted ? "timeout" : caught?.hostUnavailable ? "unavailable" : "error";
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
    if (error) return this.reject({ run, call, error, status, startedAt, invocation });
    return this.complete({ run, call, tool, result, startedAt, invocation });
  }

  /** Record a user's refusal as an audited, non-executed invocation. */
  deny({ run, call, reason }) {
    return this.reject({ run, call, error: new ProtocolError("permission_denied", reason), status: "denied", startedAt: Date.now() });
  }

  storeArtifact(sessionId, kind, buffer) {
    return this.storage.transaction(() => {
      const artifact = this.storage.createArtifact({ sessionId, kind });
      const writer = this.storage.openArtifactWriter(artifact);
      let committed;
      try { writer.append(buffer); committed = writer.flush(); }
      finally { writer.close(); }
      this.storage.finalizeArtifact(artifact.id, committed, `sha256:${createHash("sha256").update(buffer).digest("hex")}`);
      return artifact.id;
    });
  }

  complete({ run, call, tool, result, startedAt, invocation }) {
    let payload = { ok: true, ...result };
    let output = JSON.stringify(payload);
    let truncated = false;
    let resultArtifactId = result?.artifactId;
    if (Buffer.byteLength(output) > TOOL_RESULT_MAX_BYTES) {
      const full = Buffer.from(output, "utf8");
      resultArtifactId = this.storeArtifact(run.sessionId, "tool-output", full);
      payload = { ok: true, truncated: true, resultArtifactId, note: "Result exceeded 64 KiB; the full JSON is stored as an artifact. Use read_output to page through it.", excerpt: full.subarray(0, EXCERPT_BYTES).toString("utf8") };
      output = JSON.stringify(payload);
      truncated = true;
    }
    const durationMs = Date.now() - startedAt;
    this.storage.transaction(() => {
      this.storage.updateInvocation(invocation.id, { state: "completed", exitData: { status: "ok", durationMs, truncated }, resultArtifactId: resultArtifactId ?? null });
      this.storage.appendEvent({ sessionId: run.sessionId, runId: run.id, type: "tool.completed", payload: { invocationId: invocation.id, callId: call.callId, name: tool.name, status: "ok", durationMs, resultBytes: Buffer.byteLength(output), truncated, ...(resultArtifactId ? { resultArtifactId } : {}) } });
    });
    return { invocationId: invocation.id, status: "ok", output, truncated, resultArtifactId: resultArtifactId ?? null };
  }

  reject({ run, call, error, status, startedAt, invocation = null }) {
    const code = error?.details?.code === "browser_host_unavailable" ? "browser_host_unavailable" : error instanceof ProtocolError ? error.code : status === "timeout" ? "timeout" : status === "cancelled" ? "interrupted" : "internal";
    const message = error instanceof ProtocolError ? error.message : status === "timeout" ? "tool exceeded its deadline" : status === "cancelled" ? "run cancelled" : "tool failed";
    if (!(error instanceof ProtocolError) && status === "error") this.log.error("tool crashed", { name: call.name, error: String(error?.stack ?? error) });
    const output = JSON.stringify({ ok: false, error: { code, message, ...(error instanceof ProtocolError && error.details ? { details: error.details } : {}) } });
    const durationMs = Date.now() - startedAt;
    this.storage.transaction(() => {
      let invocationId = invocation?.id;
      if (!invocation) {
        // Rejected before admission: record the refusal so the transcript stays auditable.
        const created = this.storage.insertInvocation({ runId: run.id, providerCallId: call.callId, name: call.name.slice(0, 100), argumentDigest: "rejected", grantId: null });
        invocationId = created.id;
        this.storage.appendEvent({ sessionId: run.sessionId, runId: run.id, type: "tool.started", payload: { invocationId, callId: call.callId, name: call.name.slice(0, 100), argumentDigest: "rejected", preview: `${call.name} (rejected before execution)`.slice(0, 200) } });
      }
      this.storage.updateInvocation(invocationId, { state: status === "ok" ? "completed" : "failed", exitData: { status, code, durationMs } });
      this.storage.appendEvent({ sessionId: run.sessionId, runId: run.id, type: "tool.completed", payload: { invocationId, callId: call.callId, name: call.name.slice(0, 100), status: status === "unavailable" ? "error" : status, durationMs, resultBytes: Buffer.byteLength(output), truncated: false, errorCode: code } });
      invocation = { id: invocationId };
    });
    return { invocationId: invocation.id, status, output, truncated: false, resultArtifactId: null, hostLost: Boolean(error?.hostUnavailable) };
  }
}

/** Resolve the engine's environment profile for tools (§10.3): explicit executables, not a login shell. */
export function resolveToolEnvironment(env = process.env) {
  const pathValue = env.JOLO_TOOL_PATH ?? env.PATH ?? "/usr/bin:/bin";
  const find = (name) => {
    for (const dir of pathValue.split(":")) {
      const candidate = `${dir}/${name}`;
      try { if (statSync(candidate).isFile()) return candidate; } catch { /* next */ }
    }
    return null;
  };
  const bundled = [path.join(import.meta.dir, 'tgrep'), path.resolve(import.meta.dir, '../../../../vendor/tgrep', `${process.platform}-${process.arch}`, 'tgrep')].find(candidate => {
    try { return statSync(candidate).isFile(); } catch { return false; }
  });
  return { path: pathValue, tgrep: env.JOLO_TGREP === '' ? null : (env.JOLO_TGREP ?? bundled ?? find('tgrep')), ripgrep: env.JOLO_RIPGREP === "" ? null : (env.JOLO_RIPGREP ?? find("rg")), git: env.JOLO_GIT === "" ? null : (env.JOLO_GIT ?? find("git")) };
}
