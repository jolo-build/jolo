// Deterministic fake provider for tests and fixtures. Emits the §7.1 event contract without a network.
import { readFileSync } from "node:fs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {{ steps?: number, delayMs?: number, script?: any[] | null, contextWindowTokens?: number, maxOutputTokens?: number }} options
 * Script turns: { text?: string[], reasoning?: string, toolCalls?: [{ name, arguments }], error?: { category, retryable, once?: boolean }, usage?: { inputTokens, outputTokens } }
 */
export function createFakeProvider(options = {}) {
  const steps = options.steps ?? 20;
  const delayMs = options.delayMs ?? 100;
  const script = options.script ?? null;
  const firedErrors = new Set();
  // The turn index derives from the persisted transcript, so it survives new runs and provider instances.
  const turnIndexOf = (items) => new Set(items.filter((item) => ["assistant_message", "tool_call", "reasoning"].includes(item.kind)).map((item) => item.groupId)).size;
  return {
    name: "fake",
    capabilities() {
      return { contextWindowTokens: options.contextWindowTokens ?? 128_000, maxOutputTokens: options.maxOutputTokens ?? 4_096, supportsTools: true, supportsReasoning: true };
    },
    async *stream(request, signal) {
      if (request.purpose === "handoff") {
        // A handoff note in the shape the real one is asked for, with a mark tests can find, and the count of
        // lines it was shown so a test can check it saw the omitted middle rather than nothing.
        const source = request.items[0]?.payload.text ?? "";
        const lines = source.split("\n").filter(Boolean).length;
        yield { type: "text_delta", itemId: "handoff", text: `Handoff note (fake): original request, what was accomplished, decisions, what remains, next step. Saw ${lines} lines of the earlier conversation.` };
        yield { type: "usage", inputTokens: 1, outputTokens: 1 };
        yield { type: "finished", reason: "completed" };
        return;
      }
      if (request.purpose === "compaction") {
        const source = request.items[0]?.payload.text ?? "";
        yield { type: "text_delta", itemId: "compaction", text: `Objective: continue the task.\nConstraints: none recorded.\nDecisions: none.\nWork completed: ${Math.min(999, source.split("TOOL CALL").length - 1)} tool calls summarized.\nUnresolved questions: none.\nVerification evidence: see recent results.\n` };
        yield { type: "usage", inputTokens: 1, outputTokens: 1 };
        yield { type: "finished", reason: "completed" };
        return;
      }
      const turnIndex = request.turnIndex ?? turnIndexOf(request.items);
      const scriptIndex = script ? Math.min(turnIndex, script.length - 1) : 0;
      const prompt = [...request.items].reverse().find((item) => item.kind === "user_message")?.payload.text ?? "";
      const turn = script ? (script[scriptIndex] ?? {}) : { text: [...Array.from({ length: steps }, (_, i) => `step ${i}\n`), `done: ${prompt.slice(0, 40)}\n`] };
      const errorKey = `${request.sessionId}:${scriptIndex}`;
      if (turn.error && (!turn.error.once || !firedErrors.has(errorKey))) {
        firedErrors.add(errorKey); // a failed attempt is not a model turn; the retry replays this script entry
        if (turn.error.partialText) yield { type: "text_delta", itemId: `msg_${turnIndex}`, text: turn.error.partialText };
        yield { type: "error", category: turn.error.category ?? "provider", retryable: Boolean(turn.error.retryable), message: turn.error.message ?? "scripted failure" };
        return;
      }
      if (turn.reasoning) {
        yield { type: "reasoning_delta", itemId: `rs_${turnIndex}`, blockId: `rs_${turnIndex}:0`, kind: "summary", text: turn.reasoning };
        yield { type: "reasoning_complete", itemId: `rs_${turnIndex}`, blockId: `rs_${turnIndex}:0`, status: "complete" };
        yield { type: "continuation_item", native: { type: "reasoning", id: `rs_${turnIndex}`, summary: [{ type: "summary_text", text: turn.reasoning }], encrypted_content: `fake-encrypted-${turnIndex}` } };
      }
      for (const text of turn.text ?? []) {
        if (signal.aborted) return;
        yield { type: "text_delta", itemId: `msg_${turnIndex}`, text };
        if (delayMs) await sleep(delayMs);
      }
      for (const [i, call] of (turn.toolCalls ?? []).entries()) {
        const callId = `call_${turnIndex}_${i}`;
        const encoded = JSON.stringify(call.arguments ?? {});
        yield { type: "tool_call_delta", callId, fragment: encoded };
        yield { type: "tool_call_complete", callId, name: call.name, arguments: call.rawArguments !== undefined ? call.rawArguments : call.arguments ?? {} };
      }
      yield { type: "usage", inputTokens: turn.usage?.inputTokens ?? 10, outputTokens: turn.usage?.outputTokens ?? 5 };
      yield { type: "finished", reason: turn.toolCalls?.length ? "tool_calls" : "completed" };
    },
  };
}

export function loadFakeScript(env = process.env) {
  if (!env.JOLO_FAKE_SCRIPT) return null;
  return JSON.parse(readFileSync(env.JOLO_FAKE_SCRIPT, "utf8"));
}
