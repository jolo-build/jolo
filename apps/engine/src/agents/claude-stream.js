// Claude Code as a hosted agent, driven through its structured stream.
//
// One Jolo run is one Claude turn. The child speaks NDJSON on stdout, is fed NDJSON on stdin, and asks the
// host for permission over a control channel. That channel is the point: Claude's own approval prompts land
// in Jolo's permission records, so the dialog, the board and notifications work exactly as for Jolo's tools,
// and Jolo's grants decide. What Claude allows on its own (its rules and hooks) never reaches us, and what it
// asks about is answered here by policy or by the user. Jolo never answers on the user's behalf.
//
// Every shape below was read from the installed binary and confirmed against a live session; see the
// initialize/can_use_tool/control_response forms in the engine's agents README.
import { createHostedTurn, digestOf, handoffParties, hostedEnvironment, insideWorkspace, recall, runChoice, spawnLineChild } from "./hosted.js";
import { createSummarizer, handoffPrompt } from "./handoff.js";
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

/** The stream-json host mode, as the binary spells it. Exported so model discovery can open the same channel. */
export const claudeArgv = (binary, extraArgs, claudeSessionId = null) => [
  binary, ...extraArgs, "--print", "--verbose",
  "--output-format", "stream-json", "--input-format", "stream-json", "--include-partial-messages",
  "--permission-prompts", "host", "--permission-prompt-tool", "stdio",
  ...(claudeSessionId ? ["--resume", claudeSessionId] : []),
];

/**
 * The MCP configurators are absent when the engine hosts neither search nor a browser, and the
 * provider factory and settings only matter to a handoff that summarizes with a model.
 * @param {{ storage: any, catalog: any, permissions: any, supervisor: any, log: any,
 *   mcpConfig?: (workspace: any, run: any) => { server: any, hasBrowser: boolean, hasSearch: boolean } | null,
 *   providerFactory?: any, settings?: any }} deps
 */
