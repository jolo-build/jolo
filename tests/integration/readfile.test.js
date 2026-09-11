import { afterEach, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { openSession, removeHome, startEngine, tempHome } from "./helpers.js";

const engines = [];
const homes = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
  for (const dir of homes.splice(0)) removeHome(dir);
});

test("workspace.readFile previews files under the path policy with bounds, and only for interactive clients", async () => {
  const home = tempHome(); homes.push(home);
  const repo = path.join(home, "repo");
  mkdirSync(path.join(repo, "docs"), { recursive: true });
  writeFileSync(path.join(repo, "docs", "guide.md"), "# Guide\n\nSome **bold** text.\n");
  writeFileSync(path.join(repo, "blob.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  writeFileSync(path.join(repo, "big.md"), "x".repeat(4096));
  symlinkSync("/etc", path.join(repo, "escape"));
  const engine = await startEngine({ home });
  engines.push(engine);
  const client = await engine.connect();
  try {
    const { project } = await openSession(client, repo);
    const workspaceId = project.workspaceId;
    expect(await client.call("workspace.readFile", { workspaceId, path: "docs/guide.md" })).toEqual({ path: "docs/guide.md", text: "# Guide\n\nSome **bold** text.\n", bytes: 29, truncated: false, binary: false });
    const clipped = await client.call("workspace.readFile", { workspaceId, path: "big.md", maxBytes: 1024 });
    expect(clipped).toMatchObject({ bytes: 1024, truncated: true, binary: false });
    expect(clipped.text).toHaveLength(1024);
    const unicode = Buffer.from('x'.repeat(49151) + '🌍' + 'y'.repeat(100000));
    writeFileSync(path.join(repo, 'preview.html'), unicode);
    const chunks = [];
    let offset = 0;
    for (;;) {
      const part = await client.call('workspace.readFile', { workspaceId, path: 'preview.html', offset, maxBytes: 49152, encoding: 'base64' });
      chunks.push(Buffer.from(part.text, 'base64')); offset += part.bytes;
      if (!part.truncated) break;
    }
    expect(Buffer.concat(chunks)).toEqual(unicode);
    expect(await client.call('workspace.readFile', { workspaceId, path: 'preview.html', offset: unicode.length + 1, encoding: 'base64' })).toMatchObject({ text: '', bytes: 0, truncated: false });
    expect(await client.call("workspace.readFile", { workspaceId, path: "blob.bin" })).toMatchObject({ binary: true, text: "", bytes: 6 });
    await expect(client.call("workspace.readFile", { workspaceId, path: "missing.md" })).rejects.toMatchObject({ code: "not_found" });
    await expect(client.call("workspace.readFile", { workspaceId, path: "../secret.md" })).rejects.toMatchObject({ code: "permission_denied" });
    await expect(client.call("workspace.readFile", { workspaceId, path: "escape/passwd" })).rejects.toMatchObject({ code: "permission_denied" });
    await expect(client.call("workspace.readFile", { workspaceId, path: ".git/config" })).rejects.toMatchObject({ code: "permission_denied" });
    await expect(client.call("workspace.readFile", { workspaceId, path: "docs" })).rejects.toMatchObject({ code: "invalid_params" });
    await expect(client.call("workspace.readFile", { workspaceId: "wsp_missing", path: "docs/guide.md" })).rejects.toMatchObject({ code: "not_found" });
    const headless = await engine.connect({ clientKind: "headless" });
    await expect(headless.call("workspace.readFile", { workspaceId, path: "docs/guide.md" })).rejects.toMatchObject({ code: "permission_denied" });
    await headless.close();
  } finally {
    await client.close();
  }
}, 15_000);
