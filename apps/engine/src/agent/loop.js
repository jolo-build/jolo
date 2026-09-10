// Agent loop: bounded provider requests, batched tools, durable transcript items.
// Imports no filesystem/process adapters; every tool goes through the dispatcher (§10.1).
import { readFileSync } from "node:fs";
import path from "node:path";
import { resolveModelRef } from '../providers/index.js';
import { portableItems } from '../providers/transcript.js';
import { buildRequest } from "../context/builder.js";
import { compact, providerItems } from "../context/compaction.js";
import { hydrateRequestImages } from '../attachments.js';
import { applicationInstructions } from "./instructions.js";
import { newId } from "../storage/index.js";
import { joloHandoff } from "../agents/handoff.js";
import { askedOf } from "../agents/history.js";

const PROVIDER_RETRIES = 2;
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 4_000;
const READ_CONCURRENCY = 2;
const REPO_INSTRUCTIONS_MAX_BYTES = 16 * 1024;
const TOOL_DISPLAY_MAX_BYTES = 4 * 1024;

const sleep = (ms, signal) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
});

function readRepoInstructions(root) {
  for (const name of ["AGENTS.md", "JOLO.md"]) {
    try {
      const text = readFileSync(path.join(root, name), "utf8");
      return text.length > REPO_INSTRUCTIONS_MAX_BYTES ? `${text.slice(0, REPO_INSTRUCTIONS_MAX_BYTES)}\n[truncated]` : text;
    } catch { /* next */ }
  }
  return null;
}

/**
 * @param {{ storage: any, dispatcher: any, registry: any, providerFactory: any, settings: any, permissions: any, interactiveClients: () => number, log: any, sleepImpl?: typeof sleep }} deps
 */
