// Claude Code as a hosted agent, driven through its structured stream.
//
// One Jolo run is one Claude turn, and one conversation is one Claude process (see claude-link.js). The child
// speaks NDJSON on stdout, is fed NDJSON on stdin, and asks the host for permission over a control channel.
// That channel is the point: Claude's own approval prompts land in Jolo's permission records, so the dialog,
// the board and notifications work exactly as for Jolo's tools, and Jolo's grants decide. What Claude allows
// on its own (its rules and hooks) never reaches us, and what it asks about is answered here by policy or by
// the user. Jolo never answers on the user's behalf.
//
// Every shape below was read from the installed binary and confirmed against a live session; see the
// initialize/can_use_tool/control_response forms in the engine's agents README.
import { createHostedTurn, digestOf, handoffParties, hostedEnvironment, insideWorkspace, recall, runChoice } from "./hosted.js";
import { compactRequested, createSummarizer, handoffPrompt, slashCommand } from "./handoff.js";
import { randomUUID } from "node:crypto";
import { compactingAfter, createHostedLinks, EMPTY_RESULT_GRACE_MS, HAND_BACK, isSubagentRequest, retryDelay, turnNotice } from "./claude-link.js";
import { browserPreview } from '../browser/mcp.js';
import { inlineBrowserInstructions } from '../browser/instructions.js';
import { standaloneChatInstructions } from '../agent/instructions.js';
import { readImages, claudeImageContent } from '../attachments.js';

export { insideWorkspace };

const MUTATION_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "TodoWrite", "TodoRead"]);
const PROCESS_TOOLS = new Set(["Bash", "PowerShell"]);
/** Claude's own subagents run inside one of these calls; older builds name it Task. */
const SUBAGENT_TOOLS = new Set(["Agent", "Task"]);
/**
 * A subagent's progress is written into its parent call's output, one line each, before its report: the model it runs
 * on, then each tool it uses. The desktop reads these lines back by this prefix; a blank line comes before the report.
 */
export const SUBAGENT_LINE = "↳ ";
const SUBAGENT_DISPLAY_MAX = 16 * 1024;
const SUBAGENT_STEPS_MAX = 150;
/** Progress stops short of the call's bound, whole lines only, and says so once in the room kept for it. */
const SUBAGENT_PROGRESS_MAX = SUBAGENT_DISPLAY_MAX - 64;
const SUBAGENT_MORE = `${SUBAGENT_LINE}… more steps not shown\n`;

/** The head of a subagent call: what it is for and which kind of agent runs it, kept short enough to stay whole. */
const subagentDisplay = (name, input) => `${name} ${JSON.stringify({ subagent_type: input?.subagent_type, description: input?.description, model: input?.model, prompt: String(input?.prompt ?? "").slice(0, 600) })}`;

/** A run that carries a turn the process began by itself rather than a message of the user's. */
export const CONTINUATION_PREFIX = "continue:";
export const isContinuation = (run) => typeof run?.requestId === "string" && run.requestId.startsWith(CONTINUATION_PREFIX);
/** What a continuation that was paused and then resumed says: what it was continuing was stopped when it paused. */
/** Claude Code commands Jolo answers itself: the model, effort and fast mode are Jolo's to choose. */
export const JOLO_OWNED_COMMANDS = new Set(["model", "effort", "fast"]);
/** How long a run stays open for a Jolo tool call it allowed that never reports back. */
const JOLO_CALL_HOLD_MS = 10 * 60_000;
export const RESUMED_CONTINUATION = "Jolo paused this and the user has resumed it. Carry on where you left off.";

/**
 * How long an empty result (no model call behind it) is given to be followed by the real answer before it is
 * taken as the end of the turn. A resumed binary sends one when it reports a task left from an earlier process.
 */
export { EMPTY_RESULT_GRACE_MS };

/** Jolo's tool classes for Claude's tools: the same policy Jolo applies to itself, applied to a guest. */
export function classify(toolName) {
  if (PROCESS_TOOLS.has(toolName)) return "process";
  if (MUTATION_TOOLS.has(toolName)) return "mutation";
  if (READ_TOOLS.has(toolName)) return "read";
  return "process"; // network, MCP, subagents and anything unknown: a decision, never a default allow
}

/** What the permission dialog shows for a Claude tool: a command line where there is one, a path where there is one. */
export function describeTool(toolName, input) {
  if (PROCESS_TOOLS.has(toolName) && typeof input?.command === "string") return { summary: `${toolName}: ${input.command}`, script: input.command };
  const target = input?.file_path ?? input?.path ?? input?.url ?? input?.pattern;
  return { summary: `${toolName}${target ? ` ${target}` : ""}`, script: `${toolName} ${JSON.stringify(input ?? {})}` };
}

