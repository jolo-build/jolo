import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { openSession, removeHome, startEngine, tempHome } from "./helpers.js";
import { pathMatchScore, searchWorkspaceFiles, searchWorkspaceText, topLevelMix } from "../../apps/engine/src/search/files.js";
import { resolveToolEnvironment } from "../../apps/engine/src/tools/dispatcher.js";

const engines = [];
const homes = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
  for (const dir of homes.splice(0)) removeHome(dir);
});

/** A repository with ignored files, a hidden file, nested folders and a symlink that points outside it. */
function repository(home) {
  const repo = path.join(home, "repo");
  mkdirSync(path.join(repo, "src", "components"), { recursive: true });
  mkdirSync(path.join(repo, "build"), { recursive: true });
  writeFileSync(path.join(repo, ".gitignore"), "ignored.txt\nbuild/\n");
  writeFileSync(path.join(repo, "README.md"), "# Readme\n");
  writeFileSync(path.join(repo, "src", "app.js"), "export const answer = 42;\n");
  writeFileSync(path.join(repo, "src", "components", "button.jsx"), "export const Button = () => null;\n");
  writeFileSync(path.join(repo, "ignored.txt"), "hidden by gitignore\n");
  writeFileSync(path.join(repo, "build", "out.js"), "ignored folder\n");
  writeFileSync(path.join(home, "outside.txt"), "secret\n");
  symlinkSync(path.join(home, "outside.txt"), path.join(repo, "escape.txt"));
  Bun.spawnSync(["git", "init", "-q", repo]);
  return repo;
}

test("workspace.files offers non-ignored files and folders by fragment, lists one folder, and stays inside the workspace", async () => {
  const home = tempHome(); homes.push(home);
  const repo = repository(home);
  const engine = await startEngine({ home });
  engines.push(engine);
  const client = await engine.connect();
  try {
    const { project } = await openSession(client, repo);
    const workspaceId = project.workspaceId;
    const files = params => client.call("workspace.files", { workspaceId, ...params });

    // Nothing typed: the top level, folders first, with ignored files and folders left out.
    const top = await files({});
    expect(top.source).toBe("git");
    expect(top.entries).toEqual([{ path: "src", kind: "directory" }, { path: ".gitignore", kind: "file" }, { path: "README.md", kind: "file" }]);
    expect(top.truncated).toBe(false);

    // A fragment ranks by fit: the file named like it first, then the folder path that also contains it.
    expect((await files({ query: "app" })).entries[0]).toEqual({ path: "src/app.js", kind: "file" });
    expect((await files({ query: "button" })).entries[0]).toEqual({ path: "src/components/button.jsx", kind: "file" });
    expect((await files({ query: "comp" })).entries[0]).toEqual({ path: "src/components", kind: "directory" });
    expect((await files({ query: "src/bu" })).entries.map(entry => entry.path)).toEqual(["src/components/button.jsx"]);

    // Ignored files, ignored folders and the symlink out of the workspace are never offered.
    expect((await files({ query: "ignored" })).entries).toEqual([]);
    expect((await files({ query: "out" })).entries.map(entry => entry.path)).not.toContain("build/out.js");
    expect((await files({ query: "escape" })).entries).toEqual([]);

    // The result is bounded by the requested limit and says so.
    const bounded = await files({ query: "s", limit: 1 });
    expect(bounded.entries).toHaveLength(1);
    expect(bounded.truncated).toBe(true);
    expect(bounded.total).toBeGreaterThan(1);

    // One folder's top level, names in workspace-relative form, for the message to carry.
    expect(await files({ path: "src" })).toEqual({ entries: [{ path: "src/components", kind: "directory" }, { path: "src/app.js", kind: "file" }], truncated: false, total: 2, source: "listing" });
    const root = await files({ path: ".", limit: 2 });
    expect(root.entries.map(entry => entry.path)).toEqual(["build", "src"]);
    expect(root).toMatchObject({ truncated: true, total: 5 }); // the symlink is neither file nor folder
    await expect(files({ path: "README.md" })).rejects.toMatchObject({ code: "invalid_params" });
    await expect(files({ path: "../" })).rejects.toMatchObject({ code: "permission_denied" });
    await expect(files({ path: ".git" })).rejects.toMatchObject({ code: "permission_denied" });
    await expect(files({ path: "missing" })).rejects.toMatchObject({ code: "not_found" });
    await expect(client.call("workspace.files", { workspaceId: "wsp_missing" })).rejects.toMatchObject({ code: "not_found" });

    // Like file previews, the picker is an interactive client's request.
    const headless = await engine.connect({ clientKind: "headless" });
    await expect(headless.call("workspace.files", { workspaceId, query: "app" })).rejects.toMatchObject({ code: "permission_denied" });
    await headless.close();
  } finally {
    await client.close();
  }
}, 20_000);

