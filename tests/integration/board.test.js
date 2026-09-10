import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
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
  { toolCalls: [{ name: "replace_exact", arguments: { path: "notes.txt", expectedHash: sha(NOTES), oldText: "beta", newText: "gamma" } }] },
  { toolCalls: [{ name: "run_command", arguments: { argv: ["echo", "ok"] } }] },
  { text: ["All done. Notes updated.\n\nDetails follow.\n"] },
];

function fixture(home, name, { git = false, branch = "main" } = {}) {
  const repo = path.join(home, name);
  mkdirSync(repo, { recursive: true });
  writeFileSync(path.join(repo, "notes.txt"), NOTES);
  if (git) {
    const run = (...args) => Bun.spawnSync(["git", ...args], { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });
    run("init", "-q", "-b", branch); run("add", "."); run("commit", "-q", "-m", "init");
  }
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
  return { engine, client, events };
}

const rowFor = (board, name) => board.projects.find((row) => row.name === name);

describe("what a board row speaks for", () => {
  test("a task still waiting on the user is not hidden by a newer one behind it", async () => {
    const home = tempHome(); homes.push(home);
    const repo = fixture(home, "repo");
    const { client, events } = await boot(home);
    const project = await client.call("project.open", { path: repo });
    const first = (await client.call("session.create", { projectId: project.projectId, workspaceId: project.workspaceId, title: "waiting task" })).session;
    const second = (await client.call("session.create", { projectId: project.projectId, workspaceId: project.workspaceId, title: "task behind it" })).session;

    const { run: waiting } = await client.call("run.start", { sessionId: first.id, requestId: "r1", prompt: "edit then run" });
    await waitFor(() => events.some((e) => e.type === "permission.requested" && e.runId === waiting.id), { label: "the first task asked" });
    const { run: behind } = await client.call("run.start", { sessionId: second.id, requestId: "r2", prompt: "queued behind it" });
    expect((await client.call("run.snapshot", { runId: behind.id })).run.state).toBe("queued"); // newer, and going nowhere

    const rows = (await client.call("board.list", {})).projects.filter((row) => row.workspaceId === project.workspaceId);
    expect(rows).toHaveLength(1);
    expect(rows[0].attention).toBe("needs_you");
    expect(rows[0].reason).toBe("awaiting_permission");
    expect(rows[0].session.id).toBe(first.id); // the row speaks for the task that cannot move
    expect(rows[0].run.id).toBe(waiting.id);
  }, 40_000);

  test("continuing a paused task records a new attempt", async () => {
    const home = tempHome(); homes.push(home);
    const repo = fixture(home, "repo");
    const { client, events } = await boot(home);
    const project = await client.call("project.open", { path: repo });
    const { session } = await client.call("session.create", { projectId: project.projectId, workspaceId: project.workspaceId, title: "declined then continued" });
    const { run } = await client.call("run.start", { sessionId: session.id, requestId: "r1", prompt: "edit then run" });
    expect(run.attempt).toBe(1);
    const asked = await waitFor(() => events.find((e) => e.type === "permission.requested" && e.runId === run.id), { label: "asked" });
    await client.call("permission.resolve", { permissionId: asked.payload.permissionId, decision: "deny" });
    await waitFor(() => events.some((e) => e.type === "run.state" && e.runId === run.id && e.payload.state === "paused"), { label: "paused" });

    const resumed = await client.call("run.resume", { runId: run.id });
    expect(resumed.run.attempt).toBe(2);
    const queued = events.filter((e) => e.type === "run.state" && e.runId === run.id && e.payload.state === "queued").at(-1);
    expect(queued.payload.attempt).toBe(2);
  }, 40_000);
});

