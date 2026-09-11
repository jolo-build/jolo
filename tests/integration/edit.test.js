import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { startEngine, tempHome, waitFor, removeHome } from "./helpers.js";

const engines = [];
const homes = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
  for (const dir of homes.splice(0)) removeHome(dir);
});

const sha = (text) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const TERMINAL = ["completed", "failed", "cancelled", "interrupted", "paused"];

function fixtureRepo(home) {
  const repo = path.join(home, "repo");
  mkdirSync(path.join(repo, "src"), { recursive: true });
  writeFileSync(path.join(repo, "src", "math.js"), "export function add(a, b) {\n  return a - b;\n}\n");
  writeFileSync(path.join(repo, "src", "math.test.js"), 'import { expect, test } from "bun:test";\nimport { add } from "./math.js";\ntest("adds", () => { expect(add(2, 3)).toBe(5); });\n');
  writeFileSync(path.join(repo, "notes.txt"), "alpha\nbeta\nalpha\n");
  return repo;
}

/**
 * Start an engine, open the fixture, run a scripted fake conversation; `approver` decides permissions.
 * @param {{ home: string, script: import("./helpers.js").FakeScriptTurn[], clientKind?: string, approver?: (request: any, index: number) => string | null, env?: Record<string, string> }} options
 *   `approver` receives each permission request and the number already answered, and returning
 *   `null` leaves that request outstanding.
 */
async function runScript({ home, script, clientKind = "test", approver, env = {} }) {
  const scriptPath = path.join(home, "script.json");
  writeFileSync(scriptPath, JSON.stringify(script));
  const engine = await startEngine({ home, env: { JOLO_FAKE_SCRIPT: scriptPath, OPENAI_API_KEY: "sk-must-not-leak", ...env } });
  engines.push(engine);
  const client = await engine.connect({ clientKind });
  const repo = path.join(home, "repo");
  const project = await client.call("project.open", { path: repo });
  const { session, cursor } = await client.call("session.create", { projectId: project.projectId, workspaceId: project.workspaceId, title: "edit" });
  const events = [];
  const decisions = [];
  await client.subscribe({ after: cursor, sessionId: session.id }, { onEvent: (e) => {
    events.push(e);
    if (e.type === "permission.requested" && approver) {
      const decision = approver(e.payload, decisions.length);
      decisions.push(decision);
      if (decision) client.call("permission.resolve", { permissionId: e.payload.permissionId, decision }).catch((error) => events.push({ type: "resolve.error", payload: { message: error.message } }));
    }
  } });
  const { run } = await client.call("run.start", { sessionId: session.id, requestId: "req_e", prompt: "fix the failing test" });
  await waitFor(() => events.some((e) => e.type === "run.state" && TERMINAL.includes(e.payload.state)), { label: "run finished", timeoutMs: 40_000 });
  const snapshot = await client.call("run.snapshot", { runId: run.id });
  const toolOutputs = async () => {
    const latest = await client.call("run.snapshot", { runId: run.id });
    return Promise.all(latest.messages.filter((m) => m.kind === "tool").map(async (m) => (await client.call("artifact.read", { artifactId: m.artifactId })).text));
  };
  return { engine, client, project, session, events, run: snapshot.run, messages: snapshot.messages, repo, toolOutputs };
}

const results = (events) => events.filter((e) => e.type === "tool.completed").map((e) => e.payload);