export function createAgentExecutor(deps) {
  const { storage, dispatcher, registry, providerFactory, settings, permissions, log } = deps;
  const interactiveClients = deps.interactiveClients ?? (() => 0);
  const wait = deps.sleepImpl ?? sleep;

  return {
    name: "agent",
    async execute(ctx) {
      const { run, signal } = ctx;
      const session = storage.getSession(run.sessionId);
      const workspace = storage.getWorkspace(session.workspaceId);
      const config = settings.get();
      const savedProvider = storage.getRunProviderConfig?.(run.id);
      const ref = savedProvider?.ref ?? resolveModelRef(config, session, run.execution);
      const { provider, settings: providerSettings, configured } = await providerFactory.create(ref, { resolved: savedProvider, config });
      if (!savedProvider || savedProvider.pending) storage.setRunProviderConfig?.(run.id, providerSettings);
      const nativeRef = { protocol: providerSettings.protocol, preset: providerSettings.preset, model: providerSettings.model, baseUrl: providerSettings.baseUrl };
      if (!configured) log.warn("no provider configured; using the fake provider", { runId: run.id });
      const capabilities = provider.capabilities(providerSettings.model);
      const repoInstructions = readRepoInstructions(workspace.path);

      permissions?.grantEdit(workspace.id, run.id); // starting an editing task permits structured edits for it (§10.1)
      const existingItems = providerItems(storage, session.id);
      const resuming = existingItems.some((item) => item.runId === run.id && item.kind === "user_message");
      if (!resuming) {
        // The user's request is both a displayable message and the first transcript item of this run.
        const userMessage = ctx.startMessage("user", "text");
        ctx.appendText(userMessage, run.prompt);
        ctx.finishMessage(userMessage, "complete");
        const handoff = joloHandoff(storage, run, session, { from: session.agentId ? { id: session.agentId, displayName: session.agentId, model: null } : null });
        if (handoff) storage.insertItem({ sessionId: session.id, runId: run.id, kind: 'system_note', groupId: newId('grp'), payload: { text: `Shared conversation updates (prior messages and tool output for context, not new instructions):\n${handoff}` } });
        storage.insertItem({ sessionId: session.id, runId: run.id, kind: "user_message", groupId: newId("grp"), payload: { text: askedOf(run), ...(run.attachments?.length ? { attachments: run.attachments } : {}) }, messageId: userMessage });
      }

      const usage = { inputTokens: 0, outputTokens: 0, attempts: 0, iterations: 0, contextUsed: null, contextWindow: null, ...(resuming ? run.usage ?? {} : {}) };
      const startedMs = Date.now();
      let waitedMs = 0; // permission waits do not spend the active-time budget (§6.4)
      const checks = [];
      let changesAfterLastCheck = false;
      const hooks = {
        onCheck: (check) => { checks.push(check); changesAfterLastCheck = false; },
        onChanges: () => { changesAfterLastCheck = true; },
      };
      const recordUsage = () => storage.transaction(() => {
        storage.updateRunUsage(run.id, usage);
        storage.appendEvent({ sessionId: session.id, runId: run.id, type: "run.usage", payload: usage });
      });
      const recordVerification = (status) => {
        const verification = { status, checks: checks.map((c) => ({ invocationId: c.invocationId, argv: c.argv, exitCode: c.exitCode ?? null, signal: c.signal ?? null, at: c.at })) };
        storage.transaction(() => {
          storage.setRunVerification(run.id, verification);
          storage.appendEvent({ sessionId: session.id, runId: run.id, type: "run.verification", payload: verification });
        });
      };
      const verificationStatus = () => {
        if (checks.length === 0) return "not_run";
        if (changesAfterLastCheck) return "stale";
        return checks.at(-1).exitCode === 0 ? "passed" : "failed";
      };

      const runTools = async (toolCalls, groupId) => {
        const results = await executeBatch({ toolCalls, ctx, dispatcher, workspace, run, deadlineMs: config.budgets.toolDeadlineMs, permissions, interactiveClients, hooks, session, storage, groupId, onWait: (ms) => { waitedMs += ms; } });
        return results;
      };

      // On resume, finish tool calls that were admitted but never answered before continuing (§6.2).
      if (resuming) {
        const lastGroup = existingItems.at(-1)?.groupId;
        const pending = existingItems.filter((item) => item.groupId === lastGroup && item.kind === "tool_call" && !existingItems.some((r) => r.kind === "tool_result" && r.payload.callId === item.payload.callId));
        if (pending.length) {
          ctx.transition("tools");
          const outcome = await runTools(pending.map((item) => ({ callId: item.payload.callId, name: item.payload.name, arguments: item.payload.arguments })), lastGroup);
          if (outcome.pause) { recordVerification("interrupted"); return outcome.pause; }
          if (signal.aborted) return { outcome: "cancelled" };
        }
      }

      let turnIndex = storage.countModelTurns(session.id);
      for (;;) {
        if (signal.aborted) { recordVerification("interrupted"); return { outcome: "cancelled" }; }
        if (usage.iterations >= config.budgets.maxIterations) return { outcome: "paused", pauseReason: "budget", detail: `iteration budget of ${config.budgets.maxIterations} reached` };
        if (Date.now() - startedMs - waitedMs >= config.budgets.maxActiveMs) return { outcome: "paused", pauseReason: "budget", detail: "active-time budget reached" };
        usage.iterations += 1;
        ctx.transition("model");

        let built;
        let contextItems = portableItems(providerItems(storage, session.id), nativeRef);
        const build = () => {
          const tools = registry.declarations({ browserAvailable: dispatcher.hasBrowser(workspace.id) });
          const instructions = applicationInstructions({ workspaceRoot: workspace.path, toolNames: tools.map(tool => tool.name), standalone: storage.getProject?.(session.projectId)?.preferences?.standalone === true });
          return buildRequest({ capabilities, items: contextItems, tools, instructions, repoInstructions, sessionId: session.id, runId: run.id, reasoningEffort: providerSettings.reasoningEffort });
        };
        try {
          built = build();
          if (built.accounting.nearLimit) {
            // Compact at this complete boundary (§7.2); a failure here is reported, not hidden.
            const checkpoint = await compact({ storage, provider, capabilities, session, run, items: contextItems, fixedTokens: built.accounting.fixedTokens, signal, reason: built.accounting.droppedItems > 0 ? "request exceeded the usable window" : "usage approached the usable window", log, reasoningEffort: providerSettings.reasoningEffort });
            if (checkpoint) { contextItems = portableItems(providerItems(storage, session.id), nativeRef); built = build(); }
          }
        } catch (error) {
          return { outcome: "failed", failure: error.message };
        }
        built.request.turnIndex = turnIndex++;
        // How full the window was for this request, so a client can show it without guessing (§7.2).
        usage.contextUsed = built.accounting.estimatedInputTokens;
        usage.contextWindow = built.accounting.usableInputTokens;

        let turn = await modelTurn({ ctx, provider, providerSettings, request: hydrateRequestImages(storage, built.request), usage, wait, log, storage, session, run });
        if (turn.outcome === 'context_length') {
          // The rejected request did not fit, whatever the byte estimate said. The window becomes the smaller of
          // the stated maximum and the estimated size of that request, older history is compacted to fit, and
          // the turn is retried once (§7.2). A later rejection shrinks it again.
          const reported = turn.contextWindowTokens;
          const assumed = built.accounting.estimatedInputTokens + capabilities.maxOutputTokens + Math.max(4_000, Math.ceil(capabilities.contextWindowTokens * 0.02));
          const window = Math.min(capabilities.contextWindowTokens, reported || Infinity, assumed);
          const learned = window < capabilities.contextWindowTokens;
          if (learned) {
            capabilities.contextWindowTokens = window;
            providerSettings.contextWindowTokens = window;
            storage.setRunProviderConfig?.(run.id, providerSettings);
            providerFactory.learn?.(providerSettings, window);
          }
          try {
            const checkpoint = await compact({ storage, provider, capabilities, session, run, items: contextItems, fixedTokens: built.accounting.fixedTokens, signal, reason: learned ? `provider rejected the request as too long; the context window is now taken to be ${window} tokens` : 'provider rejected the request as too long', log, reasoningEffort: providerSettings.reasoningEffort });
            if (!checkpoint && !learned) throw new Error(`the request exceeds the model context limit and no older history can be compacted (${turn.failure})`);
            contextItems = portableItems(providerItems(storage, session.id), nativeRef);
            built = build();
            if (!checkpoint && built.accounting.droppedItems) throw new Error('The latest request exceeds the model context limit');
            built.request.turnIndex = turnIndex - 1;
            usage.contextUsed = built.accounting.estimatedInputTokens;
            usage.contextWindow = built.accounting.usableInputTokens;
            turn = await modelTurn({ ctx, provider, providerSettings, request: hydrateRequestImages(storage, built.request), usage, wait, log, storage, session, run });
          } catch (error) { recordUsage(); return { outcome: 'failed', failure: error.message }; }
        }
        if (turn.outcome !== "ok") { recordUsage(); return { ...turn, outcome: turn.outcome === 'context_length' ? 'failed' : turn.outcome }; }
        recordUsage();

        // Persist the turn in emission order so the next request replays it faithfully (§7.1).
        const groupId = newId("grp");
        for (const entry of turn.outputs) {
          if (entry.kind === "reasoning") storage.insertItem({ sessionId: session.id, runId: run.id, kind: "reasoning", groupId, payload: { native: entry.native, nativeRef }, messageId: entry.messageId ?? null });
          else if (entry.kind === "assistant_message") storage.insertItem({ sessionId: session.id, runId: run.id, kind: "assistant_message", groupId, payload: { text: entry.text }, messageId: entry.messageId });
          else if (entry.kind === "tool_call") storage.insertItem({ sessionId: session.id, runId: run.id, kind: "tool_call", groupId, payload: { callId: entry.callId, name: entry.name, arguments: entry.arguments, native: entry.native ?? null, ...(entry.native ? { nativeRef } : {}) } });
        }
        const toolCalls = turn.outputs.filter((entry) => entry.kind === "tool_call");
        if (toolCalls.length === 0) {
          recordVerification(verificationStatus());
          return { outcome: "completed" };
        }

        ctx.transition("tools");
        const outcome = await runTools(toolCalls, groupId);
        if (outcome.pause) { recordVerification("interrupted"); return outcome.pause; }
        if (signal.aborted) { recordVerification("interrupted"); return { outcome: "cancelled" }; }
      }
    },
  };
}

