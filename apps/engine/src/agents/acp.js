import { createHash } from "node:crypto";
// Any agent that speaks the Agent Client Protocol, hosted as a Jolo session.
//
// ACP is JSON-RPC 2.0 over the agent's stdio. Jolo is the client: it calls initialize, session/new (or
// session/load to continue a remembered session) and session/prompt; the agent streams session/update
// notifications, asks session/request_permission before a tool call it is not sure about, and, because
// Jolo offers its file system, calls fs/read_text_file and fs/write_text_file instead of touching disk
// itself. Both of those pass through the workspace boundary, and every permission question is answered by
// Jolo's policy or by the user, never on the user's behalf. What the agent allows on its own (its modes,
// its config, its hooks) never reaches Jolo, exactly as for Claude Code and Codex.
//
// Written against the published schema (schema/v1, protocol version 1) and confirmed against Grok's
// `grok agent stdio`; no vendor library.
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RESULT_DISPLAY_MAX, hostedPath, createHostedTurn, digestOf, handoffParties, hostedEnvironment, insideWorkspace, recall, runChoice, spawnLineChild } from "./hosted.js";
import { createSummarizer, handoffPrompt } from "./handoff.js";
import { acpSearchServers } from '../search/hosted.js';
import { acpBrowserServers } from '../browser/hosted.js';
import { inlineBrowserInstructions } from '../browser/instructions.js';
import { standaloneChatInstructions } from '../agent/instructions.js';
import { readImages, acpImageContent } from '../attachments.js';

export const PROTOCOL_VERSION = 1;
const READ_KINDS = new Set(["read", "search"]);
const MUTATION_KINDS = new Set(["edit", "delete", "move"]);
const FILE_MAX_BYTES = 8 * 1024 * 1024;
const PATH_FIELDS = ["path", "file_path", "filePath", "old_path", "oldPath", "new_path", "newPath", "target_file", "targetFile"];
const RPC = { INVALID_PARAMS: -32602, METHOD_NOT_FOUND: -32601, INTERNAL: -32603, POLICY: -32000 };

/** Paths a tool call reaches: where the agent says it works, plus path-like fields of its raw input. */
export function toolPaths(toolCall) {
  const paths = (toolCall.locations ?? []).map((location) => location?.path);
  const raw = toolCall.rawInput;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) for (const field of PATH_FIELDS) if (typeof raw[field] === "string") paths.push(raw[field]);
  return paths.filter((candidate) => typeof candidate === "string" && candidate);
}

/** Jolo's tool class for an ACP tool kind: the same policy Jolo applies to itself, applied to a guest. */
export function classify(kind, paths) {
  if (READ_KINDS.has(kind)) return "read";
  if (MUTATION_KINDS.has(kind)) return paths.length ? "mutation" : "process"; // an edit that names no file cannot be judged by place
  return "process"; // execute, fetch, think, switch_mode, other, unknown: a decision, never a default allow
}

const contentText = (content) => (Array.isArray(content) ? content : []).map((part) => {
  if (part?.type === "content") return part.content?.type === "text" ? part.content.text ?? "" : `[${part.content?.type ?? "content"}]`;
  if (part?.type === "diff") return `diff ${part.path}`;
  if (part?.type === "terminal") return `[terminal ${part.terminalId}]`;
  return "";
}).filter(Boolean).join("\n");
const rawDetail = (raw) => (raw && typeof raw === "object" ? (typeof raw.command === "string" ? raw.command : JSON.stringify(raw)) : raw === undefined || raw === null ? "" : String(raw));
const callName = (call) => call.kind ?? call.title ?? "tool";

/** The agent's model selector, when it publishes one as a session config option. */
export function modelSelector(configOptions) {
  const option = (Array.isArray(configOptions) ? configOptions : []).find((entry) => entry?.category === "model" && Array.isArray(entry?.options));
  return option ? { id: option.id, current: option.value ?? option.currentValue ?? null, options: option.options.filter((value) => typeof value?.value === "string") } : null;
}