test("workspace.searchInFiles finds lines in files that are not ignored, a few per file and up to the limit", async () => {
  const home = tempHome(); homes.push(home);
  const repo = repository(home);
  writeFileSync(path.join(repo, "src", "many.txt"), Array.from({ length: 30 }, (_, index) => `match ${index + 1}`).join("\n") + "\n");
  writeFileSync(path.join(repo, "src", "long.txt"), `match ${"x".repeat(500)}\n`);
  writeFileSync(path.join(repo, ".git", "notes.txt"), "needle in repository metadata\n");
  const engine = await startEngine({ home });
  engines.push(engine);
  const client = await engine.connect();
  try {
    const { project } = await openSession(client, repo);
    const workspaceId = project.workspaceId;
    const search = params => client.call("workspace.searchInFiles", { workspaceId, ...params });
    // Ripgrep when the engine finds it, git grep in a repository otherwise; the answer is the same.
    const source = resolveToolEnvironment(process.env).ripgrep ? "ripgrep" : "git";

    // A literal, workspace-relative path with "/" and a 1-based line number.
    expect(await search({ query: "answer" })).toEqual({ matches: [{ path: "src/app.js", line: 1, text: "export const answer = 42;" }], truncated: false, source });
    expect((await search({ query: "= () =>" })).matches).toEqual([{ path: "src/components/button.jsx", line: 1, text: "export const Button = () => null;" }]);

    // Case is ignored until the query has a capital.
    expect((await search({ query: "button" })).matches.map(match => match.path)).toEqual(["src/components/button.jsx"]);
    expect((await search({ query: "BUTTON" })).matches).toEqual([]);

    // Dotfiles are read; ignored files and folders, repository metadata and the symlink out of the workspace are not.
    expect((await search({ query: "ignored" })).matches).toEqual([{ path: ".gitignore", line: 1, text: "ignored.txt" }]);
    expect((await search({ query: "hidden by" })).matches).toEqual([]);
    expect((await search({ query: "needle" })).matches).toEqual([]);
    expect((await search({ query: "secret" })).matches).toEqual([]);

    // Each file gives at most 20 lines and a long line is clipped; the limit bounds the whole answer and says so.
    const all = await search({ query: "match" });
    expect(all.truncated).toBe(false);
    expect(all.matches.filter(match => match.path === "src/many.txt").map(match => match.line)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    expect(all.matches.find(match => match.path === "src/long.txt")?.text).toHaveLength(200);
    const bounded = await search({ query: "match", limit: 5 });
    expect(bounded.matches).toHaveLength(5);
    expect(bounded.truncated).toBe(true);

    await expect(search({ query: "" })).rejects.toMatchObject({ code: "invalid_params" });
    await expect(search({ query: "two\nlines" })).rejects.toMatchObject({ code: "invalid_params" });
    await expect(client.call("workspace.searchInFiles", { workspaceId: "wsp_missing", query: "answer" })).rejects.toMatchObject({ code: "not_found" });

    // Like the picker, searching in files is an interactive client's request.
    const headless = await engine.connect({ clientKind: "headless" });
    await expect(headless.call("workspace.searchInFiles", { workspaceId, query: "answer" })).rejects.toMatchObject({ code: "permission_denied" });
    await headless.close();
  } finally {
    await client.close();
  }
}, 20_000);

test("searching in files falls back to git grep, needs ripgrep outside a repository, and answers by its deadline", async () => {
  const home = tempHome(); homes.push(home);
  const repo = repository(home);
  const env = resolveToolEnvironment(process.env);
  const search = (options) => searchWorkspaceText({ root: repo, env, signal: AbortSignal.timeout(10_000), query: "answer", limit: 50, ...options });
  expect(await search({ env: { ...env, ripgrep: null } })).toEqual({ matches: [{ path: "src/app.js", line: 1, text: "export const answer = 42;" }], truncated: false, source: "git" });
  const plain = path.join(home, "plain");
  mkdirSync(plain);
  writeFileSync(path.join(plain, "notes.md"), "answer\n");
  await expect(search({ root: plain, env: { ...env, ripgrep: null } })).rejects.toMatchObject({ code: "unavailable", message: "searching in files needs ripgrep" });
  await expect(search({ env: { ...env, ripgrep: null, git: null } })).rejects.toMatchObject({ code: "unavailable", message: "searching in files needs ripgrep" });

  // A search that outlives its deadline hands back what it found so far; one whose client left is cancelled.
  const slow = path.join(home, "slow-rg");
  writeFileSync(`${slow}.out`, "./src/app.js\u00001:export const answer = 42;\n");
  writeFileSync(slow, '#!/bin/sh\ncat "$0.out"\nexec sleep 10\n');
  chmodSync(slow, 0o755);
  const started = Date.now();
  // The deadline leaves room for macOS to vet a script it has never run before.
  expect(await search({ env: { ...env, ripgrep: slow }, timeoutMs: 1500 })).toEqual({ matches: [{ path: "src/app.js", line: 1, text: "export const answer = 42;" }], truncated: true, source: "ripgrep" });
  expect(Date.now() - started).toBeLessThan(5000);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  await expect(search({ env: { ...env, ripgrep: slow }, signal: controller.signal })).rejects.toMatchObject({ code: "interrupted" });
});

test("a folder that is not a repository is still listed, without repository metadata or dependencies", async () => {
  const home = tempHome(); homes.push(home);
  const folder = path.join(home, "plain");
  mkdirSync(path.join(folder, "node_modules", "dep"), { recursive: true });
  mkdirSync(path.join(folder, "notes"), { recursive: true });
  writeFileSync(path.join(folder, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
  writeFileSync(path.join(folder, "notes", "today.md"), "- plan\n");
  writeFileSync(path.join(folder, "todo.txt"), "later\n");
  const engine = await startEngine({ home, env: { JOLO_RIPGREP: "" } });
  engines.push(engine);
  const client = await engine.connect();
  try {
    const { project } = await openSession(client, folder);
    const listed = await client.call("workspace.files", { workspaceId: project.workspaceId, query: "" });
    expect(listed.source).toBe("builtin");
    expect(listed.entries).toEqual([{ path: "notes", kind: "directory" }, { path: "todo.txt", kind: "file" }]);
    expect((await client.call("workspace.files", { workspaceId: project.workspaceId, query: "index" })).entries).toEqual([]);
  } finally {
    await client.close();
  }
}, 20_000);

test("nothing typed shows top-level folders and files in equal measure, even when folders outnumber the rows", async () => {
  const home = tempHome(); homes.push(home);
  const root = path.join(home, "wide");
  // A folder is known by the files in it, so each gets one; an empty folder is nothing git or ripgrep would list.
  for (let index = 0; index < 10; index++) { const folder = path.join(root, `folder-${String(index).padStart(2, "0")}`); mkdirSync(folder, { recursive: true }); writeFileSync(path.join(folder, "index.js"), "x\n"); }
  for (const name of ["a.md", "b.md", "c.md"]) writeFileSync(path.join(root, name), "x\n");
  Bun.spawnSync(["git", "init", "-q", root]);
  const listed = await searchWorkspaceFiles({ root, env: resolveToolEnvironment(process.env), signal: AbortSignal.timeout(10_000), query: "", limit: 8 });
  const kinds = listed.entries.map(entry => entry.kind);
  expect(kinds.filter(kind => kind === "file")).toHaveLength(3);
  expect(kinds.filter(kind => kind === "directory")).toHaveLength(5);
  expect(listed.entries.slice(0, 5).map(entry => entry.path)).toEqual(["folder-00", "folder-01", "folder-02", "folder-03", "folder-04"]);
  expect(listed.entries.slice(5).map(entry => entry.path)).toEqual(["a.md", "b.md", "c.md"]);
  expect(listed).toMatchObject({ truncated: true, total: 13 });
  // The split itself: half and half when both groups are long; the short group gives its rows to the other.
  const folder = name => ({ path: name, kind: /** @type {const} */ ("directory") });
  const file = name => ({ path: name, kind: /** @type {const} */ ("file") });
  const wide = [...Array.from({ length: 6 }, (_, index) => folder(`d${index}`)), ...Array.from({ length: 6 }, (_, index) => file(`f${index}`)), file("nested/not-top")];
  expect(topLevelMix(wide, 8).slice(0, 8).map(entry => entry.path)).toEqual(["d0", "d1", "d2", "d3", "f0", "f1", "f2", "f3"]);
  expect(topLevelMix(wide, 8).map(entry => entry.path)).toEqual(["d0", "d1", "d2", "d3", "f0", "f1", "f2", "f3", "d4", "d5", "f4", "f5"]);
  expect(topLevelMix([folder("only"), ...Array.from({ length: 9 }, (_, index) => file(`f${index}`))], 8).map(entry => entry.path)).toEqual(["only", "f0", "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8"]);
  expect(topLevelMix([...Array.from({ length: 9 }, (_, index) => folder(`d${index}`)), file("one")], 8).slice(0, 8).map(entry => entry.path)).toEqual(["d0", "d1", "d2", "d3", "d4", "d5", "d6", "one"]);
});

test("ranking prefers the file's own name, contiguous runs and shorter paths", () => {
  const better = (query, a, b) => expect(pathMatchScore(query, a)).toBeGreaterThan(/** @type {number} */ (pathMatchScore(query, b)));
  better("app", "src/app.js", "src/application/parts.js");
  better("app", "src/app.js", "deep/nested/folder/app.js");
  better("sidebar", "src/components/sidebar.jsx", "src/side/bar/index.jsx");
  better("src app", "src/app.js", "src/other/app.js");
  expect(pathMatchScore("zzz", "src/app.js")).toBeNull();
  expect(pathMatchScore("", "src/app.js")).toBe(0);
});
