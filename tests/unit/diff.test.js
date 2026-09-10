import { describe, expect, test } from "bun:test";
import { editScript, fileDiff, patchDiff } from "../../apps/engine/src/workspaces/diff.js";

const buffer = (text) => Buffer.from(text);
const rows = (text) => text.split("\n").filter((line, index, all) => index < all.length - 1 || line !== "");

describe("diffing what a patch changed", () => {
  test("an edit script accounts for every line of both sides", () => {
    // The property that matters: keep the context and the removals and you have the old file; keep the
    // context and the additions and you have the new one.
    const cases = [
      ["a\nb\nc\n", "a\nB\nc\n"],
      ["", "one\ntwo\n"],
      ["one\ntwo\n", ""],
      ["a\nb\nc\nd\ne\n", "c\nd\ne\nf\n"],
      ["same\n", "same\n"],
      [Array.from({ length: 120 }, (_, i) => `line ${i}`).join("\n"), Array.from({ length: 120 }, (_, i) => (i % 7 ? `line ${i}` : `LINE ${i}`)).join("\n")],
    ];
    for (const [before, after] of cases) {
      const a = rows(before);
      const b = rows(after);
      const ops = editScript(a, b);
      expect(ops).not.toBeNull();
      expect(ops.filter((op) => op.op !== "+").map((op) => op.text)).toEqual(a);
      expect(ops.filter((op) => op.op !== "-").map((op) => op.text)).toEqual(b);
    }
  });

  test("a changed file reads as a unified diff, with the lines either side for bearings", () => {
    const diff = fileDiff({ path: "src/app.js", op: "replace", before: buffer("one\ntwo\nthree\nfour\nfive\n"), after: buffer("one\ntwo\nTHREE\nfour\nfive\n") });
    expect(diff[0]).toBe("diff --git a/src/app.js b/src/app.js");
    expect(diff[1]).toBe("--- a/src/app.js");
    expect(diff[2]).toBe("+++ b/src/app.js");
    expect(diff[3]).toBe("@@ -1,5 +1,5 @@");
    expect(diff.slice(4)).toEqual([" one", " two", "-three", "+THREE", " four", " five"]);
  });

  test("a new file, a deleted file, and a rename each say so the way git says it", () => {
    expect(fileDiff({ path: "new.txt", op: "create", before: null, after: buffer("hello\n") })).toEqual([
      "diff --git a/new.txt b/new.txt", "--- /dev/null", "+++ b/new.txt", "@@ -0,0 +1,1 @@", "+hello",
    ]);
    expect(fileDiff({ path: "old.txt", op: "delete", before: buffer("gone\n"), after: null })).toEqual([
      "diff --git a/old.txt b/old.txt", "--- a/old.txt", "+++ /dev/null", "@@ -1,1 +0,0 @@", "-gone",
    ]);
    expect(fileDiff({ path: "a.txt", newPath: "b.txt", op: "rename", before: buffer("same\n"), after: buffer("same\n") })).toEqual([
      "diff --git a/a.txt b/b.txt", "rename from a.txt", "rename to b.txt",
    ]);
  });

  test("distant edits become separate hunks, and near ones share a hunk", () => {
    const before = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") + "\n";
    const apart = fileDiff({ path: "f", op: "replace", before: buffer(before), after: buffer(before.replace("line 2\n", "TWO\n").replace("line 25\n", "TWENTY-FIVE\n")) });
    expect(apart.filter((line) => line.startsWith("@@"))).toHaveLength(2);
    const together = fileDiff({ path: "f", op: "replace", before: buffer(before), after: buffer(before.replace("line 2\n", "TWO\n").replace("line 4\n", "FOUR\n")) });
    expect(together.filter((line) => line.startsWith("@@"))).toHaveLength(1);
  });

  test("a file with no change contributes nothing", () => {
    expect(fileDiff({ path: "same", op: "replace", before: buffer("x\n"), after: buffer("x\n") })).toEqual([]);
    expect(patchDiff([{ path: "same", op: "replace", before: buffer("x\n"), after: buffer("x\n") }])).toMatchObject({ text: "", files: 0 });
  });

  test("what cannot be shown usefully is said in a line rather than dumped", () => {
    const binary = fileDiff({ path: "logo.png", op: "replace", before: Buffer.from([1, 2, 0, 3]), after: Buffer.from([4, 0, 5]) });
    expect(binary.at(-1)).toBe("Binary file logo.png changed");
    const huge = fileDiff({ path: "big.txt", op: "replace", before: Buffer.alloc(2 * 1024 * 1024, 97), after: Buffer.alloc(3, 98) });
    expect(huge.at(-1)).toContain("too large to diff here");
    // A file replaced wholesale beyond the effort budget is counted, not diffed line by line.
    const from = Array.from({ length: 4000 }, (_, i) => `old ${i}`).join("\n");
    const to = Array.from({ length: 4000 }, (_, i) => `new ${i}`).join("\n");
    const rewritten = fileDiff({ path: "rewrite.txt", op: "replace", before: buffer(from), after: buffer(to) });
    expect(rewritten.at(-1)).toContain("was rewritten");
  });

  test("a patch over several files is one diff, bounded, and says when it was cut short", () => {
    const files = Array.from({ length: 40 }, (_, i) => ({ path: `file${i}.txt`, op: "replace", before: buffer("a\nb\nc\n"), after: buffer(`a\nchanged ${i}\nc\n`) }));
    const all = patchDiff(files, { maxLines: 60 });
    expect(all.truncated).toBe(true);
    expect(all.text.split("\n").length).toBeLessThanOrEqual(61);
    expect(all.text).toContain("diff truncated");
    const small = patchDiff(files.slice(0, 2));
    expect(small.truncated).toBe(false);
    expect(small.files).toBe(2);
    expect(small.text).toContain("+changed 0");
    expect(small.text).toContain("+changed 1");
  });
});
