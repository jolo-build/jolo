import path from "node:path";
import { realpathSync } from "node:fs";
// Codex as a hosted agent, driven through its app-server.
//
// `codex app-server` speaks JSON-RPC over stdio. One Jolo run is one Codex turn on a thread that persists
// across runs (thread/start once, thread/resume after). The thread is opened with approval policy
// "untrusted" and sandbox "workspace-write": every command Codex does not consider trivially safe and every
// patch is put to the host, and those questions become Jolo permission records decided by Jolo's policy or
// by the user, never answered on the user's behalf. Whatever Codex allows on its own (its trusted-command
// list, its hooks) never reaches Jolo, exactly as for Claude Code.
//
// The shapes below were generated from the installed binary (`codex app-server generate-json-schema`) and
// confirmed in live sessions; see the engine's agents README.
import { createHostedTurn, insideWorkspace, digestOf, displayPath, handoffParties, hostedEnvironment, recall, runChoice, spawnLineChild } from "./hosted.js";
import { createSummarizer, handoffPrompt } from "./handoff.js";
import { codexSearchArgs } from '../search/hosted.js';
import { codexBrowserArgs, browserPreview } from '../browser/hosted.js';
import { inlineBrowserInstructions } from '../browser/instructions.js';
import { standaloneChatInstructions } from '../agent/instructions.js';
import { readImages } from '../attachments.js';

const APPROVAL_POLICY = "untrusted";
const SANDBOX = "workspace-write";
const TEXT_ITEMS = new Set(["agentMessage", "plan"]);
const SILENT_ITEMS = new Set(["userMessage", "hookPrompt", "contextCompaction", "enteredReviewMode", "exitedReviewMode", "subAgentActivity"]);
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INTERNAL = -32603;

const friendlyCommand = (item) => (item.commandActions ?? []).map((action) => action?.command).filter(Boolean).join(" && ") || String(item.command ?? "");
const changeSummary = (root, changes) => (changes ?? []).map((change) => ({ kind: change.kind?.type ?? "update", path: displayPath(root, change.path), ...(change.kind?.move_path ? { movePath: displayPath(root, change.kind.move_path) } : {}) }));
const changePaths = (changes) => (changes ?? []).flatMap((change) => [change.path, change.kind?.move_path].filter(Boolean));

/** What a Codex item looks like in the transcript and the invocation record: the essentials, never the whole object. */
export function describeItem(item, root) {
  switch (item.type) {
    case "commandExecution": {
      const input = { command: String(item.command ?? ""), cwd: displayPath(root, item.cwd ?? root) };
      return { input, display: `command ${friendlyCommand(item)}` };
    }
    case "fileChange": {
      const changes = changeSummary(root, item.changes);
      return { input: { changes }, display: `apply_patch ${changes.map((change) => `${change.kind} ${change.path}`).join(", ")}` };
    }
    case "mcpToolCall": return { input: { server: item.server, tool: item.tool, arguments: item.arguments ?? {} }, display: `${item.server}/${item.tool} ${JSON.stringify(item.arguments ?? {})}` };
    case "dynamicToolCall": return { input: { tool: item.tool, arguments: item.arguments ?? {} }, display: `${item.tool} ${JSON.stringify(item.arguments ?? {})}` };
    case "webSearch": return { input: { query: item.query ?? "" }, display: `webSearch ${item.query ?? ""}` };
    default: {
      const { id: _id, type, status: _status, ...rest } = item;
      return { input: rest, display: `${type} ${JSON.stringify(rest)}` };
    }
  }
}

/** How a finished item reads: its output where there is one, otherwise how it ended. */
function itemOutcome(item) {
  const status = item.status ?? (item.success === false ? "failed" : "completed");
  const jolo = status === "declined" ? "denied" : status === "completed" ? "ok" : "error";
  switch (item.type) {
    case "commandExecution": {
      const output = typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : "";
      const exit = item.exitCode === null || item.exitCode === undefined ? "" : `exit ${item.exitCode}`;
      return { status: jolo, text: [output.trimEnd(), status === "declined" ? "declined" : exit].filter(Boolean).join("\n") };
    }
    case "fileChange": return { status: jolo, text: status };
    case "mcpToolCall": {
      // The vendor receives MCP images; Jolo's transcript keeps the artifact metadata, not base64.
      if (!item.error && item.server === 'jolo_browser' && Array.isArray(item.result?.content)) return { status: item.result.isError ? 'error' : jolo, text: item.result.content.filter(part => part.type === 'text').map(part => browserPreview(part.text)).join('\n') };
      return { status: jolo, text: item.error ? String(item.error?.message ?? item.error) : JSON.stringify(item.result ?? null) };
    }
    case "dynamicToolCall": return { status: jolo, text: JSON.stringify(item.contentItems ?? null) };
    default: return { status: jolo, text: status };
  }
}