describe("work board", () => {
  test("rows follow run state, carry notes and pending requests, and clear once looked at", async () => {
    const home = tempHome(); homes.push(home);
    const alpha = fixture(home, "alpha", { git: true, branch: "feat/rate-limit" });
    const beta = fixture(home, "beta");
    const { client, events } = await boot(home);
    const openAlpha = await client.call("project.open", { path: alpha });
    const openBeta = await client.call("project.open", { path: beta });

    let board = await client.call("board.list", {});
    expect(board.projects.map((row) => row.attention)).toEqual(["idle", "idle"]);
    expect(rowFor(board, "alpha")).toMatchObject({ summary: "No task yet.", nextStep: null, run: null, changedFiles: 0, git: { branch: "feat/rate-limit", dirty: 0 }, workspace: { mode: "direct", branch: null } });
    expect(rowFor(board, "beta").git).toEqual({ branch: null, dirty: null });

    // beta: approve its command so the run finishes; the note and verification land on the row.
    const betaSession = (await client.call("session.create", { projectId: openBeta.projectId, workspaceId: openBeta.workspaceId, title: "Update the notes" })).session;
    const betaRun = (await client.call("run.start", { sessionId: betaSession.id, requestId: "req_beta", prompt: "Replace beta with gamma in the notes" })).run;
    const betaPermission = await waitFor(() => events.find((e) => e.type === "permission.requested" && e.runId === betaRun.id), { label: "beta permission" });
    await client.call("permission.resolve", { permissionId: betaPermission.payload.permissionId, decision: "allow_run" });
    await waitFor(() => events.some((e) => e.type === "run.state" && e.runId === betaRun.id && e.payload.state === "completed"), { label: "beta completed", timeoutMs: 15_000 });

    board = await client.call("board.list", {});
    let row = rowFor(board, "beta");
    expect(row).toMatchObject({ attention: "done", reason: "completed", changedFiles: 1, session: { id: betaSession.id, title: "Update the notes" } });
    expect(row.run).toMatchObject({ id: betaRun.id, state: "completed", prompt: "Replace beta with gamma in the notes", verification: { status: "passed" } });
    expect(row.run.note).toMatchObject({ outcome: "completed", summary: "All done. Notes updated." });
    expect(row.summary).toBe("All done. Notes updated.");
    expect(row.nextStep).toContain("the changed file");
    expect(row.actions.map((a) => [a.name, a.status])).toEqual([["replace_exact", "ok"], ["run_command", "ok"]]);
    expect(row.git).toEqual({ branch: null, dirty: null });
    expect(row.lastActivityAt).toBeString();
    expect((await client.call("run.snapshot", { runId: betaRun.id })).run.note.summary).toBe("All done. Notes updated.");

    const viewed = await client.call("board.viewed", { workspaceId: openBeta.workspaceId });
    expect(viewed.lastViewedAt).toBeString();
    await waitFor(() => events.some((e) => e.type === "workspace.viewed" && e.payload.workspaceId === openBeta.workspaceId), { label: "viewed event" });
    board = await client.call("board.list", {});
    expect(rowFor(board, "beta")).toMatchObject({ attention: "idle", reason: "completed", lastViewedAt: viewed.lastViewedAt });

    // alpha: leave its command unanswered; the row asks for the user and sorts first.
    const alphaSession = (await client.call("session.create", { projectId: openAlpha.projectId, workspaceId: openAlpha.workspaceId, title: "Notes in alpha" })).session;
    const alphaRun = (await client.call("run.start", { sessionId: alphaSession.id, requestId: "req_alpha", prompt: "Same change in alpha" })).run;
    await waitFor(() => events.some((e) => e.type === "run.state" && e.runId === alphaRun.id && e.payload.state === "awaiting_permission"), { label: "alpha awaiting permission" });
    board = await client.call("board.list", {});
    expect(board.projects.map((r) => r.name)).toEqual(["alpha", "beta"]);
    row = rowFor(board, "alpha");
    expect(row).toMatchObject({ attention: "needs_you", reason: "awaiting_permission", changedFiles: 1, git: { branch: "feat/rate-limit", dirty: 1 } });
    expect(row.pendingPermission).toMatchObject({ tool: "run_command", argv: ["echo", "ok"] });
    expect(row.summary).toStartWith("Waiting for your approval");
    expect(row.nextStep).toContain("Approve or deny");
    expect(row.run.note).toBeNull();

    await client.call("permission.resolve", { permissionId: row.pendingPermission.permissionId, decision: "deny" });
    await waitFor(() => events.some((e) => e.type === "run.state" && e.runId === alphaRun.id && e.payload.state === "paused"), { label: "alpha paused" });
    board = await client.call("board.list", {});
    row = rowFor(board, "alpha");
    expect(row).toMatchObject({ attention: "needs_you", reason: "paused_user", pendingPermission: null });
    expect(row.summary).toContain("declined");
    expect(row.nextStep).toContain("Resume");

    await client.call("run.cancel", { runId: alphaRun.id });
    board = await client.call("board.list", {});
    row = rowFor(board, "alpha");
    expect(row).toMatchObject({ attention: "done", reason: "cancelled" });
    expect(row.summary).toBe("Stopped by you after changing 1 file.");
    await expect(client.call("board.viewed", { workspaceId: "wsp_missing" })).rejects.toMatchObject({ code: "not_found" });
  }, 30_000);

  test("a run cut off by an engine crash comes back as needs-you with an interrupted note", async () => {
    const home = tempHome(); homes.push(home);
    const repo = fixture(home, "gamma");
    const first = await boot(home);
    const opened = await first.client.call("project.open", { path: repo });
    const session = (await first.client.call("session.create", { projectId: opened.projectId, workspaceId: opened.workspaceId, title: "crash" })).session;
    const run = (await first.client.call("run.start", { sessionId: session.id, requestId: "req_crash", prompt: "crash mid-run" })).run;
    await waitFor(() => first.events.some((e) => e.type === "run.state" && e.runId === run.id && e.payload.state === "awaiting_permission"), { label: "awaiting permission" });
    first.engine.child.kill("SIGKILL");
    await first.engine.child.exited;
    await first.client.close().catch(() => {});
    const second = await boot(home);
    const board = await second.client.call("board.list", {});
    const row = rowFor(board, "gamma");
    expect(row).toMatchObject({ attention: "needs_you", reason: "interrupted", pendingPermission: null });
    expect(row.run.note.summary).toStartWith("Interrupted");
    expect(row.nextStep).toContain("Resume");
  }, 30_000);

  test("jolo board prints the table and JSON, and a project detail with its note", async () => {
    const home = tempHome(); homes.push(home);
    const repo = fixture(home, "delta", { git: true, branch: "main" });
    const { client, events } = await boot(home);
    const opened = await client.call("project.open", { path: repo });
    const session = (await client.call("session.create", { projectId: opened.projectId, workspaceId: opened.workspaceId, title: "delta task" })).session;
    const run = (await client.call("run.start", { sessionId: session.id, requestId: "req_delta", prompt: "Replace beta with gamma" })).run;
    await waitFor(() => events.some((e) => e.type === "run.state" && e.runId === run.id && e.payload.state === "awaiting_permission"), { label: "awaiting permission" });
    const jolo = async (...args) => {
      const proc = Bun.spawn([process.execPath, CLI_ENTRY, ...args, "--home", home, "--profile", "t"], { stdout: "pipe", stderr: "pipe", env: { ...process.env } });
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { stdout, stderr, code };
    };
    const json = await jolo("board", "--json");
    expect(json.code).toBe(0);
    const parsed = JSON.parse(json.stdout);
    expect(parsed.projects).toHaveLength(1);
    expect(parsed.projects[0]).toMatchObject({ name: "delta", attention: "needs_you", reason: "awaiting_permission" });
    const table = await jolo("board");
    expect(table.code).toBe(0);
    expect(table.stdout).toContain("PROJECT");
    expect(table.stdout).toContain("delta");
    expect(table.stdout).toContain("needs approval");
    expect(table.stdout).toContain("main");
    expect(table.stdout).toContain("1 needs you");
    const detail = await jolo("board", "delta");
    expect(detail.code).toBe(0);
    expect(detail.stdout).toContain("Replace beta with gamma");
    expect(detail.stdout).toContain("Waiting for your approval");
    expect(detail.stdout).toContain("jolo permission allow");
    expect(detail.stdout).toContain("replace_exact");
    const missing = await jolo("board", "nope");
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("no project");
  }, 30_000);
});

