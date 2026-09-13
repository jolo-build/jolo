import { expect, test } from "bun:test";
import { deletePreviousWord, editDraft, editInput, inputViewport } from "../src/tui/input.js";

test("arrows move the insertion point and editing preserves text on both sides", () => {
  let state = editInput("fix bug", 7, "", { leftArrow: true });
  expect(state).toEqual({ value: "fix bug", cursor: 6 });
  state = editInput(state.value, state.cursor, "i");
  expect(state).toEqual({ value: "fix buig", cursor: 7 });
  expect(editInput(state.value, state.cursor, "", { backspace: true })).toEqual({ value: "fix bug", cursor: 6 });
  expect(editInput(state.value, state.cursor, "", { delete: true })).toEqual({ value: "fix bui", cursor: 7 });
  expect(editInput("abc", 0, "", { leftArrow: true }).cursor).toBe(0);
  expect(editInput("abc", 3, "", { rightArrow: true }).cursor).toBe(3);
  expect(editInput("abc", 1, "", { rightArrow: true }).cursor).toBe(2);
});

test("Option arrows and Escape+b/f traverse words without changing the draft", () => {
  for (const [chunk, key] of [["", { leftArrow: true, meta: true }], ["", { leftArrow: true, ctrl: true }], ["b", { meta: true }]]) {
    expect(editInput("fix the bug  ", 13, chunk, key)).toEqual({ value: "fix the bug  ", cursor: 8 });
  }
  for (const [chunk, key] of [["", { rightArrow: true, meta: true }], ["", { rightArrow: true, ctrl: true }], ["f", { meta: true }]]) {
    expect(editInput("fix the bug", 3, chunk, key)).toEqual({ value: "fix the bug", cursor: 7 });
  }
  expect(editInput("fix the bug", 8, "w", { ctrl: true })).toEqual({ value: "fix bug", cursor: 4 });
  expect(editInput("fix the bug", 4, "", { backspace: true, meta: true })).toEqual({ value: "the bug", cursor: 0 });
});

test("cursor movement and deletion preserve emoji and combining characters", () => {
  for (const character of ["🚀", "e\u0301", "👩‍💻", "🇦🇿"]) {
    const value = `a${character}b`;
    expect(editInput(value, 1, "", { rightArrow: true }).cursor).toBe(1 + character.length);
    expect(editInput(value, 1 + character.length, "", { leftArrow: true }).cursor).toBe(1);
    expect(editInput(value, 1 + character.length, "", { backspace: true })).toEqual({ value: "ab", cursor: 1 });
    expect(editInput(value, 1, "", { delete: true })).toEqual({ value: "ab", cursor: 1 });
  }
});

test("cursor editing ignores releases, sanitizes paste, and retains the suffix at the limit", () => {
  expect(editInput("abc", 1, "", { leftArrow: true, eventType: "release" })).toEqual({ value: "abc", cursor: 1 });
  expect(editInput("ab", 1, "\x1b[31mX\x1b[0m")).toEqual({ value: "aXb", cursor: 2 });
  const value = "a".repeat(64 * 1024 - 2) + "z";
  expect(editInput(value, 0, "XY")).toEqual({ value: "X" + value, cursor: 1 });
  expect(editInput(value, 0, "🚀")).toEqual({ value, cursor: 0 });
});

test("the viewport keeps the caret visible when traversing long and wide input", () => {
  expect(inputViewport("abcdefghij", 10, 5)).toEqual({ before: "ghij", caret: " ", after: "" });
  expect(inputViewport("abcdefghij", 2, 5)).toEqual({ before: "ab", caret: "c", after: "de" });
  expect(inputViewport("abcdefghij", 0, 5)).toEqual({ before: "", caret: "a", after: "bcde" });
  expect(inputViewport("界🚀abc", 3, 5)).toEqual({ before: "界🚀", caret: "a", after: "" });
  expect(inputViewport("", 0, 5)).toEqual({ before: "", caret: " ", after: "" });
});

test("word deletion preserves earlier words and their separating space", () => {
  expect(deletePreviousWord("fix the bug")).toBe("fix the ");
  expect(deletePreviousWord("fix the bug  \t")).toBe("fix the ");
  expect(deletePreviousWord("fix\t\tbug")).toBe("fix\t\t");
  expect(deletePreviousWord("fix src/app.js")).toBe("fix ");
  expect(deletePreviousWord("fix café 🚀")).toBe("fix café ");
  expect(deletePreviousWord(deletePreviousWord("fix the bug"))).toBe("fix ");
});

test("word deletion handles empty drafts, whitespace, and the input size limit", () => {
  for (const value of ["", " \t\n", "word", "a".repeat(64 * 1024)]) expect(deletePreviousWord(value)).toBe("");
});

test("Ctrl/Alt Backspace and Ctrl+W delete a word while ordinary Backspace deletes one character", () => {
  for (const [chunk, key] of [["", { backspace: true, ctrl: true }], ["", { backspace: true, meta: true }], ["w", { ctrl: true }]]) {
    expect(editDraft("query discard  ", chunk, key)).toBe("query ");
  }
  expect(editDraft("queryX", "", { backspace: true })).toBe("query");
  expect(editDraft("queryX", "", { delete: true })).toBe("query");
  expect(editDraft("", "", { backspace: true })).toBe("");
});

test("q is ordinary input and printable Unicode stays intact", () => {
  expect(editDraft("", "q")).toBe("q");
  expect(editDraft("q", "uery café 🚀")).toBe("query café 🚀");
  expect(editDraft("", "Q", { shift: true })).toBe("Q");
});

test("key releases and shortcuts do not modify the draft", () => {
  for (const key of [{ ctrl: true }, { meta: true }, { super: true }, { escape: true }, { return: true }, { tab: true }, { eventType: "release" }, { backspace: true, eventType: "release" }]) {
    expect(editDraft("draft", "q", key)).toBe("draft");
  }
  expect(editDraft("", "q", { eventType: "repeat" })).toBe("q");
});

test("input strips controls and respects the draft memory limit", () => {
  expect(editDraft("", "a\x00\x07\x1bb\x7f\tc")).toBe("abc");
  expect(editDraft("a".repeat(64 * 1024 - 1), "bc")).toBe("a".repeat(64 * 1024 - 1) + "b");
});

test("pasted terminal output loses its escape sequences but keeps ordinary bracketed text", () => {
  expect(editDraft("", "\x1b[31mred\x1b[0m text")).toBe("red text");
  expect(editDraft("", "[31mred[0m text")).toBe("red text"); // Ink may consume the escape byte itself
  expect(editDraft("", "\x1b]0;window title\x07done")).toBe("done");
  expect(editDraft("", "see [1] and a[0]b")).toBe("see [1] and a[0]b");
});
