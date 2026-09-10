import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { CLI_ENTRY, startEngine, tempHome, waitFor, removeHome } from "./helpers.js";

const engines = [];
const homes = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
  for (const dir of homes.splice(0)) removeHome(dir);
});

const NOTES = "alpha\nbeta\n";
const sha = (text) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const SCRIPT = [
  { toolCalls: [{ name: "list_files", arguments: {} }, { name: "replace_exact", arguments: { path: "notes.txt", expectedHash: sha(NOTES), oldText: "beta", newText: "gamma" } }] },
  { toolCalls: [{ name: "run_command", arguments: { argv: ["echo", "ok"] } }] },
  { text: ["Changed the notes.\n"] },
];
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (cwd, ...args) => { const r = Bun.spawnSync(["git", ...args], { cwd, env: GIT_ENV }); return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() }; };

function gitRepo(home, name) {
  const repo = path.join(home, name);
  mkdirSync(repo, { recursive: true });
  writeFileSync(path.join(repo, "notes.txt"), NOTES);
  git(repo, "init", "-q", "-b", "main"); git(repo, "add", "."); git(repo, "commit", "-q", "-m", "init");
  return repo;
}

async function boot(home, { clientKind = "test" } = {}) {
  const scriptPath = path.join(home, "script.json");
  writeFileSync(scriptPath, JSON.stringify(SCRIPT));
  const engine = await startEngine({ home, env: { JOLO_FAKE_SCRIPT: scriptPath } });
  engines.push(engine);
  const client = await engine.connect({ clientKind });
  const events = [];
  const status = await client.call("engine.status", {});
  await client.subscribe({ after: status.cursor }, { onEvent: (e) => events.push(e) });
  const runTo = async (session, requestId, prompt, target) => {
    const { run } = await client.call("run.start", { sessionId: session.id, requestId, prompt });
    await waitFor(() => events.some((e) => e.type === "run.state" && e.runId === run.id && e.payload.state === target), { label: `${requestId} ${target}`, timeoutMs: 15_000 });
    return run;
  };
  const approve = async (run) => {
    const request = await waitFor(() => events.find((e) => e.type === "permission.requested" && e.runId === run.id), { label: "permission" });
    await client.call("permission.resolve", { permissionId: request.payload.permissionId, decision: "allow_run" });
    await waitFor(() => events.some((e) => e.type === "run.state" && e.runId === run.id && e.payload.state === "completed"), { label: "completed", timeoutMs: 15_000 });
  };
  return { engine, client, events, runTo, approve };
}

