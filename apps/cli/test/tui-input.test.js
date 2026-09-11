import { expect, test } from "bun:test";
import { deletePreviousWord, editDraft } from "../src/tui/input.js";

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
