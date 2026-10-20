import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { startEngine, tempHome, waitFor, removeHome } from "./helpers.js";

const engines = [];
const homes = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
  for (const dir of homes.splice(0)) removeHome(dir);
});

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (cwd, ...args) => Bun.spawnSync(["git", ...args], { cwd, env: GIT_ENV });
function gitRepo(home, name) {
  const repo = path.join(home, name);
  mkdirSync(repo, { recursive: true });
  writeFileSync(path.join(repo, "notes.txt"), "alpha\n");
  git(repo, "init", "-q", "-b", "main"); git(repo, "add", "."); git(repo, "commit", "-q", "-m", "init");
  return repo;
}

async function boot(home, options = {}) {
  const engine = await startEngine({ home, fakeSteps: 100, fakeDelayMs: 50, ...options });
  engines.push(engine);
  const client = await engine.connect();
  const events = [];
  const status = await client.call("engine.status", {});
  await client.subscribe({ after: status.cursor }, { onEvent: (event) => events.push(event) });
  return { engine, client, events };
}
const rowsFor = async (client, projectId) => (await client.call("board.list", {})).projects.filter((row) => row.projectId === projectId);

describe("project.remove", () => {
  test("archives the folder's chats, leaves its worktree on disk, and brings both back when the folder is opened again", async () => {
    const home = tempHome(); homes.push(home);
    const repo = gitRepo(home, "repo");
    const { client, events } = await boot(home);
    const opened = await client.call("project.open", { path: repo });
    const first = (await client.call("session.create", { projectId: opened.projectId, workspaceId: opened.workspaceId, title: "First chat" })).session;
    const { workspace } = await client.call("workspace.create", { projectId: opened.projectId, branch: "feat/kept" });
    const second = (await client.call("session.create", { projectId: opened.projectId, workspaceId: workspace.id, title: "Worktree chat" })).session;
    const other = await client.call("project.open", { path: home }); // another folder, untouched by the removal
    expect((await rowsFor(client, opened.projectId)).map((row) => row.workspace.mode)).toEqual(["direct", "worktree"]);

    const removed = await client.call("project.remove", { projectId: opened.projectId });
    expect(removed).toEqual({ projectId: opened.projectId, archived: 2 });
    expect(await rowsFor(client, opened.projectId)).toEqual([]);
    expect((await rowsFor(client, other.projectId))).toHaveLength(1);
    for (const session of [first, second]) {
      expect((await client.call("session.page", { sessionId: session.id })).session.state).toBe("archived");
      expect(events.some((e) => e.type === "session.updated" && e.payload.session.id === session.id && e.payload.session.state === "archived")).toBe(true);
    }
    expect((await client.call("session.list", { projectId: opened.projectId })).sessions).toHaveLength(0);
    expect((await client.call("session.list", { projectId: opened.projectId, state: "archived" })).sessions.map((s) => s.title).sort()).toEqual(["First chat", "Worktree chat"]);
    expect(existsSync(path.join(workspace.path, "notes.txt"))).toBe(true); // the worktree stays on disk
    expect((await client.call("workspace.list", { projectId: opened.projectId })).workspaces.map((w) => [w.mode, w.present])).toEqual([["direct", true], ["worktree", true]]);
    expect(events.some((e) => e.type === "workspace.removed")).toBe(false);

    // Removing a folder that is already gone changes nothing and is not an error.
    expect(await client.call("project.remove", { projectId: opened.projectId })).toEqual({ projectId: opened.projectId, archived: 0 });
    await expect(client.call("project.remove", { projectId: "prj_missing" })).rejects.toMatchObject({ code: "not_found" });

    // Opening the same folder again finds the same project, its worktree and its archived chats.
    const reopened = await client.call("project.open", { path: repo });
    expect(reopened.projectId).toBe(opened.projectId);
    expect((await rowsFor(client, opened.projectId)).map((row) => row.workspace.id).sort()).toEqual([opened.workspaceId, workspace.id].sort());
    const archived = (await client.call("session.list", { projectId: opened.projectId, state: "archived" })).sessions;
    expect(archived.map((s) => s.title).sort()).toEqual(["First chat", "Worktree chat"]);
    const restored = (await client.call("session.archive", { sessionId: first.id, expectedRevision: archived.find((s) => s.id === first.id).revision, archived: false })).session;
    expect(restored.state).toBe("open");
  }, 40_000);

  test("refuses while a task is still running, naming it, and is for interactive clients only", async () => {
    const home = tempHome(); homes.push(home);
    const { client, events } = await boot(home);
    const opened = await client.call("project.open", { path: home });
    const session = (await client.call("session.create", { projectId: opened.projectId, workspaceId: opened.workspaceId, title: "Long task" })).session;
    const { run } = await client.call("run.start", { sessionId: session.id, requestId: "req_long", prompt: "keep going" });
    await expect(client.call("project.remove", { projectId: opened.projectId })).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("Long task"), details: { runId: run.id, sessionId: session.id } });
    expect((await client.call("session.page", { sessionId: session.id })).session.state).toBe("open");
    expect(await rowsFor(client, opened.projectId)).toHaveLength(1);

    await client.call("run.cancel", { runId: run.id });
    await waitFor(() => events.some((e) => e.type === "run.state" && e.runId === run.id && e.payload.state === "cancelled"), { label: "run cancelled", timeoutMs: 15_000 });
    const headless = await engines[0].connect({ clientKind: "headless" });
    await expect(headless.call("project.remove", { projectId: opened.projectId })).rejects.toMatchObject({ code: "permission_denied" });
    await headless.close();
    expect(await client.call("project.remove", { projectId: opened.projectId })).toEqual({ projectId: opened.projectId, archived: 1 });
    expect(await rowsFor(client, opened.projectId)).toEqual([]);
  }, 40_000);
});
