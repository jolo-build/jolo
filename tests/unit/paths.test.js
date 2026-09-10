import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveWorkspacePath } from "../../apps/engine/src/tools/paths.js";

const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "jolo-paths-")));
mkdirSync(path.join(root, "src", "nested"), { recursive: true });
mkdirSync(path.join(root, ".git"));
writeFileSync(path.join(root, "src", "app.js"), "console.log('hi')\n");
writeFileSync(path.join(root, ".git", "config"), "[core]\n");
symlinkSync("/etc", path.join(root, "escape"));
symlinkSync(path.join(root, "src", "app.js"), path.join(root, "src", "link.js"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const code = (fn) => { try { fn(); return "ok"; } catch (error) { return error.code; } };

describe("workspace path resolution", () => {
  test("accepts normal relative paths and the root itself", () => {
    expect(resolveWorkspacePath(root, "src/app.js").absolute).toBe(path.join(root, "src", "app.js"));
    expect(resolveWorkspacePath(root, "./src//nested/").relative).toBe("src/nested");
    expect(resolveWorkspacePath(root, ".").absolute).toBe(root);
    expect(resolveWorkspacePath(root, "").absolute).toBe(root);
  });
  test("rejects escapes, absolute paths, NUL bytes, and repository metadata", () => {
    expect(code(() => resolveWorkspacePath(root, "../outside"))).toBe("invalid_path");
    expect(code(() => resolveWorkspacePath(root, "src/../../x"))).toBe("invalid_path");
    expect(code(() => resolveWorkspacePath(root, "/etc/passwd"))).toBe("invalid_path");
    expect(code(() => resolveWorkspacePath(root, "src/a\0b"))).toBe("invalid_path");
    expect(code(() => resolveWorkspacePath(root, ".git/config"))).toBe("repository_metadata");
  });
  test("refuses symlinks in any component", () => {
    expect(code(() => resolveWorkspacePath(root, "escape/passwd"))).toBe("symlink_denied");
    expect(code(() => resolveWorkspacePath(root, "src/link.js"))).toBe("symlink_denied");
  });
  test("reports missing paths distinctly", () => {
    expect(code(() => resolveWorkspacePath(root, "src/missing.js"))).toBe("not_found");
    expect(resolveWorkspacePath(root, "src/new.js", { mustExist: false }).stat).toBeNull();
  });
});
