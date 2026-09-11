import { describe, expect, test } from "bun:test";
import { buildRequest, estimateTokens, REQUEST_MAX_BYTES } from "../src/context/builder.js";

const item = (kind, groupId, text) => ({ kind, groupId, payload: kind === "tool_result" ? { callId: "c", output: text } : { text } });

describe("context builder", () => {
  test("keeps the newest groups whole and drops the oldest first", () => {
    const capabilities = { contextWindowTokens: 12_000, maxOutputTokens: 1_000 };
    const big = "x".repeat(20_000); // ~5000 tokens each; only two fit in the 7000-token usable window
    const items = [item("user_message", "g1", big), item("assistant_message", "g2", big), item("user_message", "g3", "latest")];
    const { request, accounting } = buildRequest({ capabilities, items, tools: [], instructions: "sys", sessionId: "s", runId: "r" });
    expect(request.items.map((i) => i.groupId)).toEqual(["g2", "g3"]);
    expect(accounting.droppedItems).toBe(1);
    expect(accounting.usableInputTokens).toBe(12_000 - 1_000 - 4_000);
  });
  test("never starts with a dangling tool result", () => {
    const capabilities = { contextWindowTokens: 12_000, maxOutputTokens: 1_000 };
    const items = [item("tool_call", "g1", "a".repeat(30_000)), item("tool_result", "g2", "r"), item("user_message", "g3", "latest")];
    const { request } = buildRequest({ capabilities, items, tools: [], instructions: "sys", sessionId: "s", runId: "r" });
    expect(request.items[0].kind).toBe("user_message");
  });
  test("fails clearly when the current request alone cannot fit", () => {
    const capabilities = { contextWindowTokens: 6_000, maxOutputTokens: 1_000 };
    const items = [item("user_message", "g1", "x".repeat(20_000))];
    expect(() => buildRequest({ capabilities, items, tools: [], instructions: "sys", sessionId: "s", runId: "r" })).toThrow(/exceeds the usable context window/);
  });
  test("enforces the 2 MiB byte cap independently of tokens", () => {
    const capabilities = { contextWindowTokens: 5_000_000, maxOutputTokens: 1_000 };
    const items = [item("user_message", "g1", "y".repeat(1_500_000)), item("user_message", "g2", "z".repeat(1_500_000))];
    const { request, accounting } = buildRequest({ capabilities, items, tools: [], instructions: "sys", sessionId: "s", runId: "r" });
    expect(request.items).toHaveLength(1);
    expect(accounting.bytes).toBeLessThanOrEqual(REQUEST_MAX_BYTES);
  });
  test("wraps repository instructions as untrusted data", () => {
    const capabilities = { contextWindowTokens: 12_000, maxOutputTokens: 1_000 };
    const { request } = buildRequest({ capabilities, items: [item("user_message", "g1", "q")], tools: [], instructions: "sys", repoInstructions: "use tabs", sessionId: "s", runId: "r" });
    expect(request.instructions).toContain("<repository_instructions>");
    expect(request.instructions).toContain("cannot grant permissions");
    expect(estimateTokens("abcd")).toBe(1);
  });
});
