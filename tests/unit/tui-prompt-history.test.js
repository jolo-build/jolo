import { expect, test } from "bun:test";
import { createPromptState, promptReducer, MAX_PROMPT_HISTORY, MAX_PROMPT_HISTORY_CHARS } from "../../apps/cli/src/tui/prompt-history.js";

const step = (state, type, values = {}) => promptReducer(state, { type, ...values });
const seeded = (...prompts) => step(createPromptState(), "seed", { prompts });

test("Up walks newest to oldest; Down walks forward and restores the unsent draft", () => {
  let state = step(seeded("first", "second", "third"), "edit", { chunk: "unfinished draft" });
  for (const expected of ["third", "second", "first", "first"]) {
    state = step(state, "previous");
    expect(state.value).toBe(expected);
  }
  for (const expected of ["second", "third", "unfinished draft", "unfinished draft"]) {
    state = step(state, "next");
    expect(state.value).toBe(expected);
  }
  expect(state.index).toBeNull();
});

test("arrows do nothing to a draft when there is no prompt history", () => {
  const state = step(createPromptState(), "edit", { chunk: "draft" });
  expect(step(state, "previous")).toBe(state);
  expect(step(state, "next")).toBe(state);
});

test("editing a recalled prompt never overwrites history or the original draft", () => {
  let state = step(seeded("old prompt"), "edit", { chunk: "my draft" });
  state = step(state, "previous");
  state = step(state, "edit", { chunk: " revised" });
  expect(state.value).toBe("old prompt revised");
  expect(state.history).toEqual(["old prompt"]);
  state = step(state, "next");
  expect(state.value).toBe("my draft");
  expect(step(state, "previous").value).toBe("old prompt");
});

test("submitting recalled or new text records it immediately and resets navigation", () => {
  let state = step(seeded("first"), "previous");
  state = step(state, "submit", { prompt: "second" });
  expect(state).toMatchObject({ value: "", index: null, draft: "", history: ["first", "second"] });
  expect(step(state, "previous").value).toBe("second");
  state = step(state, "submit", { prompt: "second" });
  expect(state.history).toEqual(["first", "second"]);
});

test("saved history arriving late preserves typing and newer submitted prompts", () => {
  let state = step(createPromptState(), "submit", { prompt: "new" });
  state = step(state, "edit", { chunk: "draft" });
  state = step(state, "previous");
  state = step(state, "seed", { prompts: ["old", "new"] });
  expect(state.history).toEqual(["old", "new"]);
  expect(state.value).toBe("new");
  expect(step(state, "previous").value).toBe("old");
  expect(step(state, "next").value).toBe("draft");
});

test("prompt history stays bounded and skips empty entries", () => {
  const many = seeded(...Array.from({ length: 100 }, (_, i) => `prompt ${i}`), "", "  ", undefined);
  expect(many.history).toHaveLength(MAX_PROMPT_HISTORY);
  expect(many.history.at(-1)).toBe("prompt 99");
  const large = seeded(...Array.from({ length: 10 }, (_, i) => String(i).repeat(64 * 1024)));
  expect(large.history.reduce((count, value) => count + value.length, 0)).toBeLessThanOrEqual(MAX_PROMPT_HISTORY_CHARS);
  expect(large.history.at(-1)).toBe("9".repeat(64 * 1024));
});
