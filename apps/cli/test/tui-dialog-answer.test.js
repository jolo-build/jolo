import { expect, test } from "bun:test";
import { createDialogAnswer, dialogHint, dialogKey, dialogPlaceholder } from "../src/tui/dialog-answer.js";

const option = (label) => ({ label, description: "" });
const ask = (questions) => ({ dialogId: "d1", runId: "run", tool: "AskUserQuestion", toolUseId: null, input: { questions } });
const single = ask([{ question: "tea or coffee?", header: "Drink", options: [option("tea"), option("coffee")], multiSelect: false }]);
const plan = { dialogId: "d2", runId: "run", tool: "ExitPlanMode", toolUseId: null, input: { plan: "# Ship it", planFilePath: "/tmp/p.md" } };
const press = (state, chunk, key = {}, draft = "") => dialogKey(state, { chunk, key, draft });
/** The state a key moved the answer to; fails when the key did anything else. */
const moved = (action) => { expect(action.type).toBe("state"); return action.type === "state" ? action.state : null; };

test("an option's number answers a single-choice question at once; typed words answer it on Enter; Esc dismisses it", () => {
  const state = createDialogAnswer(single);
  expect(dialogHint(state, "")).toBe("Question: tea or coffee? · [1]–[2] pick · type an answer, Enter sends · Esc dismisses");
  expect(dialogPlaceholder(state)).toBe("Your answer…");
  expect(press(state, "2")).toEqual({ type: "resolve", response: { answers: { "tea or coffee?": "coffee" } } });
  expect(press(state, "3")).toEqual({ type: "ignore" }); // no such option
  expect(press(state, "2", {}, "espr")).toEqual({ type: "edit" }); // a digit inside typed words is text
  expect(press(state, "", { return: true }, "espresso ")).toEqual({ type: "resolve", response: { answers: { "tea or coffee?": "espresso" } } });
  expect(press(state, "", { return: true }, "")).toEqual({ type: "ignore" }); // nothing to send yet
  expect(press(state, "", { escape: true }, "half typed")).toEqual({ type: "dismiss", message: "The user dismissed the question without answering." });
  expect(press(state, "x")).toEqual({ type: "edit" });
});

test("a multi-select toggles its options by number and answers them together on Enter; several questions are answered in turn", () => {
  const dialog = ask([
    { question: "toppings?", header: "", options: [option("milk"), option("sugar"), option("honey")], multiSelect: true },
    { question: "size?", header: "Cup", options: [option("small"), option("large")], multiSelect: false },
  ]);
  let state = createDialogAnswer(dialog);
  expect(dialogHint(state, "")).toBe("Question 1 of 2: toppings? · [1]–[3] pick several · Enter answers · type an answer · Esc dismisses");
  state = moved(press(state, "3"));
  state = moved(press(state, "1"));
  expect(dialogHint(state, "")).toBe("Question 1 of 2: toppings? · picked: milk, honey · [1]–[3] pick several · Enter answers · type an answer · Esc dismisses");
  state = moved(press(state, "3")); // unpick
  state = moved(press(state, "", { return: true }, ""));
  expect(dialogHint(state, "")).toBe("Question 2 of 2 (Cup): size? · [1]–[2] pick · type an answer, Enter sends · Esc dismisses");
  expect(press(state, "2")).toEqual({ type: "resolve", response: { answers: { "toppings?": "milk", "size?": "large" } } });
  // Typed words answer a multi-select too, and a bare Enter with nothing picked sends nothing.
  const fresh = createDialogAnswer(dialog);
  expect(press(fresh, "", { return: true }, "")).toEqual({ type: "ignore" });
  expect(press(fresh, "", { return: true }, "oat milk").type).toBe("state");
});

test("a plan is approved with Enter, sent back with typed feedback on Enter, or sent back by Esc; one that cannot be shown can only be dismissed", () => {
  const state = createDialogAnswer(plan);
  expect(dialogHint(state, "")).toBe("Enter approves · type what should change, Enter sends it back · Esc sends it back");
  expect(dialogPlaceholder(state)).toBe("What should change? (optional)");
  expect(press(state, "", { return: true }, "")).toEqual({ type: "resolve", response: {} });
  expect(press(state, "", { return: true }, " Add tests. ")).toEqual({ type: "dismiss", message: "Add tests." });
  expect(press(state, "", { escape: true }, "Add tests.")).toEqual({ type: "dismiss", message: "The user rejected the plan." });
  expect(press(state, "a")).toEqual({ type: "edit" }); // letters are feedback, never a shortcut
  const truncated = createDialogAnswer({ ...single, input: { truncated: true, preview: "{" } });
  expect(dialogHint(truncated, "")).toBe("Enter or Esc dismisses");
  expect(press(truncated, "", { return: true })).toEqual({ type: "dismiss", message: "The user dismissed the question without answering." });
  expect(press(truncated, "1")).toEqual({ type: "ignore" });
  const other = createDialogAnswer({ ...plan, tool: "Elicit", input: { a: 1 } });
  expect(dialogHint(other, "")).toBe("Enter allows · Esc dismisses");
  expect(press(other, "", { return: true })).toEqual({ type: "resolve", response: {} });
  expect(press(other, "", { escape: true })).toEqual({ type: "dismiss", message: "The user dismissed the request." });
});
