// Antigravity CLI (agy) as a hosted agent, driven through its print-mode stream.
//
// One Jolo run is one agy turn. The child reads one `{"event":"user"}` line on stdin and writes NDJSON on stdout:
// `init`, then `step_update` events (the reply arrives as `text_delta`s on agent_response steps, and each tool call
// is a tool step that goes ACTIVE, then DONE or ERROR), then one `result` with the turn's status and usage. Every
// step names the conversation, and `--conversation` continues it next turn.
//
// Print mode has no channel for permission questions, so agy's own checks are turned off and Jolo's gate decides
// every tool call instead (see antigravity-gate.js): agy's PreToolUse hook hands each call to Jolo, which decides it
// as it does for the other agents, by policy or by asking the user. Reads and edits pass inside the workspace and
// the turn's scratch directory and are refused outside them, .git included; commands and other tools need a grant
// or the user. A refused call reaches agy as the hook's reason, and agy carries on with its turn.
//
// Every shape below was read from agy 1.3.5 in live print-mode sessions.
import { createHostedTurn, digestOf, handoffParties, hostedEnvironment, recall, runChoice, spawnLineChild } from "./hosted.js";
import { createSummarizer, handoffPrompt } from "./handoff.js";
import { gateRequest, openGate } from "./antigravity-gate.js";
import { inlineBrowserInstructions } from '../browser/instructions.js';
import { standaloneChatInstructions } from '../agent/instructions.js';

/**
 * The print-mode stream, as the binary spells it. agy's own permission checks give way to the gate's hook, which
 * loads from the gate's directory; the turn's scratch directory joins the workspace, and `--print=` names an empty
 * prompt, so the turn is read from stdin.
 */
export const antigravityArgv = (binary, extraArgs, scratchDir, gateDir, conversationId) => [
  binary, ...extraArgs, "--input-format", "stream-json", "--output-format", "stream-json",
  "--dangerously-skip-permissions", "--add-dir", gateDir, "--add-dir", scratchDir,
  ...(conversationId ? ["--conversation", conversationId] : []),
  "--print=",
];

/**
 * @param {{ storage: any, catalog: any, permissions: any, supervisor: any, log: any, providerFactory?: any, settings?: any }} deps
 */