describe("worktree workspaces", () => {
  test("a task in a worktree edits its own checkout on a new branch from the recorded base", async () => {
    const home = tempHome(); homes.push(home);
    const repo = gitRepo(home, "repo");
    const { client, events, runTo, approve } = await boot(home);
    const opened = await client.call("project.open", { path: repo });
    expect(opened.preferredMode).toBe("direct");

    const { workspace } = await client.call("workspace.create", { projectId: opened.projectId, title: "Rate limit API" });
    expect(workspace).toMatchObject({ mode: "worktree", owned: true, branch: "jolo/rate-limit-api", projectId: opened.projectId, removedAt: null });
    expect(workspace.path).toContain(path.join("data", "t", "worktrees"));
    expect(existsSync(path.join(workspace.path, "notes.txt"))).toBe(true);
    expect(git(repo, "worktree", "list").stdout).toContain("[jolo/rate-limit-api]");
    expect(git(repo, "rev-parse", "HEAD").stdout.trim()).toBe(workspace.baseCommit);
    expect(events.some((e) => e.type === "workspace.created" && e.payload.workspace.id === workspace.id)).toBe(true);
    const listed = (await client.call("workspace.list", { projectId: opened.projectId })).workspaces;
    expect(listed.map((w) => [w.mode, w.present, w.sessionCount])).toEqual([["direct", true, 0], ["worktree", true, 0]]);
    expect((await client.call("project.open", { path: repo })).preferredMode).toBe("worktree");

    const session = (await client.call("session.create", { projectId: opened.projectId, workspaceId: workspace.id, title: "Rate limit API" })).session;
    const run = await runTo(session, "req_wt", "change the notes", "awaiting_permission");
    await approve(run);
    expect(readFileSync(path.join(workspace.path, "notes.txt"), "utf8")).toBe("alpha\ngamma\n");
    expect(readFileSync(path.join(repo, "notes.txt"), "utf8")).toBe(NOTES); // the main checkout is untouched
    const toolOutput = (await Promise.all((await client.call("run.snapshot", { runId: run.id })).messages.filter((m) => m.kind === "tool").map(async (m) => (await client.call("artifact.read", { artifactId: m.artifactId })).text))).join("\n");
    expect(toolOutput).toContain("notes.txt");
    expect(toolOutput).not.toContain(".git");

    let rows = (await client.call("board.list", {})).projects.filter((row) => row.name === "repo");
    expect(rows).toHaveLength(2);
    const worktreeRow = rows.find((row) => row.workspace.mode === "worktree");
    expect(worktreeRow).toMatchObject({ attention: "done", reason: "completed", changedFiles: 1, git: { branch: "jolo/rate-limit-api", dirty: 1 }, workspace: { id: workspace.id, branch: "jolo/rate-limit-api" } });
    expect(rows.find((row) => row.workspace.mode === "direct")).toMatchObject({ attention: "idle", run: null, git: { branch: "main", dirty: 0 } });

    const second = (await client.call("workspace.create", { projectId: opened.projectId, title: "Rate limit API" })).workspace;
    expect(second.branch).toBe("jolo/rate-limit-api-2");
    await expect(client.call("workspace.create", { projectId: opened.projectId, branch: "jolo/rate-limit-api" })).rejects.toMatchObject({ code: "conflict" });
    await expect(client.call("workspace.create", { projectId: opened.projectId, branch: "bad name" })).rejects.toMatchObject({ code: "invalid_params" });
    await expect(client.call("workspace.create", { projectId: opened.projectId, base: "no-such-ref" })).rejects.toMatchObject({ code: "invalid_params" });

    await expect(client.call("workspace.remove", { workspaceId: opened.workspaceId })).rejects.toMatchObject({ code: "permission_denied" });
    await expect(client.call("workspace.remove", { workspaceId: workspace.id })).rejects.toMatchObject({ code: "conflict" }); // uncommitted edit
    const removed = await client.call("workspace.remove", { workspaceId: workspace.id, force: true });
    expect(removed).toMatchObject({ workspaceId: workspace.id, branch: "jolo/rate-limit-api" });
    expect(existsSync(workspace.path)).toBe(false);
    expect(git(repo, "branch", "--list", "jolo/rate-limit-api").stdout).toContain("jolo/rate-limit-api"); // the branch stays
    expect(events.some((e) => e.type === "workspace.removed" && e.payload.workspaceId === workspace.id)).toBe(true);
    rows = (await client.call("board.list", {})).projects.filter((row) => row.name === "repo");
    expect(rows.map((row) => row.workspace.mode)).toEqual(["direct"]);
    await expect(client.call("run.start", { sessionId: session.id, requestId: "req_gone", prompt: "again" })).rejects.toMatchObject({ code: "conflict" });
    await expect(client.call("workspace.remove", { workspaceId: workspace.id, force: true })).rejects.toMatchObject({ code: "not_found" });
    await client.call("workspace.remove", { workspaceId: second.id }); // clean: no force needed
    expect(existsSync(second.path)).toBe(false);

    const plain = path.join(home, "plain");
    mkdirSync(plain); writeFileSync(path.join(plain, "a.txt"), "a\n");
    const plainProject = await client.call("project.open", { path: plain });
    await expect(client.call("workspace.create", { projectId: plainProject.projectId })).rejects.toMatchObject({ code: "unavailable" });
  }, 40_000);

  test("parallel tasks stay visible on the board, and removal waits for runs but closes terminals", async () => {
    const home = tempHome(); homes.push(home);
    const repo = gitRepo(home, "repo");
    const { client, events, runTo } = await boot(home);
    const opened = await client.call("project.open", { path: repo });
    const main = (await client.call("session.create", { projectId: opened.projectId, workspaceId: opened.workspaceId, title: "main task" })).session;
    const { workspace } = await client.call("workspace.create", { projectId: opened.projectId, branch: "feat/parallel" });
    const side = (await client.call("session.create", { projectId: opened.projectId, workspaceId: workspace.id, title: "side task" })).session;
    const mainRun = await runTo(main, "req_main", "main change", "awaiting_permission");
    const { run: sideRun } = await client.call("run.start", { sessionId: side.id, requestId: "req_side", prompt: "side change" });
    await waitFor(() => events.some(e => e.runId === sideRun.id && e.type === "run.state" && e.payload.state === "awaiting_permission"), { label: "independent worktree starts without waiting for main" });
    const rows = (await client.call("board.list", {})).projects.filter((row) => row.name === "repo");
    expect(rows.map(row => [row.workspace.mode, row.attention, row.reason]).sort()).toEqual([["direct", "needs_you", "awaiting_permission"], ["worktree", "needs_you", "awaiting_permission"]]);

    await expect(client.call("workspace.remove", { workspaceId: workspace.id, force: true })).rejects.toMatchObject({ code: "conflict" }); // queued run
    await client.call("run.cancel", { runId: sideRun.id });
    await client.call("run.cancel", { runId: mainRun.id });
    await waitFor(() => events.some((e) => e.type === "run.state" && e.runId === mainRun.id && e.payload.state === "cancelled"), { label: "main cancelled" });
    const { terminal } = await client.call("terminal.open", { workspaceId: workspace.id });
    await client.call("workspace.remove", { workspaceId: workspace.id, force: true });
    expect((await client.call("terminal.list", {})).terminals.some((t) => t.terminalId === terminal.terminalId)).toBe(false);
    expect(events.some((e) => e.type === "terminal.closed" && e.payload.terminalId === terminal.terminalId)).toBe(true);
    expect(existsSync(workspace.path)).toBe(false);
  }, 40_000);

  test("jolo run --worktree, jolo worktree list|remove, and jolo board repo@branch", async () => {
    const home = tempHome(); homes.push(home);
    const repo = gitRepo(home, "repo");
    const { client } = await boot(home, { clientKind: "headless" }); // no interactive client: the CLI run pauses instead of waiting
    const jolo = async (...args) => {
      const proc = Bun.spawn([process.execPath, CLI_ENTRY, ...args, "--home", home, "--profile", "t"], { stdout: "pipe", stderr: "pipe", env: { ...process.env } });
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { stdout, stderr, code, lines: stdout.split("\n").filter(Boolean) };
    };
    const run = await jolo("run", "change the notes", "--worktree", "--branch", "feat/cli", "--path", repo, "--json");
    expect(run.code).toBe(3); // paused for permission, headless
    const records = run.lines.map((line) => JSON.parse(line));
    const created = records.find((r) => r.type === "workspace.created");
    expect(created.workspace).toMatchObject({ mode: "worktree", branch: "feat/cli" });
    expect(readFileSync(path.join(created.workspace.path, "notes.txt"), "utf8")).toBe("alpha\ngamma\n");
    const list = await jolo("worktree", "list", "--path", repo, "--json");
    expect(list.code).toBe(0);
    expect(JSON.parse(list.stdout).workspaces.map((w) => w.branch)).toEqual([null, "feat/cli"]);
    const table = await jolo("worktree", "list", "--path", repo);
    expect(table.stdout).toContain("feat/cli");
    const board = await jolo("board", "repo@feat/cli");
    expect(board.code).toBe(0);
    expect(board.stdout).toContain("feat/cli");
    expect(board.stdout).toContain("needs approval");
    const busy = await jolo("worktree", "remove", "feat/cli", "--path", repo, "--force");
    expect(busy.code).toBe(1);
    expect(busy.stderr).toContain("still running");
    const paused = records.find((r) => r.type === "run.paused");
    await client.call("run.cancel", { runId: paused.runId });
    const removed = await jolo("worktree", "remove", "feat/cli", "--path", repo, "--force");
    expect(removed.code).toBe(0);
    expect(existsSync(created.workspace.path)).toBe(false);
  }, 40_000);
});