/**
 * One call's usage as Claude Code itself merges it: message_start carries what was sent, and a message_delta's
 * input counts replace those only when positive, since some providers send them empty; the output is the delta's.
 */
const mergedUsage = (start, delta) => ({
  input_tokens: delta.input_tokens > 0 ? delta.input_tokens : start?.input_tokens ?? 0,
  cache_creation_input_tokens: delta.cache_creation_input_tokens > 0 ? delta.cache_creation_input_tokens : start?.cache_creation_input_tokens ?? 0,
  cache_read_input_tokens: delta.cache_read_input_tokens > 0 ? delta.cache_read_input_tokens : start?.cache_read_input_tokens ?? 0,
  output_tokens: delta.output_tokens ?? start?.output_tokens ?? 0,
});

/** How full the window was at one model call: everything it was sent, plus what it wrote back into the window. */
const contextOf = (call) => (call ? (call.input_tokens ?? 0) + (call.cache_creation_input_tokens ?? 0) + (call.cache_read_input_tokens ?? 0) + (call.output_tokens ?? 0) : null);

/** A result with no model call behind it: nothing was answered, so it cannot be the end of an answer. */
const emptyResult = (message) => !message.is_error && (message.num_turns ?? 0) === 0;

/** The stream-json host mode, as the binary spells it. Exported so model discovery can open the same channel. */
export const claudeArgv = (binary, extraArgs, claudeSessionId = null) => [
  binary, ...extraArgs, "--print", "--verbose",
  "--output-format", "stream-json", "--input-format", "stream-json", "--include-partial-messages",
  // The binary echoes each message as it starts on it, so a run can tell its own turn from one the process began by itself.
  "--replay-user-messages",
  "--permission-prompts", "host", "--permission-prompt-tool", "stdio",
  ...(claudeSessionId ? ["--resume", claudeSessionId] : []),
];

/**
 * The MCP configurators are absent when the engine hosts neither search nor a browser, and the
 * provider factory and settings only matter to a handoff that summarizes with a model. `links` is the
 * engine's registry of conversation processes; an executor built without one keeps its own.
 * @param {{ storage: any, catalog: any, permissions: any, supervisor: any, log: any,
 *   mcpConfig?: (workspace: any, run: any, owner?: string) => { server: any, hasBrowser: boolean, hasSearch: boolean } | null,
 *   providerFactory?: any, settings?: any, links?: any, revoke?: (owner: string) => void, emptyResultGraceMs?: number }} deps
 */
