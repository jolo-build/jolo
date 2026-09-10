// What every hosted agent shares.
//
// An agent with a structured transport answers a Jolo run over newline-delimited JSON on its stdio. The
// wire formats differ (Claude's stream, Codex's app-server, ACP), but the same things happen every turn:
// the user's prompt becomes a message, the agent's tool calls become invocations and tool messages, its
// permission questions become Jolo permission records decided by policy or by the user, and the turn
// ends with usage recorded. This module holds those parts so each adapter is only its protocol.
import { createHash } from "node:crypto";
import path from "node:path";
import { realpathSync } from "node:fs";
import { resolveWorkspacePath } from "../tools/paths.js";
import { PermissionRequired } from "../permissions/service.js";

/** Vendor config paths, never Jolo's provider credentials. */
export const hostedEnvironment = (supervisor, extra = {}) => supervisor.hostedEnvironment(extra);

export const GRACE_MS = 2_000;
export const TOOL_DISPLAY_MAX_BYTES = 4 * 1024;
export const RESULT_DISPLAY_MAX = 600;
const OUTPUT_DISPLAY_MAX = 4 * 1024;
const PREVIEW_CHUNK = 16 * 1024;

const canonical = (value) => JSON.stringify(value, (_key, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));
export const digestOf = (input) => `sha256:${createHash("sha256").update(canonical(input ?? {})).digest("hex")}`;

/** Resolve aliases above the workspace (for example macOS /var), then apply
 * the same component-by-component symlink and metadata policy as native tools. */
export function hostedPath(root, candidate, options = {}) {
  if (typeof candidate !== "string" || !candidate) throw new Error("a file path is required");
  const base = realpathSync(root);
  const absolute = path.resolve(root, candidate);
  const parts = absolute.split(path.sep).filter(Boolean);
  let ancestor = path.parse(absolute).root;
  for (let i = 0; i <= parts.length; i++) {
    try {
      if (realpathSync(ancestor) === base) return resolveWorkspacePath(base, parts.slice(i).join(path.sep) || ".", options);
    } catch { break; }
    ancestor = path.join(ancestor, parts[i] ?? "");
  }
  throw new Error("path is outside the workspace");
}

export function insideWorkspace(root, candidate) {
  if (typeof candidate !== "string" || !candidate) return true;
  try { hostedPath(root, candidate, { mustExist: false }); return true; }
  catch { return false; }
}

/**
 * What a run was told to be answered with, as an override the catalog understands: a value the task chose, or
 * nothing at all, so the agent's own configuration stands (§6.6).
 */
export const runChoice = (run) => ({
  ...(run?.execution?.model ? { model: run.execution.model } : {}),
  ...(run?.execution?.effort ? { effort: run.execution.effort } : {}),
});

/**
 * What this agent remembers about this conversation. Sessions written before agents could be called into one
 * another's conversations kept their thread id at the top level, so the session's own answerer still finds it.
 */
export const recall = (session, manifest) => session?.agentState?.[manifest.id] ?? (session?.agentId === manifest.id ? session.agentState ?? {} : {});

/**
 * Name the last contributor, which may be a guest rather than the session owner.
 * Older sessions can recover guest identity from the previous message's run.
 */
export function handoffParties({ catalog, session, manifest, model = null, storage, run }) {
  const to = { id: manifest.id, displayName: manifest.displayName, model };
  if (session?.agentState?._jolo?.lastAnswerer) return { from: session.agentState._jolo.lastAnswerer, to };
  const previousMessage = storage?.listMessagesForSession(session.id, { limit: 2 }).messages.toReversed().find(message => message.runId !== run?.id);
  const previousRun = previousMessage?.runId ? storage.getRun(previousMessage.runId) : null;
  const previousId = previousRun?.execution?.agentId ?? session?.agentId;
  if (!previousId || previousId === 'jolo') return { from: null, to };
  try { const previous = catalog.get(previousId); return { from: { id: previous.id, displayName: previous.displayName, model: previousRun?.execution?.model ?? null }, to }; }
  catch { return { from: { id: previousId, displayName: previousId, model: null }, to }; }
}

/** A path as the permission dialog shows it: relative to the workspace when it is inside, as given otherwise. */
export const displayPath = (root, candidate) => (typeof candidate === "string" && insideWorkspace(root, candidate) ? path.relative(root, path.resolve(root, candidate)) || "." : candidate);