describe("editing tools", () => {
  test("replace_exact edits through the patch transaction with preimages and change events", async () => {
    const home = tempHome(); homes.push(home);
    const repo = fixtureRepo(home);
    const before = readFileSync(path.join(repo, "src/math.js"), "utf8");
    const script = [
      { toolCalls: [{ name: "replace_exact", arguments: { path: "src/math.js", expectedHash: sha(before), oldText: "return a - b;", newText: "return a + b;" } }] },
      { text: ["fixed\n"] },
    ];
    const { client, events, run } = await runScript({ home, script });
    expect(run.state).toBe("completed");
    expect(results(events)[0].status).toBe("ok");
    expect(readFileSync(path.join(repo, "src/math.js"), "utf8")).toContain("return a + b;");
    const changed = events.find((e) => e.type === "files.changed").payload;
    const change = changed.changes[0];
    expect(change).toMatchObject({ path: "src/math.js", op: "replace", beforeHash: sha(before) });
    expect(change.afterHash).toBe(sha(readFileSync(path.join(repo, "src/math.js"), "utf8")));
    // The diff of what this call did is kept beside it, and belongs to the line in the transcript that made it.
    const toolMessage = events.find((e) => e.type === "message.started" && e.payload.kind === "tool");
    expect(changed.messageId).toBe(toolMessage.payload.messageId);
    expect(changed.diffArtifactId).toBeTruthy();
    const diff = (await client.call("artifact.read", { artifactId: changed.diffArtifactId })).text;
    expect(diff).toContain("--- a/src/math.js");
    expect(diff).toContain("+++ b/src/math.js");
    expect(diff).toContain("-  return a - b;");
    expect(diff).toContain("+  return a + b;");
    expect(run.verification.status).toBe("not_run");
    expect(existsSync(path.join(home, "data", "t", "patches"))).toBe(true);
  });

  test("hash mismatches, ambiguous and missing text, escapes, and binaries are structured conflicts", async () => {
    const home = tempHome(); homes.push(home);
    const repo = fixtureRepo(home);
    writeFileSync(path.join(repo, "blob.bin"), Buffer.from([0, 1, 2, 3]));
    const notes = readFileSync(path.join(repo, "notes.txt"), "utf8");
    const script = [
      { toolCalls: [
        { name: "replace_exact", arguments: { path: "notes.txt", expectedHash: "sha256:stale", oldText: "beta", newText: "gamma" } },
        { name: "replace_exact", arguments: { path: "notes.txt", expectedHash: sha(notes), oldText: "alpha", newText: "omega" } },
        { name: "replace_exact", arguments: { path: "notes.txt", expectedHash: sha(notes), oldText: "delta", newText: "x" } },
        { name: "replace_exact", arguments: { path: "../outside.txt", expectedHash: sha(notes), oldText: "a", newText: "b" } },
        { name: "apply_patch", arguments: { operations: [{ op: "replace", path: "blob.bin", expectedHash: sha(" "), content: "text" }] } },
        { name: "replace_exact", arguments: { path: "notes.txt", expectedHash: sha(notes), oldText: "alpha", newText: "omega", occurrences: 2 } },
      ] },
      { text: ["done\n"] },
    ];
    const { events, run } = await runScript({ home, script });
    expect(run.state).toBe("completed");
    expect(results(events).map((r) => r.errorCode ?? "ok")).toEqual(["conflict", "conflict", "conflict", "permission_denied", "invalid_params", "ok"]);
    expect(readFileSync(path.join(repo, "notes.txt"), "utf8")).toBe("omega\nbeta\nomega\n");
  });

  test("apply_patch creates, renames, and deletes atomically per path", async () => {
    const home = tempHome(); homes.push(home);
    const repo = fixtureRepo(home);
    const notes = readFileSync(path.join(repo, "notes.txt"), "utf8");
    const script = [
      { toolCalls: [{ name: "apply_patch", arguments: { operations: [
        { op: "create", path: "docs/new.md", content: "# new\n" },
        { op: "rename", path: "notes.txt", expectedHash: sha(notes), newPath: "archive/notes.txt" },
        { op: "delete", path: "src/math.test.js", expectedHash: sha(readFileSync(path.join(repo, "src/math.test.js"), "utf8")) },
      ] } }] },
      { text: ["patched\n"] },
    ];
    const { events, run } = await runScript({ home, script });
    expect(run.state).toBe("completed");
    expect(results(events)[0].status).toBe("ok");
    expect(readFileSync(path.join(repo, "docs/new.md"), "utf8")).toBe("# new\n");
    expect(existsSync(path.join(repo, "notes.txt"))).toBe(false);
    expect(readFileSync(path.join(repo, "archive/notes.txt"), "utf8")).toBe(notes);
    expect(existsSync(path.join(repo, "src/math.test.js"))).toBe(false);
    expect(events.find((e) => e.type === "files.changed").payload.changes.map((c) => c.op)).toEqual(["create", "rename", "delete"]);
  });
});