export function createClaudeStreamExecutor({ storage, catalog, permissions, supervisor, log, mcpConfig, providerFactory = null, settings = null }) {
  return {
    name: "claude-stream",
    /** @param {any} ctx @param {any} [answerer] the agent answering this run, when a message called one in (§4.3) */
    async execute(ctx, answerer = null) {
      const { run, signal } = ctx;
      const session = storage.getSession(run.sessionId);
      const workspace = storage.getWorkspace(session.workspaceId);
      const manifest = answerer ?? catalog.get(session.agentId);
      const [binary, ...extraArgs] = catalog.command(manifest, runChoice(ctx.run)); // the --model/--effort in force, plus any the manifest adds
      const turn = createHostedTurn({ ctx, storage, permissions, manifest, session, workspace });
      const remembered = recall(session, manifest).claudeSessionId ?? null;
      const hosted = mcpConfig?.(workspace, run);
      const mcpServers = hosted ? { jolo: hosted.server } : {};
      const argv = claudeArgv(binary, [...extraArgs, '--append-system-prompt', [inlineBrowserInstructions({ available: Boolean(hosted?.hasBrowser), hosted: true }), standaloneChatInstructions(storage, session), turn.fileInstructions].filter(Boolean).join('\n\n'), ...(Object.keys(mcpServers).length ? ['--mcp-config', JSON.stringify({ mcpServers })] : [])], remembered);
      const contentPromise = handoffPrompt({ storage, run, session, resumed: Boolean(remembered), ...handoffParties({ catalog, session, manifest, storage, run, model: catalog.config(manifest, runChoice(ctx.run)).model }), summarize: createSummarizer({ providerFactory, settings, log, sessionId: session.id, runId: run.id }) })
        .then(prompt => {
          const images = readImages(storage, run);
          return images.length ? [...claudeImageContent(images), { type: 'text', text: prompt }] : prompt;
        });
      const env = hostedEnvironment(supervisor, turn.environment);

      const state = {
        blocks: new Map(), // stream block index -> { kind, messageId }
        subagents: new Map(), // subagent call id -> { model, last, steps, bytes, capped }
        usage: { inputTokens: 0, outputTokens: 0, attempts: 1, iterations: 0, contextUsed: null, contextWindow: null },
        result: null, failure: null,
        model: null, // the main model as Claude names it in its usage report
        lastCall: null, // the main thread's latest model call, which is how full the window is now
      };
      let link;
      try {
        link = spawnLineChild({ argv, cwd: workspace.path, env, signal, log, agentId: manifest.id });
      } catch (error) {
        contentPromise.catch(() => {});
        turn.finish({ usage: state.usage });
        return { outcome: "failed", failure: `could not start ${manifest.displayName}: ${error?.message ?? error}` };
      }
      const finishBlock = (block, status) => { if (block?.messageId) ctx.finishMessage(block.messageId, status); };

      /** Jolo's answer to "may I use this tool?", in the two forms the binary accepts. */
      const decide = async (request) => {
        const toolName = String(request.tool_name ?? "");
        const input = request.input ?? {};
        // The jolo server is Jolo's own scoped bridge: it validates, authorizes, and records
        // the operation in the engine, so its tools — schedules, search, browser — never prompt.
        if (hosted && toolName.startsWith('mcp__jolo__')) return { behavior: 'allow', updatedInput: input };
        const target = input.file_path ?? input.path ?? request.blocked_path;
        const { summary, script } = describeTool(toolName, input);
        const toolClass = classify(toolName);
        const decision = await turn.decide({ toolClass, toolName, targets: typeof target === "string" && target ? [target] : [], summary, script, cwd: ".", argumentDigest: digestOf({ tool: toolName, input }) });
        if (decision === null) return null;
        return decision === "allow" ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: decision.deny };
      };

      const onControlRequest = async (message) => {
        const request = message.request ?? {};
        if (request.subtype !== "can_use_tool") { link.write({ type: "control_response", response: { request_id: message.request_id, subtype: "error", error: `Jolo does not handle ${request.subtype ?? "this request"}` } }); return; }
        const decision = await decide(request);
        if (!decision) return;
        link.write({ type: "control_response", response: { request_id: message.request_id, subtype: "success", response: decision } });
      };

      const onToolResult = (block) => {
        const text = typeof block.content === "string" ? block.content : Array.isArray(block.content) ? block.content.map((part) => part?.text ?? "").join("\n") : JSON.stringify(block.content ?? "");
        // A subagent's report starts after a blank line, so none of its lines can be read as progress.
        const shown = browserPreview(text);
        turn.toolFinished(block.tool_use_id, { text: state.subagents.has(block.tool_use_id) ? `\n${shown}` : shown, isError: Boolean(block.is_error) });
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

      const onMessage = async (message) => {
        // Claude multiplexes subagent transcripts onto this stream. Their block indexes are local
        // to the child, and their reports belong to the parent's Agent/Task tool result, not the
        // conversation; only their progress is kept, on the parent call. Permission requests from
        // any agent must still reach Jolo's policy.
        if (message.parent_tool_use_id != null && message.type !== 'control_request') return onSubagent(message);
        switch (message.type) {
          case "control_response":
            if (message.response?.request_id === "jolo-init") link.write({ type: "user", message: { role: "user", content: await contentPromise } });
            return;
          case "control_request": return onControlRequest(message);
          case "system":
            if (message.subtype === "init" && message.model) state.model = message.model;
            if (message.subtype === "init" && message.session_id && session.agentState?.claudeSessionId !== message.session_id) turn.remember({ claudeSessionId: message.session_id });
            return;
          case "stream_event": {
            const event = message.event ?? {};
            if (event.type === "content_block_start") {
              const kind = event.content_block?.type;
              if (kind === "text") { ctx.transition("model"); state.blocks.set(event.index, { kind, messageId: ctx.startMessage("assistant", "text") }); }
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
            } else if (event.type === "message_start" && event.message?.usage) {
              state.lastCall = event.message.usage;
            } else if (event.type === "message_delta" && event.usage) {
              state.lastCall = mergedUsage(state.lastCall, event.usage);
            } else if (event.type === "message_stop") {
              state.blocks.clear();
            }
            return;
          }
          case "assistant": {
            for (const block of message.message?.content ?? []) {
              if (block.type === "tool_use" && SUBAGENT_TOOLS.has(block.name)) { ctx.transition("tools"); state.subagents.set(block.id, { model: null, last: null, steps: 0, bytes: 0, capped: false }); turn.toolStarted({ callId: block.id, name: block.name, input: block.input, display: subagentDisplay(block.name, block.input), outputMax: SUBAGENT_DISPLAY_MAX, resultMax: SUBAGENT_DISPLAY_MAX }); }
              else if (block.type === "tool_use") { ctx.transition("tools"); turn.toolStarted({ callId: block.id, name: block.name, input: block.input, display: `${block.name} ${JSON.stringify(block.input ?? {})}` }); }
              else if (block.type === "text" && block.text && ![...state.blocks.values()].some((entry) => entry.kind === "text")) {
                const messageId = ctx.startMessage("assistant", "text"); turn.appendBounded(messageId, block.text); ctx.finishMessage(messageId, "complete"); // no partial stream arrived for this block
              }
            }
            return;
          }
          case "user":
            for (const block of message.message?.content ?? []) if (block?.type === "tool_result") onToolResult(block);
            return;
          case "result": {
            state.result = message;
            const usage = message.usage ?? {};
            const window = message.modelUsage?.[state.model]?.contextWindow;
            state.usage = {
              inputTokens: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0), outputTokens: usage.output_tokens ?? 0, attempts: 1, iterations: message.num_turns ?? 0,
              contextUsed: contextOf(state.lastCall), contextWindow: Number.isInteger(window) && window > 0 ? window : null,
            };
            link.end();
            link.terminate();
            return;
          }
          default: return; // rate_limit_event, keep_alive, hooks: nothing Jolo needs
        }
      };

      ctx.transition("model");
      link.write({ type: "control_request", request_id: "jolo-init", request: { subtype: "initialize" } });
      try {
        for await (const message of link.messages()) {
          await onMessage(message);
          if (state.result) break;
        }
      } catch (error) {
        state.failure = String(error?.message ?? error);
      }
      const { exitCode, stderr } = await link.settle();
      for (const block of state.blocks.values()) finishBlock(block, "interrupted");
      turn.finish({ usage: state.usage });
      if (signal.aborted) return { outcome: "cancelled" };
      if (state.failure) return { outcome: "failed", failure: state.failure.slice(0, 500) };
      if (!state.result) return { outcome: "failed", failure: `${manifest.displayName} exited ${exitCode ?? "?"} without a result${stderr ? `: ${stderr.slice(0, 300)}` : ""}` };
      if (state.result.is_error) return { outcome: "failed", failure: String(state.result.result ?? state.result.subtype ?? "error").slice(0, 500) };
      return { outcome: "completed" };
    },
  };
}
