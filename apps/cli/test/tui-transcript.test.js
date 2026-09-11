import { expect, test } from "bun:test";
import { messageLines } from "../src/tui/native-transcript.jsx";

const text = (lines) => lines.map((entry) => entry.spans.map((span) => span.text).join(""));
const message = (fields) => ({ role: "assistant", kind: "text", status: "complete", evicted: false, ...fields });

test("every message kind printed into scrollback is bounded", () => {
  const long = Array.from({ length: 400 }, (_, index) => `sentence number ${index} that runs on for a while`).join(" ");
  const reasoning = messageLines(message({ kind: "reasoning", text: long }), 78, false);
  expect(reasoning.length).toBeLessThanOrEqual(28);
  expect(text(reasoning)[0]).toBe("reasoning"); // labelled, so it is never mistaken for the answer
  expect(text(reasoning).at(-2)).toMatch(/more reasoning lines$/);

  const tool = messageLines(message({ kind: "tool", text: `run_command\n${Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n")}` }), 78, true);
  expect(tool.length).toBeLessThanOrEqual(42);

  const answer = messageLines(message({ text: Array.from({ length: 600 }, (_, i) => `paragraph ${i}`).join("\n\n") }), 78, false);
  expect(answer.length).toBeLessThanOrEqual(402);
});

test("short reasoning keeps its label and gains no truncation notice", () => {
  const lines = text(messageLines(message({ kind: "reasoning", text: "Check the config first." }), 78, false));
  expect(lines[0]).toBe("reasoning");
  expect(lines[1]).toBe("Check the config first.");
  expect(lines.some((entry) => entry.includes("more reasoning lines"))).toBe(false);
});

test("tool details print alone when the body is revealed after the head was already written", () => {
  const tool = message({ kind: "tool", text: "run_command\nexit 0" });
  expect(text(messageLines(tool, 78, true, true))).not.toContain("→ run_command");
  expect(text(messageLines(tool, 78, true, false))).toContain("→ run_command");
  expect(text(messageLines(tool, 78, false, false)).join("\n")).not.toContain("exit 0"); // hidden until Tab
});

test("an evicted message says so instead of printing empty space", () => {
  expect(text(messageLines(message({ evicted: true, text: "" }), 78, false))).toEqual(["[older text released]"]);
});