describe("revert", () => {
  test("reverts each operation kind from preimages with hash preconditions, and refuses when the file moved on", async () => {
    const home = tempHome(); homes.push(home);
    const repo = fixtureRepo(home);
    const math = readFileSync(path.join(repo, "src/math.js"), "utf8");
    const notes = readFileSync(path.join(repo, "notes.txt"), "utf8");
    const testFile = readFileSync(path.join(repo, "src/math.test.js"), "utf8");
    const script = [
      { toolCalls: [{ name: "apply_patch", arguments: { operations: [
        { op: "replace", path: "src/math.js", expectedHash: sha(math), content: "export const add = (a, b) => a + b;\n" },
        { op: "create", path: "docs/new.md", content: "# new\n" },
        { op: "delete", path: "src/math.test.js", expectedHash: sha(testFile) },
        { op: "rename", path: "notes.txt", expectedHash: sha(notes), newPath: "archive/notes.txt" },
      ] } }] },
      { text: ["patched\n"] },
    ];
    const { events, run, client } = await runScript({ home, script });
    expect(run.state).toBe("completed");
    const invocationId = events.find((e) => e.type === "files.changed").payload.invocationId;
    const revert = (p) => client.call("patch.revert", { invocationId, path: p });
    expect((await revert("src/math.js")).changes[0]).toMatchObject({ op: "replace", path: "src/math.js" });
    expect(readFileSync(path.join(repo, "src/math.js"), "utf8")).toBe(math);
    await revert("docs/new.md");
    expect(existsSync(path.join(repo, "docs/new.md"))).toBe(false);
    await revert("src/math.test.js");
    expect(readFileSync(path.join(repo, "src/math.test.js"), "utf8")).toBe(testFile);
    await revert("archive/notes.txt");
    expect(readFileSync(path.join(repo, "notes.txt"), "utf8")).toBe(notes);
    expect(existsSync(path.join(repo, "archive/notes.txt"))).toBe(false);
    await expect(revert("src/math.js")).rejects.toMatchObject({ code: "conflict" }); // already reverted: hash no longer matches the patch's postimage
    writeFileSync(path.join(repo, "src/math.js"), "// user edit\n");
    await expect(revert("src/math.js")).rejects.toMatchObject({ code: "conflict" });
    const reverts = events.filter((e) => e.type === "files.changed" && e.payload.tool === "revert_patch");
    expect(reverts).toHaveLength(4);
  });
});

