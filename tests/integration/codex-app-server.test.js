import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOT, startEngine, tempHome, waitFor, removeHome } from "./helpers.js";

const engines = [];
const homes = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
  for (const dir of homes.splice(0)) removeHome(dir);
});

const FAKE = path.join(ROOT, "tests", "fixtures", "fake-codex.js");
const TERMINAL = ["completed", "failed", "cancelled", "interrupted"];

/** A profile whose "codex" is the app-server fixture, so nothing here reaches the real CLI or its account. */
async function boot({ clientKind = "test" } = {}) {
  const home = tempHome(); homes.push(home);
  const repo = path.join(home, "repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(path.join(repo, "notes.txt"), "alpha\n");
  const launcher = path.join(home, "fake-codex");
  writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
  chmodSync(launcher, 0o755);
  const agentsDir = path.join(home, "data", "t", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(path.join(agentsDir, "codex.json"), JSON.stringify({ id: "codex", displayName: "Codex", binary: launcher, transport: "codex-app-server" }));
  const engine = await startEngine({ home });
  engines.push(engine);
  const client = await engine.connect({ clientKind });
  const events = [];
  const status = await client.call("engine.status", {});
  await client.subscribe({ after: status.cursor }, { onEvent: (event) => events.push(event) });
  const project = await client.call("project.open", { path: repo });
  const { session } = await client.call("session.create", { projectId: project.projectId, workspaceId: project.workspaceId, title: "hosted", agentId: "codex" });
  const runTo = async (requestId, prompt) => {
    const { run } = await client.call("run.start", { sessionId: session.id, requestId, prompt });
    await waitFor(() => events.some((e) => e.type === "run.state" && e.runId === run.id && TERMINAL.includes(e.payload.state)), { label: `${requestId} finished`, timeoutMs: 20_000 });
    return (await client.call("run.snapshot", { runId: run.id })).run;
  };
  const text = async (message) => (await client.call("artifact.read", { artifactId: message.artifactId })).text;
  const messagesOf = async (runId) => (await client.call("run.snapshot", { runId })).messages;
  return { home, repo, engine, client, events, project, session, runTo, text, messagesOf };
}

describe("Codex through its app-server", () => {
  test("yielded commands keep streaming after the deadline; foreground and resumed waits stay bounded", async () => {
    const { client, events, session, messagesOf, text } = await boot();
    await client.call("settings.update", { budgets: { toolDeadlineMs: 1000, maxActiveMs: 30_000 } });
    for (const mode of ["reasoning", "commentary", "foreground", "poll"]) {
      const { run } = await client.call("run.start", { sessionId: session.id, requestId: `req_deadline_${mode}`, prompt: `tool-deadline ${mode}` });
      await waitFor(() => events.some(e => e.type === "run.state" && e.runId === run.id && [...TERMINAL, "paused"].includes(e.payload.state)), { timeoutMs: 10_000, label: mode });
      const finished = (await client.call("run.snapshot", { runId: run.id })).run;
      if (["foreground", "poll"].includes(mode)) {
        expect(finished).toMatchObject({ state: "paused", pauseReason: "budget", failure: "hosted tool deadline reached" });
      } else {
        expect(finished.state).toBe("completed");
        const tool = (await messagesOf(run.id)).find(m => m.kind === "tool");
        expect(tool.status).toBe("complete");
        expect(await text(tool)).toContain("server output after yielding");
        expect(events.find(e => e.type === "tool.completed" && e.runId === run.id).payload.status).toBe("ok");
      }
    }
    await client.close();
  }, 40_000);

  test("a hosted session streams replies and reasoning as Jolo messages and resumes the same Codex thread next turn", async () => {
    const { client, events, session, runTo, text, messagesOf } = await boot();
    expect(session.agentId).toBe("codex");
    const first = await runTo("req_1", "hello there");
    expect(first.state).toBe("completed");
    const messages = await messagesOf(first.id);
    expect(messages.map((m) => [m.role, m.kind])).toEqual([["user", "text"], ["assistant", "reasoning"], ["assistant", "text"]]);
    expect(await text(messages[1])).toBe("Answering plainly.");
    expect(await text(messages[2])).toBe("You said: hello there");
    expect(events.filter((e) => e.type === "message.committed" && e.runId === first.id).length).toBeGreaterThan(0); // it streamed
    expect(first.usage).toMatchObject({ inputTokens: 15, outputTokens: 12, iterations: 1, contextUsed: 27, contextWindow: 100_000 });
    expect(first.verification).toMatchObject({ status: "not_run" });
    expect(first.note.summary).toBe("You said: hello there");

    const second = await runTo("req_2", "and again");
    expect(second.state).toBe("completed");
    // How full the window is comes from the last request, not the thread's running total, which only grows.
    // Codex reports both; a meter fed by the total would read 54 here and would never fall after a compaction.
    expect(second.usage).toMatchObject({ inputTokens: 15, outputTokens: 12, contextUsed: 27, contextWindow: 100_000 });
    expect(await text((await messagesOf(second.id)).at(-1))).toMatch(/^Continuing thread fake-thread-\w+: and again$/); // thread/resume carried the id
    const page = await client.call("session.page", { sessionId: session.id });
    expect(page.session.agentId).toBe("codex");
    expect(page.messages).toHaveLength(6);
  }, 40_000);

  test("Codex's command approvals become Jolo permission requests, decided by Jolo's grants and the user", async () => {
    const { client, events, session, runTo, text, messagesOf } = await boot();
    let decision = null;
    client.onEvent((event) => { if (event.type === "permission.requested" && !decision) { decision = event.payload; client.call("permission.resolve", { permissionId: event.payload.permissionId, decision: "allow_project" }); } });
    const run = await runTo("req_cmd", "run echo hosted-ok");
    expect(run.state).toBe("completed");
    expect(decision).toMatchObject({ tool: "codex:command", summary: "Codex: echo hosted-ok", script: "/bin/sh -lc 'echo hosted-ok'", cwd: "." });
    expect(events.some((e) => e.type === "run.state" && e.runId === run.id && e.payload.state === "awaiting_permission")).toBe(true);
    const messages = await messagesOf(run.id);
    expect(messages.map((m) => m.kind)).toEqual(["text", "tool", "text"]);
    expect(await text(messages[1])).toContain("command echo hosted-ok");
    expect(await text(messages[1])).toContain("hosted-ok\nexit 0");
    expect(await text(messages[2])).toBe("The command printed: hosted-ok");
    // Two model requests in one turn: what it cost adds up, while how full the window is comes from the last
    // request alone. Reading the running total instead would say 26 here, and would never fall on a compaction.
    expect(run.usage).toMatchObject({ inputTokens: 16, outputTokens: 10, iterations: 2, contextUsed: 17, contextWindow: 100_000 });
    const started = events.find((e) => e.type === "tool.started" && e.runId === run.id);
    const completed = events.find((e) => e.type === "tool.completed" && e.runId === run.id);
    expect(started.payload).toMatchObject({ name: "codex:commandExecution", preview: "command echo hosted-ok" });
    expect(completed.payload).toMatchObject({ name: "codex:commandExecution", status: "ok", invocationId: started.payload.invocationId });

    // The project-wide grant from that decision covers the next command without asking anyone.
    const again = await runTo("req_cmd2", "run echo covered-by-grant");
    expect(again.state).toBe("completed");
    expect(events.filter((e) => e.type === "permission.requested")).toHaveLength(1);
    expect(await text((await messagesOf(again.id)).at(-1))).toBe("The command printed: covered-by-grant");
    expect((await client.call("session.page", { sessionId: session.id })).session.agentId).toBe("codex");
  }, 40_000);

  test("patches inside the workspace are allowed by the task's grant; outside it, and a declined command, are refused", async () => {
    const { client, events, repo, home, runTo, text, messagesOf } = await boot();
    const inside = await runTo("req_patch", `patch ${path.join(repo, "made.txt")} hello from codex`);
    expect(inside.state).toBe("completed");
    expect(readFileSync(path.join(repo, "made.txt"), "utf8")).toBe("hello from codex");
    expect(events.some((e) => e.type === "permission.requested")).toBe(false); // no dialog for an in-workspace patch
    expect(events.find((e) => e.type === "tool.completed" && e.runId === inside.id).payload).toMatchObject({ name: "codex:fileChange", status: "ok" });

    const outside = await runTo("req_escape", `patch ${path.join(home, "escaped.txt")} nope`);
    expect(outside.state).toBe("completed"); // Codex finished its turn; the patch was declined, not the run
    expect(existsSync(path.join(home, "escaped.txt"))).toBe(false);
    expect(await text((await messagesOf(outside.id)).at(-1))).toBe("I could not write it: patch rejected by user");
    expect(events.find((e) => e.type === "tool.completed" && e.runId === outside.id).payload).toMatchObject({ status: "denied", errorCode: "permission_denied" });

    client.onEvent((event) => { if (event.type === "permission.requested") client.call("permission.resolve", { permissionId: event.payload.permissionId, decision: "deny" }); });
    const declined = await runTo("req_deny", "run touch should-not-exist");
    expect(declined.state).toBe("completed");
    expect(existsSync(path.join(repo, "should-not-exist"))).toBe(false);
    expect(await text((await messagesOf(declined.id)).at(-1))).toBe("I could not run it: command rejected by user");
    expect(events.find((e) => e.type === "tool.completed" && e.runId === declined.id).payload).toMatchObject({ status: "denied" });
  }, 40_000);

  test("a failed turn, a cancelled turn, and a headless client that cannot answer", async () => {
    const { client, events, session, runTo, engine } = await boot();
    const failed = await runTo("req_fail", "fail please");
    expect(failed).toMatchObject({ state: "failed", failure: "scripted failure" });

    const { run } = await client.call("run.start", { sessionId: session.id, requestId: "req_cancel", prompt: "run sleep 30" });
    await waitFor(() => events.some((e) => e.type === "permission.requested" && e.runId === run.id), { label: "asked" });
    await client.call("run.cancel", { runId: run.id });
    await waitFor(() => events.some((e) => e.type === "run.state" && e.runId === run.id && e.payload.state === "cancelled"), { label: "cancelled", timeoutMs: 10_000 });
    expect((await client.call("run.snapshot", { runId: run.id })).messages.at(-1).status).toBe("interrupted");

    // With nobody interactive attached, the request still waits durably rather than being answered for the user.
    const headless = await engine.connect({ clientKind: "headless" });
    const { run: waiting } = await headless.call("run.start", { sessionId: session.id, requestId: "req_headless", prompt: "run echo later" });
    const asked = await waitFor(() => events.find((e) => e.type === "permission.requested" && e.runId === waiting.id), { label: "headless asked" });
    await expect(headless.call("permission.resolve", { permissionId: asked.payload.permissionId, decision: "allow_once" })).rejects.toMatchObject({ code: "permission_denied" });
    await client.call("permission.resolve", { permissionId: asked.payload.permissionId, decision: "allow_once" }); // the interactive client answers
    await waitFor(() => events.some((e) => e.type === "run.state" && e.runId === waiting.id && e.payload.state === "completed"), { label: "completed after approval" });
    await headless.close();
  }, 40_000);
});
