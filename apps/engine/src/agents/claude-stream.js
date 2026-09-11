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
import { browserTools } from '../tools/browser.js';
import { browserPreview } from '../browser/hosted.js';
import { inlineBrowserInstructions } from '../browser/instructions.js';
import { standaloneChatInstructions } from '../agent/instructions.js';
import { readImages, claudeImageContent } from '../attachments.js';

export { insideWorkspace };

const MUTATION_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "TodoWrite", "TodoRead"]);
const PROCESS_TOOLS = new Set(["Bash", "PowerShell"]);

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
 *   searchConfig?: (workspace: any, run: any) => any, browserConfig?: (workspace: any, run: any) => any,
 *   providerFactory?: any, settings?: any }} deps
 */
export function createClaudeStreamExecutor({ storage, catalog, permissions, supervisor, log, searchConfig, browserConfig, providerFactory = null, settings = null }) {
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
      const searchServer = searchConfig?.(workspace, run);
      const browserServer = browserConfig?.(workspace, run);
      const mcpServers = { ...(searchServer ? { jolo_search: searchServer } : {}), ...(browserServer ? { jolo_browser: browserServer } : {}) };
      const argv = claudeArgv(binary, [...extraArgs, '--append-system-prompt', [inlineBrowserInstructions({ available: Boolean(browserServer), hosted: true }), standaloneChatInstructions(storage, session)].filter(Boolean).join('\n\n'), ...(Object.keys(mcpServers).length ? ['--mcp-config', JSON.stringify({ mcpServers })] : [])], remembered);
      const prompt = await handoffPrompt({ storage, run, session, resumed: Boolean(remembered), ...handoffParties({ catalog, session, manifest, storage, run, model: catalog.config(manifest, runChoice(ctx.run)).model }), summarize: createSummarizer({ providerFactory, settings, log, sessionId: session.id, runId: run.id }) });
      const images = readImages(storage, run);
      const content = images.length ? [...claudeImageContent(images), { type: 'text', text: prompt }] : prompt;
      const env = hostedEnvironment(supervisor);

      const state = {
        blocks: new Map(), // stream block index -> { kind, messageId }
        usage: { inputTokens: 0, outputTokens: 0, attempts: 1, iterations: 0 },
        result: null, failure: null,
      };
      let link;
      try {
        link = spawnLineChild({ argv, cwd: workspace.path, env, signal, log, agentId: manifest.id });
      } catch (error) {
        turn.finish({ usage: state.usage });
        return { outcome: "failed", failure: `could not start ${manifest.displayName}: ${error?.message ?? error}` };
      }
      const finishBlock = (block, status) => { if (block?.messageId) ctx.finishMessage(block.messageId, status); };

      /** Jolo's answer to "may I use this tool?", in the two forms the binary accepts. */
      const decide = async (request) => {
        const toolName = String(request.tool_name ?? "");
        const input = request.input ?? {};
        // This server validates, authorizes, and records the operation in the engine.
        if (browserServer && browserTools.some(tool => toolName === `mcp__jolo_browser__${tool.name}`)) return { behavior: 'allow', updatedInput: input };
        const target = input.file_path ?? input.path ?? request.blocked_path;
        const { summary, script } = describeTool(toolName, input);
        const toolClass = searchServer && toolName === 'mcp__jolo_search__search_text' ? 'read' : classify(toolName);
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
        turn.toolFinished(block.tool_use_id, { text: browserPreview(text), isError: Boolean(block.is_error) });
      };

      const onMessage = async (message) => {
        switch (message.type) {
          case "control_response":
            if (message.response?.request_id === "jolo-init") link.write({ type: "user", message: { role: "user", content } });
            return;
          case "control_request": return onControlRequest(message);
          case "system":
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
            } else if (event.type === "message_stop") {
              state.blocks.clear();
            }
            return;
          }
          case "assistant": {
            for (const block of message.message?.content ?? []) {
              if (block.type === "tool_use") { ctx.transition("tools"); turn.toolStarted({ callId: block.id, name: block.name, input: block.input, display: `${block.name} ${JSON.stringify(block.input ?? {})}` }); }
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
            state.usage = { inputTokens: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0), outputTokens: usage.output_tokens ?? 0, attempts: 1, iterations: message.num_turns ?? 0 };
            link.end();
            link.terminate({ graceful: true });
            return;
          }
          default: return; // rate_limit_event, keep_alive, hooks: nothing Jolo needs
        }
      };

      ctx.transition("model");
      link.write({ type: "control_request", request_id: "jolo-init", request: { subtype: "initialize" } });
      try {
        for await (const message of link.messages()) await onMessage(message);
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