describe("commands and permissions", () => {
  test("commands need approval; allow_run covers later commands in the same run; output is bounded and credentials are excluded", async () => {
    const home = tempHome(); homes.push(home);
    fixtureRepo(home);
    const script = [
      { toolCalls: [{ name: "run_command", arguments: { argv: ["env"] } }] },
      { toolCalls: [{ name: "run_shell", arguments: { script: "yes x | head -c 300000; echo; echo tail-marker" } }, { name: "run_command", arguments: { argv: ["sh", "-c", "exit 3"] } }] },
      { text: ["ran\n"] },
    ];
    const { events, run, toolOutputs } = await runScript({ home, script, approver: (request, n) => (n === 0 ? "allow_run" : null) });
    expect(run.state).toBe("completed");
    expect(events.filter((e) => e.type === "permission.requested")).toHaveLength(1);
    expect(events.some((e) => e.type === "run.state" && e.payload.state === "awaiting_permission")).toBe(true);
    const done = results(events);
    expect(done.map((r) => r.status)).toEqual(["ok", "ok", "ok"]);
    const outputs = await toolOutputs();
    const envOutput = outputs.find((o) => o.startsWith('run_command {"argv":["env"]'));
    expect(envOutput).not.toContain("sk-must-not-leak");
    expect(envOutput).toContain("JOLO=1");
    const big = outputs.find((o) => o.startsWith("run_shell"));
    expect(big).toContain("[live output truncated");
    const exit = outputs.find((o) => o.includes('"exit 3"'));
    expect(exit).toContain('"exitCode":3');
    expect(run.verification.status).toBe("failed");
    expect(run.verification.checks).toHaveLength(3);
  });

  test("a denied command pauses the run for the user, and the run can be resumed", async () => {
    const home = tempHome(); homes.push(home);
    fixtureRepo(home);
    const script = [{ toolCalls: [{ name: "run_command", arguments: { argv: ["echo", "hi"] } }] }, { text: ["after\n"] }];
    const { events, run, client } = await runScript({ home, script, approver: () => "deny" });
    expect(run.state).toBe("paused");
    expect(run.pauseReason).toBe("user");
    expect(results(events)[0].status).toBe("denied");
    const resumed = await client.call("run.resume", { runId: run.id });
    expect(resumed.run.state).toBe("queued");
    await waitFor(() => events.some((e) => e.type === "run.state" && e.payload.state === "completed"), { label: "resumed run completed" });
    const final = await client.call("run.snapshot", { runId: run.id });
    expect(final.messages.filter((m) => m.role === "assistant" && m.kind === "text").length).toBeGreaterThan(0);
  });

  test("headless clients cannot approve: the run pauses with the permission id and resumes after an interactive approval", async () => {
    const home = tempHome(); homes.push(home);
    fixtureRepo(home);
    const script = [{ toolCalls: [{ name: "run_command", arguments: { argv: ["echo", "approved-later"] } }] }, { text: ["finished\n"] }];
    const { events, run, engine, client } = await runScript({ home, script, clientKind: "headless" });
    expect(run.state).toBe("paused");
    expect(run.pauseReason).toBe("permission");
    const paused = events.find((e) => e.type === "run.state" && e.payload.state === "paused").payload;
    expect(paused.permissionId).toStartWith("perm_");
    await expect(client.call("permission.resolve", { permissionId: paused.permissionId, decision: "allow_run" })).rejects.toMatchObject({ code: "permission_denied" });
    await expect(client.call("run.resume", { runId: run.id })).rejects.toMatchObject({ code: "conflict" });
    const human = await engine.connect({ clientKind: "tui" });
    await human.call("permission.resolve", { permissionId: paused.permissionId, decision: "allow_once" });
    await waitFor(() => events.some((e) => e.type === "run.state" && e.payload.state === "completed"), { label: "auto-resumed run completed", timeoutMs: 20_000 });
    const final = await client.call("run.snapshot", { runId: run.id });
    const outputs = await Promise.all(final.messages.filter((m) => m.kind === "tool").map(async (m) => (await client.call("artifact.read", { artifactId: m.artifactId })).text));
    expect(outputs.join("\n")).toContain("approved-later");
    await human.close();
  });

  test("timeouts terminate the process group and report the termination", async () => {
    const home = tempHome(); homes.push(home);
    fixtureRepo(home);
    const script = [{ toolCalls: [{ name: "run_command", arguments: { argv: ["sh", "-c", "sleep 30; echo late"], timeoutMs: 1000 } }] }, { text: ["timed out\n"] }];
    const started = Date.now();
    const { events, run, toolOutputs } = await runScript({ home, script, approver: () => "allow_project" });
    expect(run.state).toBe("completed");
    expect(Date.now() - started).toBeLessThan(15_000);
    const output = (await toolOutputs()).find((o) => o.startsWith("run_command"));
    expect(output).toContain('"terminated":"timeout"');
    expect(results(events)[0].status).toBe("ok");
  });

  test("fixes a failing test end to end and records passing verification", async () => {
    const home = tempHome(); homes.push(home);
    const repo = fixtureRepo(home);
    const mathBefore = readFileSync(path.join(repo, "src/math.js"), "utf8");
    const script = [
      { toolCalls: [{ name: "run_command", arguments: { argv: [process.execPath, "test"] } }] },
      { toolCalls: [{ name: "read_file", arguments: { path: "src/math.js" } }] },
      { toolCalls: [{ name: "replace_exact", arguments: { path: "src/math.js", expectedHash: sha(mathBefore), oldText: "return a - b;", newText: "return a + b;" } }] },
      { toolCalls: [{ name: "run_command", arguments: { argv: [process.execPath, "test"] } }] },
      { text: ["The test passes now.\n"] },
    ];
    const { events, run, toolOutputs } = await runScript({ home, script, approver: () => "allow_run" });
    expect(run.state).toBe("completed");
    const outputs = await toolOutputs();
    const testRuns = outputs.filter((o) => o.startsWith("run_command"));
    expect(testRuns[0]).toContain('"exitCode":1');
    expect(testRuns[1]).toContain('"exitCode":0');
    expect(readFileSync(path.join(repo, "src/math.js"), "utf8")).toContain("return a + b;");
    expect(run.verification.status).toBe("passed");
    expect(run.verification.checks).toHaveLength(2);
    expect(events.filter((e) => e.type === "permission.requested")).toHaveLength(1);
    expect(events.some((e) => e.type === "run.verification")).toBe(true);
  });
});