export function createClaudeStreamExecutor({ storage, catalog, permissions, supervisor, log, mcpConfig, providerFactory = null, settings = null, links = null, revoke = () => {}, emptyResultGraceMs = EMPTY_RESULT_GRACE_MS }) {
  const registry = links ?? createHostedLinks({ log });
  return {
    name: "claude-stream",
    links: registry,
    /** @param {any} ctx @param {any} [answerer] the agent answering this run, when a message called one in (§4.3) */
    async execute(ctx, answerer = null) {
      const { run, signal } = ctx;
      const session = storage.getSession(run.sessionId);
      const workspace = storage.getWorkspace(session.workspaceId);
      const manifest = answerer ?? catalog.get(session.agentId);
      const [binary, ...extraArgs] = catalog.command(manifest, runChoice(ctx.run)); // the --model/--effort in force, plus any the manifest adds
      // A continuation takes up what the process began by itself; once paused and resumed there is nothing left to take
      // up (the pause stopped it), so the resumed attempt asks Claude to carry on, as a message of its own.
      const continuation = isContinuation(run) && run.attempt <= 1;
      const resumeNote = isContinuation(run) && !continuation ? RESUMED_CONTINUATION : null;
      // The same process serves the conversation while it would be started the same way; a new model or
      // effort, or another agent, means a new process that resumes the same Claude session.
      const identity = JSON.stringify([manifest.id, binary, extraArgs, Boolean(mcpConfig)]);
      const owner = `link:${session.id}`;
      // Claude's own model, effort and fast switches would change the process behind Jolo's back and be undone when it
      // restarts: Jolo's model menu is where they are chosen. Answering one never touches the process, or the work it runs.
      const asked = continuation ? null : slashCommand(run);
      if (asked && JOLO_OWNED_COMMANDS.has(asked.name)) {
        const turn = createHostedTurn({ ctx, storage, permissions, manifest, session, workspace, scratch: null });
        const messageId = ctx.startMessage("assistant", "text");
        turn.appendBounded(messageId, `Use the model menu in Jolo to change the ${asked.name === "fast" ? "fast mode" : asked.name}: Claude Code's own /${asked.name} would be undone whenever this conversation's process restarts.`);
        ctx.finishMessage(messageId, "complete");
        turn.finish({ usage: { inputTokens: 0, outputTokens: 0, attempts: 1, iterations: 0, contextUsed: null, contextWindow: null } });
        return { outcome: "completed", carried: false };
      }

      const remembered = recall(session, manifest).claudeSessionId ?? null;
      let link = registry.get(session.id);
      if (link && !link.alive) { await link.closed; link = null; }
      // A new model, effort or agent means a new process. A turn the old one began by itself and holds for a run is not
      // lost with it: this run takes that turn and answers on the old process, and the next run switches.
      if (link && link.identity !== identity && !link.pending) { await link.close({ reason: "agent configuration changed" }); link = null; }
      // A process holds one Claude conversation. When the task no longer remembers that conversation (it was handed to
      // another agent and came back), the process is stale: the next turn starts afresh from the shared chat.
      if (link && link.state.claudeSessionId && remembered !== link.state.claudeSessionId && !link.pending) { await link.close({ reason: "conversation no longer remembered" }); link = null; }
      let fresh = false;
      if (!link && !continuation) {
        const hosted = mcpConfig?.(workspace, run, owner);
        const mcpServers = hosted ? { jolo: hosted.server } : {};
        const instructions = (scratchDir) => [inlineBrowserInstructions({ available: Boolean(hosted?.hasBrowser), hosted: true }), standaloneChatInstructions(storage, session), scratchInstructions(scratchDir)].filter(Boolean).join('\n\n');
        try {
          link = registry.open({
            sessionId: session.id, workspaceId: workspace.id, agentId: manifest.id, identity, cwd: workspace.path,
            prepare: (scratchDir) => ({
              argv: claudeArgv(binary, [...extraArgs, '--append-system-prompt', instructions(scratchDir), ...(Object.keys(mcpServers).length ? ['--mcp-config', JSON.stringify({ mcpServers })] : [])], remembered),
              env: hostedEnvironment(supervisor, { TMPDIR: scratchDir, TMP: scratchDir, TEMP: scratchDir }),
            }),
            onClosed: () => { revoke(owner); storage.expireRunGrants(owner); }, // what was allowed for its background work ends with it
          });
        } catch (error) {
          revoke(owner);
          return { outcome: "failed", failure: `could not start ${manifest.displayName}: ${error?.message ?? error}` };
        }
        fresh = true;
      }
      const turn = createHostedTurn({ ctx, storage, permissions, manifest, session, workspace, scratch: link ? () => link.scratchDir : null });
      if (!link || (continuation && !link.pending)) {
        // A continuation with nothing left to continue: the process has gone, or another run took its turn.
        turn.finish({ usage: { inputTokens: 0, outputTokens: 0, attempts: 1, iterations: 0, contextUsed: null, contextWindow: null } });
        return { outcome: "completed", carried: false };
      }
      // A slash command is Claude's own — /compact, a built-in, a plugin's, a skill, one the user defined — and it works
      // only as the whole message, so it goes to Claude alone, without the handoff that would otherwise surround it.
      const command = continuation ? null : slashCommand(run);
      // A resumed continuation is asked to carry on with what others said meanwhile, as any message of its own is.
      const contentPromise = continuation ? Promise.resolve(null) : (command ? Promise.resolve(command.text) : handoffPrompt({ storage, run: resumeNote ? { ...run, prompt: resumeNote } : run, session, resumed: Boolean(recall(session, manifest).claudeSessionId), ...handoffParties({ catalog, session, manifest, storage, run, model: catalog.config(manifest, runChoice(ctx.run)).model }), summarize: createSummarizer({ providerFactory, settings, log, sessionId: session.id, runId: run.id }) }))
        .then(prompt => {
          const images = readImages(storage, run);
          return images.length ? [...claudeImageContent(images), { type: 'text', text: prompt }] : prompt;
        });
      contentPromise.catch(() => {});

      const state = {
        blocks: new Map(), // stream block index -> { kind, messageId }
        subagents: new Map(), // subagent call id -> { model, last, steps, bytes, capped }
        usage: { inputTokens: 0, outputTokens: 0, attempts: 1, iterations: 0, contextUsed: null, contextWindow: null },
        result: null, failure: null,
        lastCall: null, // the main thread's latest model call, which is how full the window is now
        sawContent: false, // whether this turn has produced anything a result could be the end of
        // The message this run wrote, and whether the binary has taken it up yet: the turn's init lists it, the echo repeats
        // it, and a result names the message it answers. A result before that ends a turn the process began by itself,
        // which this run shows first; a continuation has no message of its own.
        ownMessage: continuation ? null : randomUUID(),
        mine: continuation,
        // A continuation for a background subagent's question alone ends once the question is answered, unless the
        // main thread starts a turn of its own meanwhile.
        questionOnly: continuation && link.pendingQuestionOnly,
        mainTurn: false,
        answeredQuestion: false,
        emptyTimer: null,
        emptyPending: null,
        compacting: false,
        replaying: false, // between a compaction boundary and the next model output: the binary is replaying history
        ownAnswered: false, // a result naming this run's own message has arrived
        streaming: false, // the main thread's model is producing a response now
        replayed: false, // the message being handled is one the process sent before this run took the turn
      };
      let handle = null;
      const finishBlock = (block, status) => { if (block?.messageId) ctx.finishMessage(block.messageId, status); };
      const record = (message) => {
        state.result = message;
        const usage = message.usage ?? {};
        const window = message.modelUsage?.[link.state.model]?.contextWindow;
        state.usage = {
          inputTokens: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0), outputTokens: usage.output_tokens ?? 0, attempts: 1, iterations: message.num_turns ?? 0,
          // Only a run that called the model measured how full the window is; one that did not leaves the last reading.
          contextUsed: contextOf(state.lastCall), contextWindow: state.lastCall && Number.isInteger(window) && window > 0 ? window : null,
        };
      };

      /** Jolo's answer to "may I use this tool?", in the two forms the binary accepts. */
      /** `scope`: what "allow for this run" covers for background work, the work that asked (see the question's case). */
      const decide = async (request, withdrawn, background, scope = "idle") => {
        const toolName = String(request.tool_name ?? "");
        const input = request.input ?? {};
        // The jolo server is Jolo's own scoped bridge: it validates, authorizes, and records
        // the operation in the engine, so its tools — schedules, search, browser — never prompt.
        if (mcpConfig && toolName.startsWith('mcp__jolo__')) return { behavior: 'allow', updatedInput: input };
        const target = input.file_path ?? input.path ?? request.blocked_path;
        const { summary, script } = describeTool(toolName, input);
        const toolClass = classify(toolName);
        const decision = await turn.decide({ toolClass, toolName, targets: typeof target === "string" && target ? [target] : [], summary, script, cwd: ".", argumentDigest: digestOf({ tool: toolName, input }), signal: withdrawn, holding: () => deciding.size > 1, ...(background ? { grantRun: `${owner}:${scope}` } : {}) });
        if (decision === null) return null;
        return decision === "allow" ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: decision.deny };
      };

      // Questions being decided, by request id. A decision is made beside the stream, never in its way: while the user
      // thinks, the process keeps talking (background work, a turn of its own) and its exit must still be noticed.
      const deciding = new Map();
      /** Jolo tool calls this run allowed that have not reported back, by tool use id, each with its time limit. */
      const joloCalls = new Map();
      const holdForJolo = (id) => {
        const timer = setTimeout(() => { joloCalls.delete(id); settleEnd(); }, JOLO_CALL_HOLD_MS);
        timer.unref?.();
        joloCalls.set(id, timer);
      };
      /** Messages that report a tool's result, the main thread's or a subagent's: the Jolo calls among them are done. */
      const joloReported = (message) => {
        if (message.type !== "user" || !joloCalls.size) return;
        for (const block of Array.isArray(message.message?.content) ? message.message.content : []) {
          if (block?.type !== "tool_result" || !joloCalls.has(block.tool_use_id)) continue;
          clearTimeout(joloCalls.get(block.tool_use_id));
          joloCalls.delete(block.tool_use_id);
        }
        settleEnd();
      };
      /** The run is over once the main thread's turn is, no question is open, and no Jolo call it allowed still runs. */
      const settleEnd = () => { if (!deciding.size && !joloCalls.size && !state.mainTurn && (state.answeredQuestion || endOnceDecided)) handle?.end(); };
      const holding = () => deciding.size > 0 || joloCalls.size > 0;
      /** The main thread's tool calls of this step that have not reported back yet. */
      const mainTools = new Set();
      let endOnceDecided = false;
      // Whether the run only waits on the user now, which is when its budgets stop counting: a question is open and the
      // main thread is idle, or every tool it is running waits on a question of its own. Background work goes on either
      // way, and a main thread at work beside a background question is work.
      // The main thread waits on the user when a question is its own, including one from a subagent it runs in the
      // foreground. Tools queued behind an asking one wait as well; a model still streaming, or another foreground
      // subagent with no question of its own, is still working.
      const settleWaiting = () => {
        const open = [...deciding.values()];
        const asking = new Set(open.map((entry) => entry.call).filter(Boolean));
        const mainAsking = open.some((entry) => !entry.background);
        const subagentWorking = [...mainTools].some((id) => subagentCalls.has(id) && !asking.has(id));
        const blocked = !state.mainTurn || (mainAsking && !state.streaming && !subagentWorking);
        ctx.waitingOnUser?.(open.length > 0 && blocked);
        // With nobody to ask, a question while the main thread is idle waits for a window, as its asker does.
        ctx.keepWaitingForPermission?.(!state.mainTurn);
      };
      /** The main thread's subagent calls (Agent/Task) among its tools. */
      const subagentCalls = new Set();
      const deny = (requestId) => link.write({ type: "control_response", response: { request_id: requestId, subtype: "success", response: { behavior: "deny", message: "The run was stopped in Jolo." } } });
      const onControlRequest = async (message, background, call = null, scope = "idle") => {
        const request = message.request ?? {};
        if (request.subtype !== "can_use_tool") { link.write({ type: "control_response", response: { request_id: message.request_id, subtype: "error", error: `Jolo does not handle ${request.subtype ?? "this request"}` } }); return; }
        if (signal.aborted) { deny(message.request_id); return; } // asked after Stop: nobody will be asked now
        const withdrawn = new AbortController();
        const stop = () => withdrawn.abort();
        signal.addEventListener("abort", stop, { once: true });
        deciding.set(message.request_id, { withdrawn, background, call: call && mainTools.has(call) ? call : null, toolUseId: request.tool_use_id ?? null });
        settleWaiting();
        try {
          const decision = await decide(request, withdrawn.signal, background, scope);
          if (withdrawn.signal.aborted && !signal.aborted) return; // the process took the question back: nothing to answer
          // Cancelled while waiting (Stop, or no window left to ask in): the asker must not wait forever, least of all a
          // subagent working in the background after this run is gone.
          if (!decision) { if (signal.aborted) deny(message.request_id); return; }
          link.write({ type: "control_response", response: { request_id: message.request_id, subtype: "success", response: decision } });
          // A Jolo tool reaches the engine on the conversation's credential only while a run of it is live: hold this one.
          if (decision.behavior === "allow" && String(request.tool_name ?? "").startsWith("mcp__jolo__") && request.tool_use_id) holdForJolo(request.tool_use_id);
        } finally {
          signal.removeEventListener("abort", stop);
          deciding.delete(message.request_id);
          settleWaiting();
          if (withdrawn.signal.aborted && !signal.aborted && !deciding.size) ctx.transition("tools"); // nobody is waited on now
        }
      };
      // The main thread's turn is over but a question is still open: the run is only waiting on the user now. Its budgets
      // stop counting, and with nobody to ask it waits for a window, as the asker does, rather than pausing.
      const onlyWaiting = () => {
        endOnceDecided = true;
        state.mainTurn = false;
        mainTools.clear();
        settleWaiting();
      };
      /** The run's phase, except that while a question waits on the user the run shows it waiting on the user. */
      const phase = (name, { shown = false } = {}) => {
        // Work the process already did by itself, or a call already counted at its start, is shown but not counted again.
        const options = state.replayed || shown ? { counted: false } : undefined;
        if (!deciding.size) ctx.transition(name, options); else ctx.countPhase?.(name, options); // model calls still count
      };
      // An empty result before any answer: if nothing of the turn follows within the grace, it was the whole turn.
      // Compaction or a retry holds the grace open, as the answer comes after it. A background question still open
      // keeps the run, as a result would: it ends once that is settled.
      const awaitAnswer = (empty, extraMs = 0) => {
        clearTimeout(state.emptyTimer);
        state.emptyTimer = setTimeout(() => {
          state.emptyTimer = null;
          if (state.compacting) { awaitAnswer(empty); return; }
          if (state.result) return;
          record(empty);
          if (holding()) onlyWaiting(); else handle?.end();
        }, emptyResultGraceMs + extraMs);
        state.emptyPending = empty;
      };
      /** What the main thread says in a turn, as opposed to notices about the session (rate limits, keep-alives, hooks). */
      // A question is the main thread's only inside a turn it opened: one asked while it is idle is background work's.
      const mainOutput = (message) => ["assistant", "stream_event"].includes(message.type) || (message.type === "user" && !message.isReplay) || (message.type === "control_request" && !isSubagentRequest(message) && state.mainTurn);

      const onToolResult = (block) => {
        const text = typeof block.content === "string" ? block.content : Array.isArray(block.content) ? block.content.map((part) => part?.text ?? "").join("\n") : JSON.stringify(block.content ?? "");
        // A subagent's report starts after a blank line, so none of its lines can be read as progress.
        const shown = browserPreview(text);
        turn.toolFinished(block.tool_use_id, { text: state.subagents.has(block.tool_use_id) ? `\n${shown}` : shown, isError: Boolean(block.is_error) });
        if (mainTools.delete(block.tool_use_id)) settleWaiting();
      };

      /** A subagent's own message: only its model and the tools it uses become progress lines on the parent call. */
      const onSubagent = (message) => {
        const parentId = message.parent_tool_use_id;
        const progress = state.subagents.get(parentId);
        if (message.type !== "assistant" || !progress || progress.capped || !turn.hasTool(parentId)) return;
        const out = [];
        const write = (line) => {
          const chunk = `${SUBAGENT_LINE}${line}\n`;
          const size = Buffer.byteLength(chunk);
          if (progress.steps >= SUBAGENT_STEPS_MAX || progress.bytes + size > SUBAGENT_PROGRESS_MAX) { progress.capped = true; out.push(SUBAGENT_MORE); return false; }
          progress.bytes += size;
          out.push(chunk);
          return true;
        };
        const model = message.message?.model;
        let room = true;
        if (typeof model === "string" && model && model !== progress.model) { progress.model = model; room = write(`model: ${model}`); }
        for (const block of room ? message.message?.content ?? [] : []) {
          if (block?.type !== "tool_use") continue;
          const step = describeTool(String(block.name ?? "tool"), block.input).summary.split("\n", 1)[0].trim().slice(0, 160);
          if (!step || step === progress.last) continue;
          if (!write(step)) break;
          progress.last = step;
          progress.steps += 1;
        }
        if (out.length) turn.toolOutput(parentId, out.join(""));
      };

      /** One message of the turn; answers true when the turn is over. */
      const onMessage = async (message, { replayed = false } = {}) => {
        state.replayed = replayed;
        // Claude multiplexes subagent transcripts onto this stream. Their block indexes are local
        // to the child, and their reports belong to the parent's Agent/Task tool result, not the
        // conversation; only their progress is kept, on the parent call. Permission requests from
        // any agent must still reach Jolo's policy.
        if (message.parent_tool_use_id != null && message.type !== 'control_request') { joloReported(message); onSubagent(message); return false; }
        // After compacting, the binary replays what it kept (a summary, recent messages) before it streams again: that is
        // history, already shown, not this turn's answer.
        if (message.type === "system" && message.subtype === "compact_boundary") state.replaying = true;
        else if (message.type === "stream_event") state.replaying = false;
        else if (state.replaying && (message.type === "assistant" || (message.type === "user" && !message.isReplay))) return false;
        if (mainOutput(message)) {
          state.sawContent = true;
          state.mainTurn = true;
          // The answer is arriving after all: an empty result ahead of it must not end the turn partway.
          if (state.emptyTimer) { clearTimeout(state.emptyTimer); state.emptyTimer = null; }
        } else if (state.emptyTimer && turnNotice(message)) { // compacting or retrying first: the grace starts over
          state.compacting = compactingAfter(message, state.compacting);
          awaitAnswer(state.emptyPending, retryDelay(message));
        }
        switch (message.type) {
          case "control_response":
            if (message.response?.request_id === "jolo-init") {
              const content = await contentPromise;
              if (!signal.aborted) link.write({ type: "user", uuid: state.ownMessage, message: { role: "user", content } }); // stopped meanwhile: never asked
            }
            return false;
          case "control_request": {
            // A subagent's question belongs to the main thread while the subagent call it runs under is the main thread's
            // and still running (a foreground subagent); otherwise, and for any question while it is idle, to background work.
            // The process traces every subagent to the main-thread call it runs under, whichever run saw it start; one it
            // cannot trace did not start in this turn. Background work's "allow for this run" covers the work that asked:
            // everything under the same main-thread call, or the asking agent when that is not known.
            const asker = isSubagentRequest(message) ? message.request.agent_id : null;
            const traced = asker === null ? undefined : link.callOf(asker);
            const call = traced ?? null;
            const background = !state.mainTurn || (asker !== null && !(call && mainTools.has(call)));
            void onControlRequest(message, background, call, String(traced ?? asker ?? "idle")).catch((error) => log.warn("could not answer a permission request", { runId: run.id, error: String(error?.message ?? error) })).finally(() => {
              if (state.questionOnly && background && !state.mainTurn) state.answeredQuestion = true;
              // The turn is over once its questions are settled: a background question alone, or a result that waited on
              // one. A turn the process began meanwhile is not cut off: its own result ends the run.
              settleEnd();
            });
            return false;
          }
          case "control_cancel_request":
            deciding.get(message.request_id)?.withdrawn.abort();
            return false;
          case "system":
            if (message.subtype === "init") {
              // This run's own turn was only an empty result: a turn beginning now is the process's own (background work
              // reporting back), and goes to a run of its own unless a question still open keeps this one.
              if (state.mine && state.emptyTimer && !(state.ownMessage && message.user_message_uuids?.includes(state.ownMessage))) {
                clearTimeout(state.emptyTimer); state.emptyTimer = null;
                record(state.emptyPending);
                if (!deciding.size) return HAND_BACK;
                onlyWaiting();
              }
              state.mainTurn = true;
              mainTools.clear();
              state.streaming = false;
              ctx.countPhase?.("turn"); // a new turn: its first model call is counted
              settleWaiting(); // a turn begins beside an open question: that is work
              if (state.ownMessage && message.user_message_uuids?.includes(state.ownMessage)) {
                state.mine = true; state.sawContent = false;
                clearTimeout(state.emptyTimer); state.emptyTimer = null; // this run's own turn begins and will end with its result
              }
            }
            if (message.subtype === "init" && message.model) link.state.model = message.model;
            if (message.subtype === "compact_boundary" && compactRequested(run)) { const messageId = ctx.startMessage("assistant", "text"); turn.appendBounded(messageId, "Context compacted."); ctx.finishMessage(messageId, "complete"); }
            if (message.subtype === "init" && message.session_id) {
              link.state.claudeSessionId = message.session_id;
              if (recall(session, manifest).claudeSessionId !== message.session_id) turn.remember({ claudeSessionId: message.session_id });
            }
            return false;
          case "stream_event": {
            const event = message.event ?? {};
            if (event.type === "content_block_start") {
              const kind = event.content_block?.type;
              if (kind === "text") { phase("model", { shown: state.streaming }); state.blocks.set(event.index, { kind, messageId: ctx.startMessage("assistant", "text") }); }
              else if (kind === "thinking") state.blocks.set(event.index, { kind, messageId: ctx.startMessage("assistant", "reasoning") });
              else state.blocks.set(event.index, { kind, messageId: null });
            } else if (event.type === "content_block_delta") {
              const block = state.blocks.get(event.index);
              const delta = event.delta ?? {};
              if (block?.messageId && delta.type === "text_delta" && delta.text) turn.appendBounded(block.messageId, delta.text);
              if (block?.messageId && delta.type === "thinking_delta" && delta.thinking) turn.appendBounded(block.messageId, delta.thinking);
            } else if (event.type === "content_block_stop") {
              const block = state.blocks.get(event.index);
              finishBlock(block, "complete");
              if (block) state.blocks.set(event.index, { ...block, messageId: null, done: true });
            } else if (event.type === "message_start") {
              if (event.message?.usage) state.lastCall = event.message.usage;
              // A new model call, counted as one however it answers (text, thinking or tools). The last step's tools have
              // all reported by now; one that never did was dropped by the binary and no longer runs.
              for (const id of mainTools) ctx.toolBackgrounded?.(id);
              mainTools.clear();
              state.streaming = true;
              phase("model");
              settleWaiting();
            } else if (event.type === "message_delta" && event.usage) {
              state.lastCall = mergedUsage(state.lastCall, event.usage);
            } else if (event.type === "message_stop") {
              state.blocks.clear();
              state.streaming = false;
              settleWaiting();
            }
            return false;
          }
          case "assistant": {
            for (const block of message.message?.content ?? []) {
              if (block.type === "tool_use" && SUBAGENT_TOOLS.has(block.name)) { phase("tools"); mainTools.add(block.id); subagentCalls.add(block.id); settleWaiting(); state.subagents.set(block.id, { model: null, last: null, steps: 0, bytes: 0, capped: false }); turn.toolStarted({ callId: block.id, name: block.name, input: block.input, display: subagentDisplay(block.name, block.input), outputMax: SUBAGENT_DISPLAY_MAX, resultMax: SUBAGENT_DISPLAY_MAX }); }
              else if (block.type === "tool_use") { phase("tools"); mainTools.add(block.id); settleWaiting(); turn.toolStarted({ callId: block.id, name: block.name, input: block.input, display: `${block.name} ${JSON.stringify(block.input ?? {})}` }); }
              else if (block.type === "text" && block.text && ![...state.blocks.values()].some((entry) => entry.kind === "text")) {
                const messageId = ctx.startMessage("assistant", "text"); turn.appendBounded(messageId, block.text); ctx.finishMessage(messageId, "complete"); // no partial stream arrived for this block
              }
            }
            return false;
          }
          case "user":
            if (message.isReplay) {
              if (message.uuid === state.ownMessage) { state.mine = true; state.sawContent = false; }
              return false;
            }
            for (const block of message.message?.content ?? []) if (block?.type === "tool_result") onToolResult(block);
            joloReported(message);
            return false;
          case "result": {
            // Stopping: whichever turn the interrupt ended, the run is over; an empty result ahead of that turn's own is not it.
            if (message.user_message_uuid && message.user_message_uuid === state.ownMessage) state.ownAnswered = true;
            if (signal.aborted) {
              if (emptyResult(message)) return false;
              // This run's own message may still run: taken up after the turn now ending, or not yet withdrawn. Its own
              // result, or the withdrawal, ends the run; ending now would leave that turn to nobody.
              if (state.ownMessage && !state.ownAnswered && (state.mine || link.queues(state.ownMessage))) return false;
              clearTimeout(state.emptyTimer); state.emptyTimer = null; record(message); return true;
            }
            // This run's turn ended while a question was open and the process began another turn meanwhile; that has ended.
            if (endOnceDecided) {
              if (emptyResult(state.result) && !emptyResult(message)) record(message); // the answer after all
              if (!holding()) return true;
              onlyWaiting();
              return false;
            }
            if (message.user_message_uuid && state.ownMessage) state.mine = message.user_message_uuid === state.ownMessage;
            if (!state.mine) return false; // a turn the process began by itself is over; this run's own is still to come
            // Answered without the model, with a reason (a hook that blocked the message): that is the whole answer.
            if (emptyResult(message) && !state.sawContent && typeof message.result === "string" && message.result.trim()) {
              const messageId = ctx.startMessage("assistant", "text"); turn.appendBounded(messageId, message.result.trim()); ctx.finishMessage(messageId, "complete");
              clearTimeout(state.emptyTimer); state.emptyTimer = null;
              record(message);
              if (holding()) { onlyWaiting(); return false; }
              return true;
            }
            if (emptyResult(message) && !state.sawContent && !command) {
              // Nothing was answered yet, so this is not the end of the answer: a resumed binary sends one of these
              // for a task left from an earlier process. If nothing follows, it was the whole turn after all.
              log.info("empty result ahead of the answer; waiting for the answer", { runId: run.id, agentId: manifest.id });
              awaitAnswer(message);
              return false;
            }
            clearTimeout(state.emptyTimer); state.emptyTimer = null;
            record(message);
            if (holding()) { onlyWaiting(); return false; } // a question, or a Jolo call, is still open
            return true;
          }
          default: return false; // rate_limit_event, keep_alive, hooks: nothing Jolo needs
        }
      };

      ctx.transition("model", { counted: false }); // shown at once; the turn's model calls are counted as they start
      // Only a background subagent's question is open: with nobody to ask, it waits for a window, as the subagent does.
      if (state.questionOnly) ctx.keepWaitingForPermission?.();
      try {
        handle = link.beginTurn({ signal, handle: onMessage });
      } catch (error) {
        turn.finish({ usage: state.usage });
        return { outcome: "failed", failure: `could not start a turn with ${manifest.displayName}: ${error?.message ?? error}` };
      }
      if (!continuation) {
        // Stop ends the turn and what waits behind it. Background agents and workflows go on, listed: Jolo stops them on
        // their own (the link's stopBackground and stopTask), which perTaskStopAffordance tells Claude, so its interrupt spares them.
        if (fresh) link.write({ type: "control_request", request_id: "jolo-init", request: { subtype: "initialize", forwardNestedSubagentToolCalls: true, perTaskStopAffordance: true } });
        else {
          const content = await contentPromise;
          if (!signal.aborted) link.write({ type: "user", uuid: state.ownMessage, message: { role: "user", content } }); // stopped meanwhile: never asked
        }
      }
      const ended = await handle.done;
      for (const timer of joloCalls.values()) clearTimeout(timer);
      clearTimeout(state.emptyTimer);
      if (ended.failure) state.failure = String(ended.failure?.message ?? ended.failure);
      for (const block of state.blocks.values()) finishBlock(block, "interrupted");
      turn.finish({ usage: state.usage });
      // Whatever this run showed is in Claude's own thread when the run was Claude's own turn or its message was taken
      // up, completed or not: a later turn must not be handed it as news.
      const reached = continuation || state.mine;
      if (signal.aborted) return { outcome: "cancelled", reached };
      if (state.failure) return { outcome: "failed", failure: state.failure.slice(0, 500), reached };
      // A continuation carried nothing of the conversation to Claude: what others said meanwhile is still to be delivered.
      if (continuation && !state.failure && (state.result ? !state.result.is_error : state.answeredQuestion)) return { outcome: "completed", carried: false, reached };
      if (state.answeredQuestion && !state.result) return { outcome: "completed", reached };
      // A slash command went to Claude alone, without what others said: it delivered none of it.
      if (command && !state.failure && state.result && !state.result.is_error) return { outcome: "completed", carried: false, reached };
      if (!state.result) return { outcome: "failed", failure: `${manifest.displayName} exited ${ended.exitCode ?? "?"} without a result${ended.stderr ? `: ${ended.stderr.slice(0, 300)}` : ""}`, reached };
      if (state.result.is_error) return { outcome: "failed", failure: String(state.result.result ?? state.result.subtype ?? "error").slice(0, 500), reached };
      return { outcome: "completed", reached };
    },
  };
}

/** What the process is told about its scratch directory, which lives as long as the process does. */
const scratchInstructions = (scratchDir) => `Temporary files: use ${JSON.stringify(scratchDir)} (also TMPDIR, TMP and TEMP), not a hard-coded /tmp path. Jolo permits reads and writes in this private directory for this conversation and removes it when the conversation's agent process ends. Save final mockups, visualizations, and other deliverables inside the workspace before linking them in your reply; only workspace files can be previewed in chat.`;