describe("checkouts left behind by an interrupted start", () => {
  test("a worktree the engine made but never handed over is taken back at the next boot, unless work landed on it", async () => {
    const home = tempHome(); homes.push(home);
    const repo = gitRepo(home, "repo");
    const dataDir = path.join(home, "data", "t");
    const pending = path.join(dataDir, "worktrees", "pending");
    mkdirSync(pending, { recursive: true });
    const baseCommit = git(repo, "rev-parse", "HEAD").stdout.trim();

    // Two checkouts that no database row names: one untouched, one that somebody committed to.
    const stranded = path.join(dataDir, "worktrees", "stranded");
    const written = path.join(dataDir, "worktrees", "written");
    expect(git(repo, "worktree", "add", "-b", "jolo/stranded", stranded, baseCommit).code).toBe(0);
    expect(git(repo, "worktree", "add", "-b", "jolo/written", written, baseCommit).code).toBe(0);
    writeFileSync(path.join(written, "notes.txt"), "work someone would lose\n");
    git(written, "add", "."); git(written, "commit", "-q", "-m", "later work");
    for (const [name, dir, branch] of [["a", stranded, "jolo/stranded"], ["b", written, "jolo/written"]]) {
      writeFileSync(path.join(pending, `${name}.json`), JSON.stringify({ projectId: "prj_x", root: repo, branch, dir, baseCommit, at: new Date().toISOString() }));
    }

    const { client } = await boot(home);
    await client.call("engine.status", {}); // the engine is up, so reconciliation has already run

    expect(existsSync(stranded)).toBe(false); // nobody ever saw it; it is gone, branch and all
    expect(git(repo, "rev-parse", "--verify", "--quiet", "refs/heads/jolo/stranded").code).not.toBe(0);
    expect(existsSync(written)).toBe(true); // the branch moved, so the outcome is the user's to judge
    expect(git(repo, "rev-parse", "--verify", "--quiet", "refs/heads/jolo/written").code).toBe(0);
    expect(readFileSync(path.join(written, "notes.txt"), "utf8")).toBe("work someone would lose\n");
    expect(existsSync(path.join(pending, "a.json"))).toBe(false); // the settled one is off the books
  }, 40_000);

  test("a worktree the user was given survives the next boot untouched", async () => {
    const home = tempHome(); homes.push(home);
    const repo = gitRepo(home, "repo");
    const { client, engine } = await boot(home);
    const project = await client.call("project.open", { path: repo });
    const { workspace } = await client.call("workspace.create", { projectId: project.projectId, title: "keep me" });
    expect(existsSync(workspace.path)).toBe(true);
    const pending = path.join(home, "data", "t", "worktrees", "pending");
    expect(existsSync(pending) ? readdirSync(pending) : []).toEqual([]); // nothing left to reconcile

    await engine.stop();
    engines.splice(engines.indexOf(engine), 1);
    const again = await boot(home);
    const workspaces = (await again.client.call("workspace.list", { projectId: project.projectId })).workspaces;
    expect(workspaces.some((entry) => entry.id === workspace.id && entry.present)).toBe(true);
    expect(existsSync(workspace.path)).toBe(true);
  }, 40_000);
});