/**
 * The MCP configurators are absent when the engine hosts neither search nor a browser, and the
 * provider factory and settings only matter to a handoff that summarizes with a model.
 * @param {{ storage: any, dispatcher: any, catalog: any, permissions: any, supervisor: any, build?: string, log: any,
 *   searchConfig?: (workspace: any, run: any) => any, browserConfig?: (workspace: any, run: any) => any,
 *   providerFactory?: any, settings?: any }} deps
 */
export function createAcpExecutor({ storage, dispatcher, catalog, permissions, supervisor, build = "dev", log, searchConfig, browserConfig, providerFactory = null, settings = null }) {
  return {
    name: "acp",
    /** @param {any} ctx @param {any} [answerer] the agent answering this run, when a message called one in (§4.3) */
    async execute(ctx, answerer = null) {
      const { run, signal } = ctx;
      const session = storage.getSession(run.sessionId);
      const workspace = storage.getWorkspace(session.workspaceId);
      const browserServer = browserConfig?.(workspace, run);
      const mcpServers = [...acpSearchServers(searchConfig?.(workspace, run)), ...acpBrowserServers(browserServer)];
      const manifest = answerer ?? catalog.get(session.agentId);
      // What this run was told to use, when a plan task chose something other than the agent's default (§6.6).
      const wanted = runChoice(ctx.run);
      const argv = catalog.command(manifest, wanted); // how this vendor starts its ACP agent (Grok: agent stdio), plus the model flags in force
      const chosen = catalog.config(manifest, wanted);
      const turn = createHostedTurn({ ctx, storage, permissions, manifest, session, workspace });
      const env = hostedEnvironment(supervisor);

      const state = {
        sessionId: null, loading: false, stopReason: null, failure: null, done: false,
        text: null, // the open assistant message: { kind: "text" | "reasoning", messageId }
        usage: { inputTokens: 0, outputTokens: 0, attempts: 1, iterations: 1, contextUsed: null, contextWindow: null }, // ACP reports context, not tokens
      };
      const pending = new Map();
      let nextId = 1;
      let link;
      const onCancel = () => {
        if (!state.sessionId || state.done) return false;
        link.write({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: state.sessionId } });
        return true;
      };
      try {
        link = spawnLineChild({ argv, cwd: workspace.path, env, signal, onCancel, log, agentId: manifest.id });
      } catch (error) {
        turn.finish({ usage: state.usage });
        return { outcome: "failed", failure: `could not start ${manifest.displayName}: ${error?.message ?? error}` };
      }
      const request = (method, params) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); link.write({ jsonrpc: "2.0", id, method, params }); });
      const respond = (id, result) => link.write({ jsonrpc: "2.0", id, result });
      const refuse = (id, message, code = RPC.METHOD_NOT_FOUND) => link.write({ jsonrpc: "2.0", id, error: { code, message } });
      const closeTurn = () => { state.done = true; link.end(); link.terminate(); };

      const closeText = (status = "complete") => { if (state.text) { ctx.finishMessage(state.text.messageId, status); state.text = null; } };
      const openText = (kind) => {
        if (state.text?.kind !== kind) { closeText(); state.text = { kind, messageId: ctx.startMessage("assistant", kind) }; if (kind === "text") ctx.transition("model"); }
        return state.text.messageId;
      };

      const onToolUpdate = (update) => {
        if (!turn.hasTool(update.toolCallId)) return;
        const text = contentText(update.content);
        if (update.status === "completed" || update.status === "failed") {
          const detail = text || (update.rawOutput === undefined || update.rawOutput === null ? "" : rawDetail(update.rawOutput).slice(0, RESULT_DISPLAY_MAX));
          turn.toolFinished(update.toolCallId, { text: detail, isError: update.status === "failed" });
        } else if (text) turn.toolOutput(update.toolCallId, `${text}\n`);
      };
      const onToolCall = (call) => {
        closeText();
        ctx.transition("tools");
        if (!turn.hasTool(call.toolCallId)) {
          const detail = rawDetail(call.rawInput);
          const name = callName(call);
          turn.toolStarted({ callId: call.toolCallId, name, input: { kind: call.kind ?? null, title: call.title ?? "", rawInput: call.rawInput ?? null }, display: [name, call.title && call.title !== name ? call.title : null, detail || null].filter(Boolean).join(" ") });
        }
        onToolUpdate(call);
      };

      /** The agent asks before a tool call: Jolo answers with one of the agent's own options, once, never "always". */
      const onPermission = async (id, params) => {
        const call = params.toolCall ?? {};
        if (call.toolCallId && !turn.hasTool(call.toolCallId)) onToolCall(call);
        const paths = toolPaths(call);
        const toolClass = classify(call.kind, paths);
        const decision = await turn.decide({ toolClass, toolName: callName(call), targets: paths, summary: `${manifest.displayName}: ${call.title ?? callName(call)}`, script: rawDetail(call.rawInput), cwd: ".", argumentDigest: digestOf({ kind: call.kind ?? null, rawInput: call.rawInput ?? null }) });
        if (decision === null) return respond(id, { outcome: { outcome: "cancelled" } }); // a cancelled turn must answer every open question this way
        const options = Array.isArray(params.options) ? params.options : [];
        const kind = (name) => options.find((candidate) => candidate?.kind === name);
        // A decision Jolo made covers this one call. "allow_always" would hand the agent a standing permission
        // the user never gave, so an allow is only ever spoken as "allow_once"; when the agent offers nothing
        // else, Jolo says no rather than more than it means. A refusal may be spoken either way: refusing for
        // good is never wider than refusing once.
        const option = decision === "allow"
          ? kind("allow_once")
          : kind("reject_once") ?? options.find((candidate) => typeof candidate?.kind === "string" && candidate.kind.startsWith("reject"));
        if (!option && decision === "allow") {
          log.warn("acp agent offered no single-use approval, so the allowed call was refused", { agentId: manifest.id, kinds: options.map((candidate) => candidate?.kind) });
          const refusal = kind("reject_once") ?? options.find((candidate) => typeof candidate?.kind === "string" && candidate.kind.startsWith("reject"));
          const text = `Jolo policy: ${manifest.displayName} offered no single-use approval for this call, and Jolo never grants a standing one`;
          if (call.toolCallId) turn.toolFinished(call.toolCallId, { text, status: "denied" });
          return respond(id, refusal ? { outcome: { outcome: "selected", optionId: refusal.optionId } } : { outcome: { outcome: "cancelled" } });
        }
        if (!option) {
          log.warn("acp permission request offered no option Jolo could choose", { agentId: manifest.id, decision: "reject", kinds: options.map((candidate) => candidate?.kind) });
          return respond(id, { outcome: { outcome: "cancelled" } });
        }
        if (decision !== "allow" && call.toolCallId) turn.toolFinished(call.toolCallId, { text: decision.deny, status: "denied" });
        respond(id, { outcome: { outcome: "selected", optionId: option.optionId } });
      };

      const insideOrRefuse = (id, target, what) => {
        if (typeof target === "string" && path.isAbsolute(target) && insideWorkspace(workspace.path, target)) return true;
        refuse(id, `Jolo policy: ${what} outside the workspace is not allowed`, RPC.POLICY);
        return false;
      };
      const onReadFile = (id, params) => {
        if (!insideOrRefuse(id, params.path, "reading")) return;
        try {
          permissions.authorize({ toolClass: "read", workspaceId: workspace.id, runId: run.id });
          const target = hostedPath(workspace.path, params.path).absolute;
          if (statSync(target).size > FILE_MAX_BYTES) return refuse(id, "Jolo policy: the file is too large to hand over", RPC.POLICY);
          let content = readFileSync(target, "utf8");
          const line = Number.isInteger(params.line) && params.line > 0 ? params.line : null;
          const limit = Number.isInteger(params.limit) && params.limit > 0 ? params.limit : null;
          if (line || limit) { const lines = content.split("\n"); const start = (line ?? 1) - 1; content = lines.slice(start, limit ? start + limit : undefined).join("\n"); }
          respond(id, { content });
        } catch (error) { refuse(id, String(error?.message ?? error), RPC.INTERNAL); }
      };
      const onWriteFile = async (id, params) => {
        if (!insideOrRefuse(id, params.path, "writing")) return;
        if (typeof params.content !== "string") return refuse(id, "content must be a string", RPC.INVALID_PARAMS);
        try {
          const resolved = hostedPath(workspace.path, params.path, { mustExist: false });
          if (resolved.stat?.size > 2 * 1024 * 1024) return refuse(id, "Jolo policy: the file exceeds the editable size limit", RPC.POLICY);
          const before = resolved.stat ? readFileSync(resolved.absolute) : null;
          const operation = before
            ? { op: "replace", path: resolved.relative, expectedHash: `sha256:${createHash("sha256").update(before).digest("hex")}`, content: params.content }
            : { op: "create", path: resolved.relative, content: params.content };
          const result = await dispatcher.invoke({ run, workspace: { id: workspace.id, root: workspace.path }, signal,
            call: { callId: `acp-write:${id}`, name: "apply_patch", arguments: { operations: [operation] } } });
          if (result.status !== "ok") return refuse(id, JSON.parse(result.output).error?.message ?? "file write failed", RPC.POLICY);
          respond(id, null);
        } catch (error) { refuse(id, String(error?.message ?? error), RPC.INTERNAL); }
      };

      const onAgentRequest = (message) => {
        const { id, method, params = {} } = message;
        switch (method) {
          case "session/request_permission": return onPermission(id, params);
          case "fs/read_text_file": return onReadFile(id, params);
          case "fs/write_text_file": return onWriteFile(id, params);
          default:
            return refuse(id, method.startsWith("terminal/") ? "Jolo does not offer terminals to hosted agents" : `Jolo does not handle ${method}`);
        }
      };
      const onUpdate = (params) => {
        if (state.loading) return; // history replayed by session/load is already in Jolo's transcript
        if (state.sessionId && params.sessionId && params.sessionId !== state.sessionId) return;
        const update = params.update ?? {};
        switch (update.sessionUpdate) {
          case "agent_message_chunk":
          case "agent_thought_chunk": {
            const text = update.content?.type === "text" ? update.content.text ?? "" : `[${update.content?.type ?? "content"}]`;
            if (text) turn.appendBounded(openText(update.sessionUpdate === "agent_message_chunk" ? "text" : "reasoning"), text);
            return;
          }
          case "tool_call": return onToolCall(update);
          case "tool_call_update": return onToolUpdate(update);
          case "usage_update":
            if (Number.isFinite(update.used)) state.usage.contextUsed = Math.max(0, update.used);
            if (Number.isFinite(update.size) && update.size > 0) state.usage.contextWindow = update.size;
            return;
          default: return; // the user's own echo, plans, commands, modes, config, context usage: nothing Jolo needs
        }
      };
      const onMessage = async (message) => {
        if (message.id !== undefined && message.method === undefined) {
          const waiter = pending.get(message.id);
          if (!waiter) return;
          pending.delete(message.id);
          if (message.error) waiter.reject(new Error(String(message.error.message ?? "request failed"))); else waiter.resolve(message.result);
          return;
        }
        if (message.id !== undefined && typeof message.method === "string") return onAgentRequest(message);
        if (message.method === "session/update") return onUpdate(message.params ?? {});
      };

      const drive = async () => {
        const init = await request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false }, clientInfo: { name: "jolo", title: "Jolo", version: build } });
        if (init?.protocolVersion !== PROTOCOL_VERSION) throw new Error(`speaks ACP version ${init?.protocolVersion ?? "?"}; Jolo speaks ${PROTOCOL_VERSION}`);
        if (run.attachments?.some(item => item.mimeType.startsWith('image/')) && !init.agentCapabilities?.promptCapabilities?.image) throw new Error(`${manifest.displayName} does not support image attachments. Choose an agent with image support.`);
        const remembered = recall(session, manifest).acpSessionId ?? null;
        let loaded = null;
        let resumed = false;
        if (remembered && init.agentCapabilities?.loadSession) {
          state.loading = true;
          try { loaded = await request("session/load", { sessionId: remembered, cwd: workspace.path, mcpServers }); state.sessionId = remembered; resumed = true; }
          catch (error) { log.warn("acp session could not be loaded; starting a new one", { agentId: manifest.id, error: String(error?.message ?? error) }); }
          finally { state.loading = false; }
        }
        let configOptions = loaded?.configOptions ?? null;
        if (!state.sessionId) {
          let created;
          try { created = await request("session/new", { cwd: workspace.path, mcpServers }); }
          catch (error) {
            const hint = (init.authMethods ?? []).length ? ` (sign in with ${manifest.displayName}'s own CLI first)` : "";
            throw new Error(`could not open a session${hint}: ${error?.message ?? error}`);
          }
          if (typeof created?.sessionId !== "string") throw new Error("did not return a session id");
          state.sessionId = created.sessionId;
          configOptions = created.configOptions ?? null;
          turn.remember({ acpSessionId: created.sessionId });
        }
        // An agent may take the model over the protocol rather than on its command line. When it offers that
        // selector and knows the configured model, use it; the command-line flag has already covered the rest.
        const selector = modelSelector(configOptions);
        if (chosen.model && selector && selector.options.some((option) => option.value === chosen.model)) {
          try { await request("session/set_config_option", { sessionId: state.sessionId, configId: selector.id, value: chosen.model }); }
          catch (error) { log.warn("acp agent refused the configured model", { agentId: manifest.id, model: chosen.model, error: String(error?.message ?? error) }); }
        }
        const prompt = await handoffPrompt({ storage, run, session, resumed, ...handoffParties({ catalog, session, manifest, storage, run, model: chosen.model }), summarize: createSummarizer({ providerFactory, settings, log, sessionId: session.id, runId: run.id }) });
        const result = await request("session/prompt", { sessionId: state.sessionId, prompt: [{ type: "text", text: `${[inlineBrowserInstructions({ available: Boolean(browserServer), hosted: true }), standaloneChatInstructions(storage, session)].filter(Boolean).join('\n\n')}\n\nCurrent request:\n${prompt}` }, ...acpImageContent(readImages(storage, run))] });
        state.stopReason = typeof result?.stopReason === "string" ? result.stopReason : "end_turn";
        closeTurn();
      };

      ctx.transition("model");
      const driver = drive().catch((error) => { if (!signal.aborted) state.failure ??= `${manifest.displayName}: ${String(error?.message ?? error).slice(0, 500)}`; closeTurn(); });
      try {
        for await (const message of link.messages()) {
          await onMessage(message);
          if (state.done) break;
        }
      } catch (error) {
        state.failure ??= String(error?.message ?? error).slice(0, 500);
      }
      for (const waiter of pending.values()) waiter.reject(new Error(`${manifest.displayName} exited`));
      pending.clear();
      await driver;
      const { exitCode, stderr } = await link.settle();
      closeText(state.stopReason ? "complete" : "interrupted");
      turn.finish({ usage: state.usage });

      if (signal.aborted) return { outcome: "cancelled" };
      if (state.failure) return { outcome: "failed", failure: state.failure };
      if (!state.stopReason) return { outcome: "failed", failure: `${manifest.displayName} exited ${exitCode ?? "?"} before the turn completed${stderr ? `: ${stderr.slice(0, 300)}` : ""}` };
      if (state.stopReason === "refusal") return { outcome: "failed", failure: `${manifest.displayName} refused the request` };
      if (state.stopReason === "cancelled") return { outcome: "failed", failure: `${manifest.displayName} cancelled the turn` };
      return { outcome: "completed" };
    },
  };
}