export function createAntigravityExecutor({ storage, catalog, permissions, supervisor, log, providerFactory = null, settings = null }) {
  return {
    name: "antigravity-stream",
    /** @param {any} ctx @param {any} [answerer] the agent answering this run, when a message called one in (§4.3) */
    async execute(ctx, answerer = null) {
      const { run, signal } = ctx;
      const session = storage.getSession(run.sessionId);
      const workspace = storage.getWorkspace(session.workspaceId);
      const manifest = answerer ?? catalog.get(session.agentId);
      const [binary, ...extraArgs] = catalog.command(manifest, runChoice(ctx.run)); // the --model/--effort in force, plus any the manifest adds
      // Ends when agy has exited, so a decision still waiting on the user settles with the turn instead of after it.
      const ended = new AbortController();
      const turn = createHostedTurn({ ctx: { ...ctx, signal: AbortSignal.any([signal, ended.signal]) }, storage, permissions, manifest, session, workspace });
      const usage = { inputTokens: 0, outputTokens: 0, attempts: 1, iterations: 0 };
      // Print mode takes text content only, so an attached image would be dropped without a word.
      if (run.attachments?.some(item => item.mimeType.startsWith('image/'))) {
        turn.finish({ usage });
        return { outcome: "failed", failure: `${manifest.displayName} does not support image attachments. Choose an agent with image support.` };
      }
      const remembered = recall(session, manifest).conversationId ?? null;
      const environment = turn.environment;
      const prompt = await handoffPrompt({ storage, run, session, resumed: Boolean(remembered), ...handoffParties({ catalog, session, manifest, storage, run, model: catalog.config(manifest, runChoice(ctx.run)).model }), summarize: createSummarizer({ providerFactory, settings, log, sessionId: session.id, runId: run.id }) });
      // Print mode has no system-prompt option, so Jolo's instructions lead the turn, as for ACP agents.
      const instructions = [inlineBrowserInstructions({ available: false, hosted: true }), standaloneChatInstructions(storage, session), turn.fileInstructions].filter(Boolean).join('\n\n');

      /** Jolo's answer to the gate about one tool call: the same decision any other agent's call gets. */
      const decideCall = async ({ toolCall }) => {
        if (ended.signal.aborted) return { decision: "deny", reason: "The turn has ended." };
        const name = String(toolCall?.name ?? "tool");
        const args = toolCall?.args ?? {};
        const decision = await turn.decide({ ...gateRequest(name, args, workspace.path), toolName: name, argumentDigest: digestOf({ tool: name, input: args }) });
        return decision === "allow" ? { decision: "allow" } : { decision: "deny", reason: decision?.deny ?? "The run was cancelled in Jolo." };
      };
      // One decision at a time, as the other agents' calls arrive: a run waiting on the user stays awaiting permission.
      let decided = Promise.resolve();
      const answer = (call) => {
        const next = decided.then(() => decideCall(call));
        decided = next.then(() => {}, () => {});
        return next;
      };
      let gate;
      try {
        gate = await openGate({ answer });
      } catch (error) {
        turn.finish({ usage });
        return { outcome: "failed", failure: `could not open Jolo's permission gate for ${manifest.displayName}: ${error?.message ?? error}` };
      }
      const argv = antigravityArgv(binary, extraArgs, environment.TMPDIR, gate.dir, remembered);

      const state = { replies: new Map(), result: null, failure: null }; // agent_response step index -> message id
      let link;
      try {
        link = spawnLineChild({ argv, cwd: workspace.path, env: hostedEnvironment(supervisor, environment), signal, log, agentId: manifest.id });
      } catch (error) {
        gate.close();
        turn.finish({ usage });
        return { outcome: "failed", failure: `could not start ${manifest.displayName}: ${error?.message ?? error}` };
      }

      const onReply = (step) => {
        // Each finished model step reports its own tokens; the result's usage covers the whole conversation so far.
        if (step.state !== "ACTIVE" && step.usage) {
          usage.inputTokens += (step.usage.input_tokens ?? 0) + (step.usage.cache_read_tokens ?? 0);
          usage.outputTokens += step.usage.output_tokens ?? 0;
          usage.iterations += 1;
        }
        let messageId = state.replies.get(step.step_index);
        if (!messageId && step.text_delta) {
          ctx.transition("model");
          messageId = ctx.startMessage("assistant", "text");
          state.replies.set(step.step_index, messageId);
        }
        if (messageId && step.text_delta) turn.appendBounded(messageId, step.text_delta);
        if (messageId && step.state !== "ACTIVE") { ctx.finishMessage(messageId, "complete"); state.replies.delete(step.step_index); }
      };

      const onTool = (step) => {
        const callId = String(step.step_index);
        const tool = step.tool_info ?? {};
        const name = String(step.tool_name ?? tool.name ?? "tool");
        const input = tool.parameters ?? {};
        if (!turn.hasTool(callId)) { ctx.transition("tools"); turn.toolStarted({ callId, name, input, display: `${name} ${JSON.stringify(input)}` }); }
        if (step.state === "ERROR") turn.toolFinished(callId, { text: String(tool.error?.message ?? "the tool failed"), isError: true });
        else if (step.state !== "ACTIVE") turn.toolFinished(callId, { text: typeof tool.output === "string" ? tool.output : "" });
      };

      const onMessage = (message) => {
        const conversationId = message.step_update?.conversation_id || message.result?.conversation_id;
        if (conversationId && recall(session, manifest).conversationId !== conversationId) turn.remember({ conversationId });
        if (message.event === "step_update") {
          const step = message.step_update ?? {};
          if (step.step_type === "agent_response") onReply(step);
          else if (step.step_type === "tool" || turn.hasTool(String(step.step_index))) onTool(step); // a subagent call ends as a "subagent" step
          return; // user_input and system_message steps echo what Jolo already shows
        }
        if (message.event === "result") {
          state.result = message.result ?? {};
          // The turn is over. Closing stdin ends agy (the guardian stops a child whose input ends, so not before), and
          // agy may otherwise wait on background tasks after answering.
          link.end();
          link.terminate();
        }
      };

      ctx.transition("model");
      link.write({ event: "user", message: { content: `${instructions}\n\nCurrent request:\n${prompt}` } });
      try {
        for await (const message of link.messages()) {
          onMessage(message);
          if (state.result) break;
        }
      } catch (error) {
        state.failure = String(error?.message ?? error);
      }
      const { exitCode, stderr } = await link.settle();
      ended.abort();
      gate.close();
      for (const messageId of state.replies.values()) ctx.finishMessage(messageId, "interrupted");
      turn.finish({ usage });
      if (signal.aborted) return { outcome: "cancelled" };
      if (state.failure) return { outcome: "failed", failure: state.failure.slice(0, 500) };
      if (!state.result) return { outcome: "failed", failure: `${manifest.displayName} exited ${exitCode ?? "?"} without a result${stderr ? `: ${stderr.slice(0, 300)}` : ""}` };
      if (state.result.status !== "SUCCESS") return { outcome: "failed", failure: `${manifest.displayName}: ${String(state.result.error || state.result.status || "error")}`.slice(0, 500) };
      return { outcome: "completed" };
    },
  };
}
