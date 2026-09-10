import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { newestSourceTime } from "../../apps/desktop/src/main/staleness.mjs";

const roots = [];
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A source tree whose files can be given exact modification times. */
function tree(files) {
  const root = mkdtempSync(path.join(tmpdir(), "jolo-staleness-"));
  roots.push(root);
  for (const [relative, at] of Object.entries(files)) {
    const full = path.join(root, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, "// source\n");
    const seconds = at / 1000;
    utimesSync(full, seconds, seconds);
  }
  return root;
}

const iso = (ms) => new Date(ms).toISOString();
const NOON = Date.parse("2026-09-09T12:00:00.000Z");

describe("measuring when the code on disk last changed", () => {
  test("answers with the newest source file, whichever directory it is in", () => {
    const root = tree({ "engine/src/main.js": NOON - 60_000, "engine/src/agents/codex.js": NOON + 60_000, "packages/protocol/src/schemas.js": NOON });
    expect(newestSourceTime([root])).toBe(NOON + 60_000);
  });

  test("reads source only, so a build or a dependency never looks like a change", () => {
    const root = tree({
      "engine/src/main.js": NOON,
      "node_modules/pkg/index.js": NOON + 600_000,
      "dist/bundle.js": NOON + 600_000,
      "smoke-results/smoke.json": NOON + 600_000,
      ".git/index": NOON + 600_000,
      "engine/src/notes.md": NOON + 600_000,
    });
    expect(newestSourceTime([root])).toBe(NOON);
  });

  test("counts the file kinds an engine actually loads", () => {
    const ts = tree({ "migrations/0009_x.ts": NOON + 1_000, "engine/src/main.js": NOON });
    expect(newestSourceTime([ts])).toBe(NOON + 1_000);
    const sql = tree({ "migrations/0009_x.sql": NOON + 1_000, "engine/src/main.js": NOON });
    expect(newestSourceTime([sql])).toBe(NOON + 1_000); // a migration is code the engine runs
    const json = tree({ "packages/protocol/package.json": NOON + 1_000, "engine/src/main.js": NOON });
    expect(newestSourceTime([json])).toBe(NOON + 1_000);
  });

  test("says nothing rather than guessing when there is no tree to read", () => {
    const root = tree({ "engine/src/main.js": NOON });
    expect(newestSourceTime([path.join(root, "absent")])).toBeNull();
    expect(newestSourceTime([])).toBeNull();
  });
});