// Provider chunks can be larger than the UI preview frame; split at Unicode boundaries.
function appendProviderText(ctx, message, text) {
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + 8000);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    ctx.appendText(message, text.slice(start, end));
    start = end;
  }
}

/** One model turn with bounded retries at request boundaries (§7.3). */
async function modelTurn({ ctx, provider, providerSettings, request, usage, wait, log, storage, session, run }) {
  for (let attempt = 1; attempt <= 1 + PROVIDER_RETRIES; attempt += 1) {
    usage.attempts += 1;
    const attemptEvent = (status, reason) => storage.appendEvent({ sessionId: session.id, runId: run.id, type: "provider.attempt", payload: { attempt, provider: provider.name, preset: providerSettings.preset, model: providerSettings.model, status, ...(reason ? { reason: reason.slice(0, 200) } : {}) } });
    attemptEvent("started");
    const outputs = [];
    let textMessage = null;
    let text = "";
    let reasoningMessage = null;
    let reasoningText = "";
    let error = null;
    let finishedReason = null;
    const partial = () => outputs.length > 0 || text.length > 0;
    try {
      for await (const event of provider.stream(request, ctx.signal)) {
        if (ctx.signal.aborted) break;
        switch (event.type) {
          case "text_delta":
            if (!event.text) break; // an empty chunk must not become an empty assistant turn in the replayed history
            if (!textMessage) textMessage = ctx.startMessage("assistant", "text");
            appendProviderText(ctx, textMessage, event.text);
            text += event.text;
            if (outputs.at(-1)?.kind === 'assistant_message') outputs.at(-1).text += event.text;
            else outputs.push({ kind: 'assistant_message', text: event.text, messageId: textMessage });
            break;
          case "reasoning_delta":
            if (!reasoningMessage) reasoningMessage = ctx.startMessage("assistant", "reasoning");
            appendProviderText(ctx, reasoningMessage, event.text);
            reasoningText += event.text;
            break;
          case "reasoning_complete":
            break;
          case "continuation_item":
            if (event.native?.type === "reasoning") outputs.push({ kind: "reasoning", native: event.native, messageId: reasoningMessage });
            else if (event.native?.type === "function_call") { const call = outputs.find((o) => o.kind === "tool_call" && o.callId === event.native.call_id); if (call) call.native = { id: event.native.id }; }
            break;
          case "tool_call_delta":
            break;
          case "tool_call_complete":
            outputs.push({ kind: "tool_call", callId: event.callId, name: event.name, arguments: event.arguments });
            break;
          case "usage":
            usage.inputTokens += event.inputTokens ?? 0;
            usage.outputTokens += event.outputTokens ?? 0;
            if (event.cachedInputTokens !== undefined) usage.cachedInputTokens = (usage.cachedInputTokens ?? 0) + event.cachedInputTokens;
            break;
          case "finished":
            finishedReason = event.reason;
            break;
          case "error":
            error = event;
            break;
          default:
            break;
        }
        if (error || finishedReason) break;
      }
    } catch (caught) {
      error = { category: "internal", retryable: false, message: String(caught?.message ?? caught) };
      log.error("provider stream threw", { runId: run.id, error: String(caught?.stack ?? caught) });
    }
    if (ctx.signal.aborted) {
      if (textMessage) ctx.finishMessage(textMessage, "interrupted");
      if (reasoningMessage) ctx.finishMessage(reasoningMessage, "interrupted");
      attemptEvent("interrupted", "cancelled");
      return { outcome: "cancelled" };
    }
    if (!error && !finishedReason) error = { category: 'network', retryable: true, message: 'stream ended without a completion event' };
    if (error) {
      if (textMessage) ctx.finishMessage(textMessage, "interrupted");
      if (reasoningMessage) ctx.finishMessage(reasoningMessage, "interrupted");
      if (error.category === 'context_length') {
        attemptEvent('failed', error.message);
        return { outcome: 'context_length', contextWindowTokens: error.contextWindowTokens, failure: `provider context_length: ${error.message ?? 'request too long'}`.slice(0, 500) };
      }
      const canRetry = error.retryable && attempt <= PROVIDER_RETRIES;
      attemptEvent(canRetry ? "retrying" : "failed", `${error.category}: ${error.message ?? ""}`);
      if (!canRetry) return { outcome: "failed", failure: `provider ${error.category}: ${error.message ?? "error"}`.slice(0, 500) };
      // A partial response is kept as an interrupted attempt; the next attempt starts fresh (§7.3).
      if (partial()) log.warn("partial provider response discarded before retry", { runId: run.id, attempt });
      await wait(Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempt - 1)), ctx.signal);
      continue;
    }
    if (reasoningMessage) ctx.finishMessage(reasoningMessage, "complete");
    if (textMessage) ctx.finishMessage(textMessage, "complete");
    if (finishedReason && finishedReason.startsWith("incomplete:")) {
      attemptEvent("failed", finishedReason);
      return { outcome: "failed", failure: `provider response ${finishedReason}` };
    }
    attemptEvent("completed");
    return { outcome: "ok", outputs, reasoningText };
  }
  return { outcome: "failed", failure: "provider retries exhausted" };
}

