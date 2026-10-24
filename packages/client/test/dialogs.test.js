import { expect, test } from "bun:test";
import { answerFor, answersFor, dialogKind, dialogSummary, dismissMessage, readQuestions } from "../src/dialogs.js";

const question = { question: "tea or coffee?", header: "Drink", options: [{ label: "tea", description: "hot leaves" }, { label: "coffee", description: "" }], multiSelect: false };
const multi = { ...question, question: "toppings?", options: [{ label: "milk" }, { label: "sugar" }, { label: "honey" }], multiSelect: true };

test("questions are read so that no shape throws: text-less questions and label-less options are left out", () => {
  expect(readQuestions({ questions: [question, { header: "no text", options: [] }, { question: "bare?", options: [{ description: "no label" }, { label: "ok" }] }] })).toEqual([
    { question: "tea or coffee?", header: "Drink", options: [{ label: "tea", description: "hot leaves" }, { label: "coffee", description: "" }], multiSelect: false },
    { question: "bare?", header: "", options: [{ label: "ok", description: "" }], multiSelect: false },
  ]);
  expect(readQuestions({ truncated: true, preview: "{" })).toEqual([]);
  expect(readQuestions(null)).toEqual([]);
  expect(readQuestions({ questions: "nope" })).toEqual([]);
});

test("a dialog's kind: a question, a plan, one too long to show, one that cannot be read, or another tool", () => {
  expect(dialogKind({ tool: "AskUserQuestion", input: { questions: [question] } })).toBe("question");
  expect(dialogKind({ tool: "ExitPlanMode", input: { plan: "# Plan" } })).toBe("plan");
  expect(dialogKind({ tool: "AskUserQuestion", input: { truncated: true, preview: "{" } })).toBe("truncated");
  expect(dialogKind({ tool: "AskUserQuestion", input: { questions: [] } })).toBe("unreadable");
  expect(dialogKind({ tool: "ExitPlanMode", input: {} })).toBe("unreadable");
  expect(dialogKind({ tool: "SomethingElse", input: { a: 1 } })).toBe("other");
});

test("a typed choice becomes the answer Claude reads: an option number its label, several their labels in option order, anything else the text itself", () => {
  expect(answerFor(question, "2")).toBe("coffee");
  expect(answerFor(question, " 1 ")).toBe("tea");
  expect(answerFor(question, "espresso")).toBe("espresso");
  expect(answerFor(question, "  ")).toBeNull();
  expect(answerFor(question, "3")).toBeNull(); // no such option
  expect(answerFor(question, "0")).toBeNull();
  expect(answerFor(question, "1,2")).toBeNull(); // one answer to a single-select question
  expect(answerFor(multi, "3,1")).toBe("milk, honey");
  expect(answerFor(multi, "2, 2")).toBe("sugar");
  expect(answerFor(multi, "1,4")).toBeNull();
  expect(answerFor(multi, "oat milk")).toBe("oat milk");
});

test("the answers map is keyed by question text and complete only once every question has one", () => {
  expect(answersFor([question, multi], ["2", "1,2"])).toEqual({ "tea or coffee?": "coffee", "toppings?": "milk, sugar" });
  expect(answersFor([question, multi], ["2"])).toBeNull();
  expect(answersFor([question, multi], ["2", "9"])).toBeNull();
  expect(answersFor([], [])).toBeNull();
});

test("what Claude reads when the person turns a dialog away, and the line a dialog is summed up as", () => {
  expect(dismissMessage("AskUserQuestion")).toBe("The user dismissed the question without answering.");
  expect(dismissMessage("ExitPlanMode")).toBe("The user rejected the plan.");
  expect(dismissMessage("Other")).toBe("The user dismissed the request.");
  expect(dialogSummary({ tool: "AskUserQuestion", input: { questions: [question] } })).toBe("tea or coffee?");
  expect(dialogSummary({ tool: "ExitPlanMode", input: { plan: "x" } })).toBe("Plan ready for your review");
  expect(dialogSummary({ tool: "Other", input: {} })).toBe("Other");
});