/**
 * Spawn a child that speaks newline-delimited JSON on its stdio. Cancelling the run first gives the adapter a
 * chance to say so politely (`onCancel`), then the child is terminated after a grace period.
 * @param {{ argv: string[], cwd: string, env: Record<string, string>, signal: AbortSignal, onCancel?: () => void, log: any, agentId: string }} options
 */
export { spawnLineChild } from "../processes/line-child.js";

/**
 * The Jolo side of one hosted turn: the user's message, tool records, permission decisions, and the wrap-up.
 * @param {{ ctx: any, storage: any, permissions: any, manifest: any, session: any, workspace: any }} deps
 */
export function createHostedTurn({ ctx, storage, permissions, manifest, session, workspace }) {
  const { run, signal } = ctx;
  permissions.grantEdit(workspace.id, run.id); // a task may edit its own workspace; the guest's edits get the same grant (§10.1)
  const userMessage = ctx.startMessage("user", "text");
  ctx.appendText(userMessage, run.prompt);
  ctx.finishMessage(userMessage, "complete");

  const tools = new Map(); // the agent's call id -> { invocationId, messageId, name, startedAt, bytes, shown, truncated }
  const appendBounded = (messageId, text) => { for (let i = 0; i < text.length; i += PREVIEW_CHUNK) ctx.appendText(messageId, text.slice(i, i + PREVIEW_CHUNK)); };
  const qualified = (name) => `${manifest.id}:${name}`;
  /**
   * The grant that admits one process call, spent when it was a single-use approval; throws PermissionRequired
   * when nobody has said yes yet. Both admission paths go through here, so an "allow once" covers exactly one
   * call whether the grant was already on file or the user has just given it.
   */
  const admit = (argumentDigest, toolName) => {
    const grant = permissions.authorize({ toolClass: "process", workspaceId: workspace.id, runId: run.id, argumentDigest, toolName: qualified(toolName) });
    if (grant?.constraints?.once) storage.expireGrant(grant.id); // a one-time approval covers exactly one call
    return grant;
  };

  return {
    appendBounded,
    /**
     * Keep what a later turn needs (the vendor's own session or thread id); never a credential. Kept under the
     * agent's own name, because more than one agent can answer in one conversation (§6.5).
     */
    remember(patch) {
      const mine = { ...recall(session, manifest), ...patch };
      session.agentState = { ...session.agentState, [manifest.id]: mine };
      storage.setSessionAgentState(session.id, session.agentState);
    },
    /**
     * Jolo's answer to "may I do this?": policy first, then the user, never a silent yes. Reads and mutations
     * are judged by where they reach; anything else needs a grant or a decision. Returns "allow", { deny },
     * or null when the run was cancelled while the user was being asked.
     */
    async decide({ toolClass, toolName, targets = [], summary, script, cwd, argumentDigest }) {
      if (toolClass === "read" || toolClass === "mutation") {
        const outside = targets.find((target) => !insideWorkspace(workspace.path, target));
        if (outside !== undefined) return { deny: `Jolo policy: ${toolName} outside the workspace is not allowed` };
        try { permissions.authorize({ toolClass, workspaceId: workspace.id, runId: run.id }); return "allow"; }
        catch (error) { return { deny: `Jolo policy: ${error.message}` }; }
      }
      try {
        admit(argumentDigest, toolName);
        return "allow";
      } catch (error) {
        if (!(error instanceof PermissionRequired)) return { deny: `Jolo policy: ${error?.message ?? "not allowed"}` };
      }
      const permission = permissions.request({ run, workspaceId: workspace.id, tool: { name: qualified(toolName) }, argumentDigest, summary: { summary: summary.slice(0, 500), script: script.slice(0, 4000) }, cwd: cwd ?? "." });
      ctx.transition("awaiting_permission");
      let resolved;
      try { resolved = await permissions.waitForResolution(permission.id, signal); }
      catch { return null; } // cancelled while waiting: the child is being terminated
      ctx.transition("tools");
      if (resolved.state !== "allowed") return { deny: "The user declined this action in Jolo." };
      // Spend the grant the decision just created, so "allow once" covers this call and not the next identical one.
      try { admit(argumentDigest, toolName); }
      catch (error) { return { deny: `Jolo policy: approval is no longer valid (${error.message})` }; }
      return "allow";
    },
    /** The agent began a tool call: an invocation record, a tool.started event, and a tool message to stream into. */
    toolStarted({ callId, name, input, display }) {
      ctx.toolStarted?.(callId);
      const argumentDigest = digestOf(input);
      const shown = display ?? `${name} ${JSON.stringify(input ?? {})}`;
      const invocation = storage.transaction(() => {
        const created = storage.insertInvocation({ runId: run.id, providerCallId: String(callId), name: qualified(name), argumentDigest, grantId: null });
        storage.appendEvent({ sessionId: session.id, runId: run.id, type: "tool.started", payload: { invocationId: created.id, callId: String(callId), name: qualified(name), argumentDigest, preview: shown.slice(0, 200) } });
        return created;
      });
      const messageId = ctx.startMessage("tool", "tool");
      ctx.appendText(messageId, `${shown.slice(0, TOOL_DISPLAY_MAX_BYTES)}\n`);
      tools.set(String(callId), { invocationId: invocation.id, messageId, name, startedAt: Date.now(), bytes: 0, shown: 0, truncated: false });
      return messageId;
    },
    hasTool: (callId) => tools.has(String(callId)),
    /** Output the tool produced while running: shown up to a bound, counted in full. */
    toolOutput(callId, text) {
      const tool = tools.get(String(callId));
      if (!tool || !text) return;
      const bytes = Buffer.byteLength(text);
      tool.bytes += bytes;
      const room = OUTPUT_DISPLAY_MAX - tool.shown;
      if (room <= 0) { tool.truncated = true; return; }
      const piece = text.slice(0, room);
      appendBounded(tool.messageId, piece);
      tool.shown += Buffer.byteLength(piece);
      if (piece.length < text.length) tool.truncated = true;
    },
    /** The tool call ended: close its message, settle the invocation, and say how it went. */
    toolFinished(callId, { text = "", isError = false, status = isError ? "error" : "ok", errorCode } = {}) {
      const tool = tools.get(String(callId));
      if (!tool) return;
      if (text) {
        const shown = text.slice(0, RESULT_DISPLAY_MAX);
        appendBounded(tool.messageId, `${shown}${text.length > shown.length ? "…" : ""}\n`);
        tool.bytes += Buffer.byteLength(text);
        if (text.length > shown.length) tool.truncated = true;
      }
      ctx.finishMessage(tool.messageId, "complete");
      storage.transaction(() => {
        storage.updateInvocation(tool.invocationId, { state: status === "ok" ? "completed" : "failed", exitData: { external: true, isError: status !== "ok" } });
        storage.appendEvent({ sessionId: session.id, runId: run.id, type: "tool.completed", payload: { invocationId: tool.invocationId, callId: String(callId), name: qualified(tool.name), status, durationMs: Date.now() - tool.startedAt, resultBytes: tool.bytes, truncated: tool.truncated, ...(status === "ok" ? {} : { errorCode: errorCode ?? (status === "denied" ? "permission_denied" : "tool_error") }) } });
      });
      tools.delete(String(callId));
      ctx.toolFinished?.(callId);
    },
    /** The turn is over: whatever is still open was interrupted; usage is recorded; nothing was verified. */
    finish({ usage }) {
      for (const [callId, tool] of tools) { ctx.finishMessage(tool.messageId, "interrupted"); tools.delete(callId); }
      const recorded = {
        inputTokens: Math.max(0, usage.inputTokens | 0), outputTokens: Math.max(0, usage.outputTokens | 0),
        attempts: Math.max(1, usage.attempts | 0), iterations: Math.max(0, usage.iterations | 0),
        contextUsed: usage.contextUsed ?? null, contextWindow: usage.contextWindow ?? null,
      };
      storage.transaction(() => {
        storage.updateRunUsage(run.id, recorded);
        storage.appendEvent({ sessionId: session.id, runId: run.id, type: "run.usage", payload: recorded });
        const verification = { status: "not_run", checks: [] };
        storage.setRunVerification(run.id, verification);
        storage.appendEvent({ sessionId: session.id, runId: run.id, type: "run.verification", payload: verification });
      });
    },
  };
}
