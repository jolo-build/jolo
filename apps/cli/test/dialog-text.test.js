import { expect, test } from "bun:test";
import { dialogLines } from "../src/dialog-text.js";

const question = (text, options, multiSelect = false, header = "Drink") => ({ question: text, header, options: options.map(([label, description = ""]) => ({ label, description })), multiSelect });

test("a question is shown with its options numbered and a way to answer in the person's own words", () => {
  expect(dialogLines({ tool: "AskUserQuestion", input: { questions: [question("tea or coffee?", [["tea", "hot leaves"], ["coffee"]])] } })).toEqual([
    "Claude asks: tea or coffee?",
    "  [1] tea — hot leaves",
    "  [2] coffee",
    "  or type your own answer",
  ]);
});

test("several questions are numbered, and a multi-select says how to pick several", () => {
  expect(dialogLines({ tool: "AskUserQuestion", input: { questions: [question("tea or coffee?", [["tea"], ["coffee"]]), question("toppings?", [["milk"], ["sugar"]], true, "")] } })).toEqual([
    "Claude asks 2 questions.",
    "Question 1 of 2 (Drink): tea or coffee?",
    "  [1] tea",
    "  [2] coffee",
    "  or type your own answer",
    "Question 2 of 2: toppings?",
    "  [1] milk",
    "  [2] sugar",
    "  pick several as 1,2 · or type your own answer",
  ]);
});

test("a plan is shown in full under its heading; a question too long for its event, or unreadable, can only be dismissed", () => {
  expect(dialogLines({ tool: "ExitPlanMode", input: { plan: "# Ship it\n\n1. Do the thing.", planFilePath: "/tmp/plan.md" } })).toEqual([
    "Plan ready for your review",
    "# Ship it",
    "",
    "1. Do the thing.",
  ]);
  expect(dialogLines({ tool: "AskUserQuestion", input: { truncated: true, preview: '{"questions":[' } })).toEqual([
    "Claude's question is too long to show here; it can only be dismissed.",
    '{"questions":[',
  ]);
  expect(dialogLines({ tool: "ExitPlanMode", input: { plan: 7 } })).toEqual(["Claude's request could not be shown; it can only be dismissed."]);
});

test("another tool's request shows its input as JSON, bounded", () => {
  const lines = dialogLines({ tool: "Elicit", input: { fields: Array.from({ length: 100 }, (_, i) => `f${i}`) } });
  expect(lines[0]).toBe("Claude asks (Elicit):");
  expect(lines[1]).toBe("{");
  expect(lines.length).toBeLessThanOrEqual(42);
  expect(lines.at(-1)).toMatch(/^… \d+ more lines$/);
});