/**
 * Execute a batch: independent reads two at a time, everything else sequentially (§6.3). Each call gets a
 * live display message; process tools stream output into it. Permission requests wait for an interactive
 * decision or pause the run (§10.1). Returns { results, pause? }.
 */
async function executeBatch({ toolCalls, ctx, dispatcher, workspace, run, deadlineMs, permissions, interactiveClients, hooks, session, storage, groupId, onWait }) {
  const results = new Array(toolCalls.length);
  const isRead = (call) => ["read", "browser_read"].includes(dispatcher.executionClass(call.name));
  let pause = null;
  let next = 0;
  const persistResult = (call, result, display) => {
    ctx.finishMessage(display, "complete");
    storage.insertItem({ sessionId: session.id, runId: run.id, kind: "tool_result", groupId, payload: { callId: call.callId, invocationId: result.invocationId, output: result.output, truncated: result.truncated, resultArtifactId: result.resultArtifactId }, invocationId: result.invocationId, messageId: display });
  };
  const runOne = async (call) => {
    const display = ctx.startMessage("tool", "tool");
    ctx.appendText(display, `${call.name} ${JSON.stringify(call.arguments).slice(0, 200)}\n`);
    let displayed = 0;
    const onOutput = (text) => {
      if (displayed >= TOOL_DISPLAY_MAX_BYTES) return;
      const slice = text.slice(0, TOOL_DISPLAY_MAX_BYTES - displayed);
      displayed += slice.length;
      ctx.appendText(display, slice);
      if (displayed >= TOOL_DISPLAY_MAX_BYTES) ctx.appendText(display, "\n[live output truncated; full output stored]\n");
    };
    for (;;) {
      const result = await dispatcher.invoke({ run, workspace: { id: workspace.id, root: workspace.path }, call, signal: ctx.signal, deadlineMs, onOutput, messageId: display, hooks });
      if (result.status !== "permission_required") {
        if (displayed === 0 || !result.output.startsWith("{\"ok\":true")) ctx.appendText(display, `${result.output.slice(0, TOOL_DISPLAY_MAX_BYTES)}${result.output.length > TOOL_DISPLAY_MAX_BYTES ? "\n[display truncated]" : ""}\n`);
        else ctx.appendText(display, `\n${result.output.slice(0, 600)}${result.output.length > 600 ? "…" : ""}\n`);
        persistResult(call, result, display);
        return result;
      }
      if (interactiveClients() === 0) {
        ctx.appendText(display, "[waiting for permission; no interactive client is attached]\n");
        ctx.finishMessage(display, "interrupted");
        pause = { outcome: "paused", pauseReason: "permission", permissionId: result.permissionId, detail: `${call.name} needs approval` };
        return null;
      }
      ctx.transition("awaiting_permission");
      const waitStart = Date.now();
      let permission;
      try {
        permission = await permissions.waitForResolution(result.permissionId, ctx.signal);
      } catch {
        ctx.finishMessage(display, "interrupted");
        return null; // cancelled
      } finally {
        onWait?.(Date.now() - waitStart);
      }
      ctx.transition("tools");
      if (permission.state === "allowed") continue; // the decision created a grant; re-authorize and execute
      const denied = dispatcher.deny({ run, call, reason: "the user declined this command" });
      ctx.appendText(display, "[declined by the user]\n");
      persistResult(call, denied, display);
      pause = { outcome: "paused", pauseReason: "user", detail: `${call.name} was declined` };
      return denied;
    }
  };
  const worker = async () => {
    for (;;) {
      const index = next;
      if (index >= toolCalls.length || pause || ctx.signal.aborted) return;
      next += 1;
      const call = toolCalls[index];
      const result = await runOne(call);
      if (result) results[index] = { call, ...result };
    }
  };
  const concurrency = toolCalls.every(isRead) ? Math.min(READ_CONCURRENCY, toolCalls.length) : 1;
  await Promise.all(Array.from({ length: concurrency }, worker));
  const hostLost = results.some((r) => r?.hostLost);
  if (!pause && hostLost) pause = { outcome: "paused", pauseReason: "browser_host_unavailable", detail: "the inline browser host went away; reopen the browser and resume" };
  return { results: results.filter(Boolean), pause };
}