describe("every task, across every project", () => {
  test("lists open tasks from all projects with where they are and how they are going", async () => {
    const home = tempHome(); homes.push(home);
    const alpha = fixture(home, "alpha", { git: true });
    const beta = fixture(home, "beta");
    const { client, events } = await boot(home);
    const opened = {};
    for (const [name, root] of Object.entries({ alpha, beta })) opened[name] = await client.call("project.open", { path: root });

    // Two tasks in one project and one in the other; the last is left waiting on an approval.
    const made = [];
    for (const [name, title] of [["alpha", "first"], ["alpha", "second"], ["beta", "third"]]) {
      const project = opened[name];
      const { session } = await client.call("session.create", { projectId: project.projectId, workspaceId: project.workspaceId, title });
      made.push({ name, title, session });
    }
    for (const entry of made.slice(0, 2)) {
      const { run } = await client.call("run.start", { sessionId: entry.session.id, requestId: `r_${entry.title}`, prompt: "edit then run" });
      await waitFor(() => events.some((e) => e.type === "run.state" && e.runId === run.id && ["completed", "failed", "paused", "awaiting_permission"].includes(e.payload.state)), { label: `${entry.title} settled`, timeoutMs: 20_000 });
      const pending = events.find((e) => e.type === "permission.requested" && e.runId === run.id);
      if (pending) await client.call("permission.resolve", { permissionId: pending.payload.permissionId, decision: "allow_run" });
    }
    const waiting = made.at(-1);
    const { run } = await client.call("run.start", { sessionId: waiting.session.id, requestId: "r_third", prompt: "edit then run" });
    await waitFor(() => events.some((e) => e.type === "permission.requested" && e.runId === run.id), { label: "third asked" });

    const { tasks } = await client.call("board.tasks", {});
    expect(tasks.map((task) => task.title).sort()).toEqual(["first", "second", "third"]);
    // Each row says which project and checkout it belongs to, so a list spanning projects is not ambiguous.
    const byTitle = Object.fromEntries(tasks.map((task) => [task.title, task]));
    expect(byTitle.first).toMatchObject({ projectName: "alpha", projectId: opened.alpha.projectId, mode: "direct", agentId: null });
    expect(byTitle.third).toMatchObject({ projectName: "beta", projectId: opened.beta.projectId });
    expect(byTitle.first.rootPath.endsWith("/alpha")).toBe(true); // the canonical path the engine resolved
    // A task waiting on the user says so, wherever it lives; the others have settled.
    expect(byTitle.third).toMatchObject({ attention: "needs_you", reason: "awaiting_permission" });
    expect(byTitle.third.run.state).toBe("awaiting_permission");
    expect(byTitle.first.attention).not.toBe("needs_you");
    expect(byTitle.first.summary).toBeTruthy(); // a settled task carries the note the run left
    // Newest activity first, so the list needs no sorting where it is shown.
    const stamps = tasks.map((task) => task.updatedAt);
    expect([...stamps].sort().reverse()).toEqual(stamps);

    // An archived task drops off the list; a deleted one never appears.
    await client.call("session.archive", { sessionId: byTitle.first.sessionId, archived: true, expectedRevision: (await client.call("session.page", { sessionId: byTitle.first.sessionId })).session.revision });
    expect((await client.call("board.tasks", {})).tasks.map((task) => task.title).sort()).toEqual(["second", "third"]);
  }, 60_000);
});
