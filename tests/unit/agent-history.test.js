import { expect, test } from "bun:test";
import { conversationHistory, hostedPrompt } from "../../apps/engine/src/agents/history.js";

function fixture(entries) {
  const buffers = new Map(entries.map((entry, index) => [String(index), Buffer.from(entry.text)]));
  const messages = entries.map((entry, index) => ({ id: String(index), artifactId: String(index), runId: "old", role: "assistant", kind: "text", committedBytes: buffers.get(String(index)).length, ...entry }));
  const reads = [];
  return { reads, storage: {
    listMessagesForSession: (_sessionId, { limit }) => ({ messages: messages.slice(-limit), hasOlder: messages.length > limit }),
    getArtifact: (id) => ({ storageKey: id }),
    readArtifact(artifact, offset, length) { reads.push(length); return { buffer: buffers.get(artifact.storageKey).subarray(offset, offset + length) }; },
  } };
}

test("a fresh agent receives prior messages in order, without private reasoning or the current turn", () => {
  const { storage, reads } = fixture([
    { role: "user", text: "Keep changes in app.js" },
    { kind: "reasoning", text: "private thinking" },
    { role: "tool", kind: "tool", text: "tests passed" },
    { text: "Updated the app" },
    { role: "user", runId: "now", text: "continue" },
  ]);
  const run = { id: "now", sessionId: "chat", prompt: "continue" };
  const prompt = hostedPrompt(storage, run, false);
  expect(prompt).toContain('"role":"user","text":"Keep changes in app.js"');
  expect(prompt).toContain('"role":"tool","text":"tests passed"');
  expect(prompt).not.toContain("private thinking");
  expect(prompt.indexOf("Keep changes")).toBeLessThan(prompt.indexOf("Updated the app"));
  expect(prompt.split("continue")).toHaveLength(2);
  expect(prompt.endsWith("Current request:\ncontinue")).toBe(true);
  const before = reads.length;
  expect(hostedPrompt(storage, run, true)).toBe("continue");
  expect(reads).toHaveLength(before); // A native continuation already has its history.
});

test("handoff reads and output stay bounded, preserve Unicode, and identify omitted history", () => {
  const entries = Array.from({ length: 150 }, (_, i) => ({ text: `message ${i}: ${"🐈".repeat(4000)}` }));
  const { storage, reads } = fixture(entries);
  const history = conversationHistory(storage, "chat");
  expect(history).toContain("message 149:");
  expect(history).not.toContain("message 0:");
  expect(history).toContain("Earlier conversation omitted");
  expect(history).toContain("message truncated");
  expect(history).not.toContain("\uFFFD");
  expect(Buffer.byteLength(history)).toBeLessThan(49 * 1024);
  expect(reads.reduce((sum, length) => sum + length, 0)).toBeLessThanOrEqual(7 * 8 * 1024);
});