/**
 * The MCP configurators are absent when the engine hosts neither search nor a browser, and the
 * provider factory and settings only matter to a handoff that summarizes with a model.
 * @param {{ storage: any, catalog: any, permissions: any, supervisor: any, build?: string, log: any,
 *   searchConfig?: (workspace: any, run: any) => any, browserConfig?: (workspace: any, run: any) => any,
 *   providerFactory?: any, settings?: any }} deps
 */
export function createCodexAppServerExecutor({ storage, catalog, permissions, supervisor, build = "dev", log, searchConfig, browserConfig, providerFactory = null, settings = null }) {
  return {
    name: "codex-app-server",
    /** @param {any} ctx @param {any} [answerer] the agent answering this run, when a message called one in (§4.3) */
    async execute(ctx, answerer = null) {
      const { run, signal } = ctx;
      const session = storage.getSession(run.sessionId);
      const workspace = storage.getWorkspace(session.workspaceId);
      const manifest = answerer ?? catalog.get(session.agentId);
      const wanted = runChoice(ctx.run); // what this run was told to use, when a plan task chose it (§6.6)
      const [binary, ...extraArgs] = catalog.command(manifest, wanted); // a user manifest may add Codex's global options, such as -c key=value
      const chosen = catalog.config(manifest, wanted); // Codex takes the model over the protocol rather than as a flag
      const turn = createHostedTurn({ ctx, storage, permissions, manifest, session, workspace });
      const env = hostedEnvironment(supervisor);
      const browserServer = browserConfig?.(workspace, run);
      const developerInstructions = [inlineBrowserInstructions({ available: Boolean(browserServer), hosted: true }), standaloneChatInstructions(storage, session)].filter(Boolean).join('\n\n');

      const state = {
        threadId: null, turnId: null, completed: null, failure: null, done: false,
        items: new Map(), // Codex item id -> item as started (a fileChange approval names only the id)
        texts: new Map(), // agentMessage/plan/reasoning item id -> { messageId, streamed }
        streamed: new Set(), // tool items whose output already arrived as deltas
        usage: { inputTokens: 0, outputTokens: 0, attempts: 1, iterations: 0, contextUsed: null, contextWindow: null },
      };
      const pending = new Map(); // JSON-RPC id -> { resolve, reject }
      let nextId = 1;
      let link;
      const onCancel = () => {
        if (!state.threadId || !state.turnId || state.done) return false;
        request("turn/interrupt", { threadId: state.threadId, turnId: state.turnId }).catch(() => { /* the child may be gone */ });
        return true;
      };
      try {
        link = spawnLineChild({ argv: [binary, ...extraArgs, ...codexSearchArgs(searchConfig?.(workspace, run)), ...codexBrowserArgs(browserServer), "app-server"], cwd: workspace.path, env, signal, onCancel, log, agentId: manifest.id });
      } catch (error) {
        turn.finish({ usage: state.usage });
        return { outcome: "failed", failure: `could not start ${manifest.displayName}: ${error?.message ?? error}` };
      }
      const request = (method, params) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); link.write({ id, method, params }); });
      const respond = (id, result) => link.write({ id, result });
      const refuse = (id, message, code = JSON_RPC_METHOD_NOT_FOUND) => link.write({ id, error: { code, message } });
      const rpcFailure = (error) => String(error?.message ?? error).slice(0, 500);
      const closeTurn = () => { state.done = true; link.end(); link.terminate(); };

      const textMessage = (itemId, kind) => {
        let entry = state.texts.get(itemId);
        if (!entry) { entry = { messageId: ctx.startMessage("assistant", kind), streamed: false, kind }; state.texts.set(itemId, entry); }
        return entry;
      };
      const finishText = (itemId, status = "complete") => {
        const entry = state.texts.get(itemId);
        if (!entry) return;
        ctx.finishMessage(entry.messageId, status);
        state.texts.delete(itemId);
      };

      /** A command Codex wants to run: a process decision, as for Jolo's own shell tool. */
      const decideCommand = async (params) => {
        const command = String(params.command ?? "");
        const cwd = displayPath(workspace.path, params.cwd ?? workspace.path);
        const friendly = friendlyCommand(params);
        const decision = await turn.decide({ toolClass: "process", toolName: "command", summary: `${manifest.displayName}: ${friendly}`, script: command, cwd, argumentDigest: digestOf({ tool: "command", command, cwd }) });
        return decision === null ? "cancel" : decision === "allow" ? "accept" : "decline";
      };
      // External edits need an explicit decision scoped to these paths and patch contents.
      // Keep workspace metadata/symlink policy failures as denials, not approvable edits.
      const decideFiles = async (targets, changes) => {
        const local = [], external = [];
        for (const target of targets) {
          const relative = path.relative(workspace.path, path.resolve(workspace.path, target));
          const canonicalRelative = path.relative(realpathSync(workspace.path), path.resolve(workspace.path, target));
          const outside = value => value === '..' || value.startsWith(`..${path.sep}`);
          (!insideWorkspace(workspace.path, target) && outside(relative) && outside(canonicalRelative) ? external : local).push(target);
        }
        const decision = await turn.decide({ toolClass: "mutation", toolName: "apply_patch", targets: local });
        if (decision !== "allow" || !external.length) return decision;
        const script = JSON.stringify({ paths: targets, changes });
        return turn.decide({ toolClass: "process", toolName: "apply_patch", summary: `${manifest.displayName} wants to edit files outside the workspace: ${external.join(', ')}`, script, cwd: workspace.path, argumentDigest: digestOf({ tool: 'apply_patch', targets, changes }) });
      };
      /** A patch Codex wants to apply: judged by where its files are, like Jolo's own edits. */
      const decidePatch = async (params) => {
        const item = state.items.get(params.itemId);
        if (!item) { log.warn("codex asked about a patch it never announced", { itemId: params.itemId }); return "decline"; }
        const decision = await decideFiles(changePaths(item.changes), item.changes);
        return decision === null ? "cancel" : decision === "allow" ? "accept" : "decline";
      };
      /** Extra sandbox permissions: paths outside the workspace are refused outright; the rest is the user's call. */
      const decidePermissions = async (params) => {
        const profile = params.permissions ?? {};
        const fs = profile.fileSystem ?? {};
        const paths = [...(fs.entries ?? []).map((entry) => entry?.path), ...(fs.read ?? []), ...(fs.write ?? [])].filter((p) => typeof p === "string");
        const outside = await turn.decide({ toolClass: "mutation", toolName: "extra file access", targets: paths });
        if (outside !== "allow") return { permissions: {} };
        const wanted = JSON.stringify(profile);
        const decision = await turn.decide({ toolClass: "process", toolName: "permissions", summary: `${manifest.displayName} asks for extra permissions${params.reason ? `: ${params.reason}` : ""}`, script: wanted, cwd: ".", argumentDigest: digestOf({ tool: "permissions", profile }) });
        return decision === "allow" ? { permissions: profile, scope: "turn" } : { permissions: {} };
      };

      const onServerRequest = async (message) => {
        const { id, method, params = {} } = message;
        switch (method) {
          case "item/commandExecution/requestApproval": return respond(id, { decision: await decideCommand(params) });
          case "item/fileChange/requestApproval": return respond(id, { decision: await decidePatch(params) });
          case "item/permissions/requestApproval": return respond(id, await decidePermissions(params));
          case "execCommandApproval": { // the pre-v2 form, kept for older servers
            const decision = await decideCommand({ command: Array.isArray(params.command) ? params.command.join(" ") : params.command, cwd: params.cwd, commandActions: [] });
            return respond(id, { decision: decision === "accept" ? "approved" : decision === "cancel" ? "abort" : "denied" });
          }
          case "applyPatchApproval": {
            const paths = Object.keys(params.fileChanges ?? {});
            const decision = await decideFiles(paths, params.fileChanges);
            return respond(id, { decision: decision === "allow" ? "approved" : decision === null ? "abort" : "denied" });
          }
          case "item/tool/requestUserInput":
            return refuse(id, "Jolo does not relay questions to the user; ask in your reply instead");
          case "mcpServer/elicitation/request":
            // Codex asks for a second MCP approval even though this server is
            // Jolo's own scoped bridge. Let the actual tool call reach Jolo's
            // dispatcher, which enforces workspace, live-run and browse policy.
            // Never accept external-server forms, URL flows or persistent grants.
            if (browserServer && params.serverName === 'jolo_browser' && params.threadId === state.threadId
              && params.turnId === state.turnId && params.mode === 'form'
              && params._meta?.codex_approval_kind === 'mcp_tool_call'
              && params.requestedSchema?.type === 'object'
              && Object.keys(params.requestedSchema.properties ?? {}).length === 0
              && (params.requestedSchema.required ?? []).length === 0) return respond(id, { action: 'accept', content: {} });
            return refuse(id, "Jolo does not relay questions to the user; ask in your reply instead");
          default:
            return refuse(id, `Jolo does not handle ${method}`);
        }
      };

      const modelActivity = () => {
        // commandExecution stays open for a yielded PTY, even after Codex has
        // returned to the model. Keep its transcript/output open, but stop timing
        // it as a blocked tool call. processId alone does not imply backgrounding.
        for (const item of state.items.values()) {
          if (item.type === "commandExecution") ctx.toolBackgrounded?.(item.id);
        }
        ctx.transition("model");
      };
      const onItemStarted = (item) => {
        state.items.set(item.id, item);
        if (SILENT_ITEMS.has(item.type)) return;
        if (TEXT_ITEMS.has(item.type)) { modelActivity(); textMessage(item.id, "text"); return; }
        if (item.type === "reasoning") { modelActivity(); textMessage(item.id, "reasoning"); return; }
        ctx.transition("tools");
        const { input, display } = describeItem(item, workspace.path);
        turn.toolStarted({ callId: item.id, name: item.type, input, display });
      };
      const onItemCompleted = (item) => {
        state.items.delete(item.id);
        if (SILENT_ITEMS.has(item.type)) return;
        if (TEXT_ITEMS.has(item.type)) {
          const entry = textMessage(item.id, "text");
          if (!entry.streamed && item.text) turn.appendBounded(entry.messageId, item.text); // no deltas arrived for it
          finishText(item.id);
          return;
        }
        if (item.type === "reasoning") {
          const entry = state.texts.get(item.id);
          if (!entry) {
            const summary = (item.summary ?? []).map((part) => (typeof part === "string" ? part : part?.text ?? "")).filter(Boolean).join("\n\n");
            if (summary) turn.appendBounded(textMessage(item.id, "reasoning").messageId, summary);
          }
          finishText(item.id);
          return;
        }
        if (!turn.hasTool(item.id)) { onItemStarted(item); state.items.delete(item.id); } // completed without a start: still worth a record
        const outcome = itemOutcome(item);
        const text = item.type === "commandExecution" && state.streamed.has(item.id) ? outcome.text.split("\n").filter((line) => line.startsWith("exit ") || line === "declined").join("\n") : outcome.text;
        state.streamed.delete(item.id);
        turn.toolFinished(item.id, { text, status: outcome.status });
      };

      const onNotification = (message) => {
        const params = message.params ?? {};
        switch (message.method) {
          case "turn/started": state.turnId ??= params.turn?.id ?? null; return;
          case "item/started": return onItemStarted(params.item ?? {});
          case "item/completed": return onItemCompleted(params.item ?? {});
          case "item/commandExecution/terminalInteraction":
            // Polling/writing a yielded command is a new foreground wait. Give
            // that wait a fresh deadline, until it completes or the model resumes.
            if (state.items.get(params.itemId)?.type === "commandExecution") {
              ctx.toolStarted?.(params.itemId);
              ctx.transition("tools");
            }
            return;
          case "item/agentMessage/delta":
          case "item/plan/delta": {
            const entry = textMessage(params.itemId, "text");
            entry.streamed = true;
            if (params.delta) turn.appendBounded(entry.messageId, params.delta);
            return;
          }
          case "item/reasoning/textDelta":
          case "item/reasoning/summaryTextDelta": {
            const entry = textMessage(params.itemId, "reasoning");
            entry.streamed = true;
            if (params.delta) turn.appendBounded(entry.messageId, params.delta);
            return;
          }
          case "item/reasoning/summaryPartAdded": {
            const entry = state.texts.get(params.itemId);
            if (entry?.streamed) turn.appendBounded(entry.messageId, "\n\n");
            return;
          }
          case "item/commandExecution/outputDelta":
          case "item/fileChange/outputDelta":
            if (params.delta) { state.streamed.add(params.itemId); turn.toolOutput(params.itemId, params.delta); }
            return;
          case "thread/tokenUsage/updated": {
            const last = params.tokenUsage?.last ?? {};
            state.usage.inputTokens += Math.max(0, last.inputTokens ?? 0);
            state.usage.outputTokens += Math.max(0, last.outputTokens ?? 0);
            state.usage.iterations += 1;
            // How full the window is, which is the LAST request's tokens, not the thread's running total: the
            // total only grows, while the window empties whenever Codex compacts the conversation. Reasoning
            // tokens are produced but not sent again, so they do not occupy the window either.
            const inWindow = (last.totalTokens ?? 0) - (last.reasoningOutputTokens ?? 0);
            if (Number.isFinite(inWindow)) state.usage.contextUsed = Math.max(0, inWindow);
            const window = params.tokenUsage?.modelContextWindow;
            if (Number.isFinite(window) && window > 0) state.usage.contextWindow = window;
            return;
          }
          case "error":
            if (!params.willRetry) state.failure ??= String(params.error?.message ?? "Codex reported an error").slice(0, 500);
            return;
          case "turn/completed":
            if (params.turn?.id && state.turnId && params.turn.id !== state.turnId) return; // another turn on the thread; not ours
            state.completed = params.turn ?? { status: "completed" };
            closeTurn();
            return;
          default: return; // thread status, hooks, MCP startup, rate limits: nothing Jolo needs
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
        if (message.id !== undefined) return onServerRequest(message);
        if (message.method) return onNotification(message);
      };

      const drive = async () => {
        await request("initialize", { clientInfo: { name: "jolo", title: "Jolo", version: build }, capabilities: { experimentalApi: false } });
        link.write({ method: "initialized" });
        const remembered = recall(session, manifest).codexThreadId ?? null;
        let thread = null;
        let resumed = false;
        if (remembered) {
          try { thread = (await request("thread/resume", { threadId: remembered, cwd: workspace.path, approvalPolicy: APPROVAL_POLICY, sandbox: SANDBOX, developerInstructions, ...(chosen.model ? { model: chosen.model } : {}) })).thread; resumed = Boolean(thread); }
          catch (error) { log.warn("codex thread could not be resumed; starting a new one", { threadId: remembered, error: rpcFailure(error) }); }
        }
        if (!thread) thread = (await request("thread/start", { cwd: workspace.path, approvalPolicy: APPROVAL_POLICY, sandbox: SANDBOX, developerInstructions, ...(chosen.model ? { model: chosen.model } : {}) })).thread;
        if (!thread?.id) throw new Error("Codex did not return a thread");
        state.threadId = thread.id;
        if (thread.id !== remembered) turn.remember({ codexThreadId: thread.id });
        // Also per turn, so a model changed between turns takes effect on a thread that was resumed.
        const started = await request("turn/start", { threadId: thread.id, input: [{ type: "text", text: await handoffPrompt({ storage, run, session, resumed, ...handoffParties({ catalog, session, manifest, storage, run, model: chosen.model }), summarize: createSummarizer({ providerFactory, settings, log, sessionId: session.id, runId: run.id }) }) }, ...readImages(storage, run).map(image => ({ type: 'localImage', path: image.path }))], ...(chosen.model ? { model: chosen.model } : {}), ...(chosen.effort ? { effort: chosen.effort } : {}) });
        state.turnId ??= started?.turn?.id ?? null;
      };

      ctx.transition("model");
      const driver = drive().catch((error) => { if (!signal.aborted) state.failure ??= `${manifest.displayName}: ${rpcFailure(error)}`; closeTurn(); });
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
      for (const itemId of [...state.texts.keys()]) finishText(itemId, "interrupted");
      turn.finish({ usage: state.usage });

      if (signal.aborted) return { outcome: "cancelled" };
      if (state.failure) return { outcome: "failed", failure: state.failure };
      if (!state.completed) return { outcome: "failed", failure: `${manifest.displayName} exited ${exitCode ?? "?"} before the turn completed${stderr ? `: ${stderr.slice(0, 300)}` : ""}` };
      if (state.completed.status === "completed") return { outcome: "completed" };
      if (state.completed.status === "interrupted") return { outcome: "failed", failure: `${manifest.displayName} interrupted the turn` };
      return { outcome: "failed", failure: String(state.completed.error?.message ?? `turn ${state.completed.status}`).slice(0, 500) };
    },
  };
}
