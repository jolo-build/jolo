import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOT, startEngine, tempHome, waitFor, removeHome } from "./helpers.js";
import { checkHostedBrowser } from './browser-agent-check.js';

const engines = [];
const homes = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
  for (const dir of homes.splice(0)) removeHome(dir);
});

const FAKE = path.join(ROOT, "tests", "fixtures", "fake-acp.js");
const TERMINAL = ["completed", "failed", "cancelled", "interrupted"];

test('ACP controls the inline browser on first and resumed turns with Jolo guidance', async () => {
  await checkHostedBrowser(await boot());
}, 30_000);

/** A profile with an ACP agent played by the fixture, so nothing here reaches any vendor's CLI or account. */
async function boot({ clientKind = "test" } = {}) {
  const home = tempHome(); homes.push(home);
  const repo = path.join(home, "repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(path.join(repo, "notes.txt"), "alpha\n");
  const launcher = path.join(home, "fake-acp");
  writeFileSync(launcher, `#!/bin/sh\nFAKE_ACP_STATE=${JSON.stringify(path.join(home, "acp-state"))} exec "${process.execPath}" "${FAKE}" "$@"\n`);
  chmodSync(launcher, 0o755);
  const agentsDir = path.join(home, "data", "t", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(path.join(agentsDir, "fixture-acp.json"), JSON.stringify({ id: "fixture-acp", displayName: "Fixture Agent", binary: launcher, args: ["--acp"], transport: "acp" }));
  const engine = await startEngine({ home });
  engines.push(engine);
  const client = await engine.connect({ clientKind });
  const events = [];
  const status = await client.call("engine.status", {});
  await client.subscribe({ after: status.cursor }, { onEvent: (event) => events.push(event) });
  const project = await client.call("project.open", { path: repo });
  const { session } = await client.call("session.create", { projectId: project.projectId, workspaceId: project.workspaceId, title: "hosted", agentId: "fixture-acp" });
  const runTo = async (requestId, prompt) => {
    const { run } = await client.call("run.start", { sessionId: session.id, requestId, prompt });
    await waitFor(() => events.some((e) => e.type === "run.state" && e.runId === run.id && TERMINAL.includes(e.payload.state)), { label: `${requestId} finished`, timeoutMs: 20_000 });
    return (await client.call("run.snapshot", { runId: run.id })).run;
  };
  const text = async (message) => (await client.call("artifact.read", { artifactId: message.artifactId })).text;
  const messagesOf = async (runId) => (await client.call("run.snapshot", { runId })).messages;
  return { home, repo, engine, client, events, project, session, runTo, text, messagesOf };
}

describe("an agent hosted through the Agent Client Protocol", () => {
  test('ACP omits unavailable browser tools when creating and resuming a session', async () => {
    const { client, events, runTo, messagesOf, text } = await boot();
    try {
      for (const request of ['browser-first', 'browser-resumed']) {
        const run = await runTo(request, 'browser-check');
        expect(run.state).toBe('completed');
        expect(await text((await messagesOf(run.id)).at(-1))).toBe('Browser tools unavailable');
      }
      expect(events.some(event => event.type === 'tool.completed' && event.payload.name.startsWith('browser_'))).toBe(false);
    } finally { await client.close(); }
  }, 25_000);
  test("reopened sessions include pending approvals until they are decided or cancelled", async () => {
    const { client, events, session } = await boot();
    const { run } = await client.call('run.start', { sessionId: session.id, requestId: 'restore-approval', prompt: 'run echo restore-approval' });
    await waitFor(() => events.some(event => event.type === 'permission.requested' && event.runId === run.id), { label: 'ACP permission requested' });
    const requested = events.find(event => event.type === 'permission.requested' && event.runId === run.id).payload;
    const page = await client.call('session.page', { sessionId: session.id });
    expect(page.pendingPermissions).toEqual([requested]);
    await client.call('permission.resolve', { permissionId: requested.permissionId, decision: 'allow_once' });
    await waitFor(() => events.some(event => event.type === 'run.state' && event.runId === run.id && event.payload.state === 'completed'), { label: 'approved ACP command finished' });
    expect((await client.call('session.page', { sessionId: session.id })).pendingPermissions).toEqual([]);

    const { run: next } = await client.call('run.start', { sessionId: session.id, requestId: 'cancel-approval', prompt: 'run echo cancel-approval' });
    await waitFor(() => events.some(event => event.type === 'permission.requested' && event.runId === next.id), { label: 'second ACP permission requested' });
    await client.call('run.cancel', { runId: next.id });
    await waitFor(() => events.some(event => event.type === 'run.state' && event.runId === next.id && event.payload.state === 'cancelled'), { label: 'ACP command cancelled' });
    expect((await client.call('session.page', { sessionId: session.id })).pendingPermissions).toEqual([]);
  }, 40_000);

  test("a hosted session streams thoughts and replies as Jolo messages and loads the same agent session next turn", async () => {
    const { client, events, session, runTo, text, messagesOf } = await boot();
    const first = await runTo("req_1", "hello there");
    expect(first.state).toBe("completed");
    const messages = await messagesOf(first.id);
    expect(messages.map((m) => [m.role, m.kind])).toEqual([["user", "text"], ["assistant", "reasoning"], ["assistant", "text"]]);
    expect(await text(messages[1])).toBe("Thinking about it.");
    expect(await text(messages[2])).toBe("You said: hello there");
    expect(events.filter((e) => e.type === "message.committed" && e.runId === first.id).length).toBeGreaterThan(0); // it streamed
    expect(first.verification).toMatchObject({ status: "not_run" });
    expect(first.usage).toMatchObject({ contextUsed: 100, contextWindow: 100_000 }); // from the agent's own usage_update
    expect(first.note.summary).toBe("You said: hello there");

    const second = await runTo("req_2", "and again");
    expect(second.state).toBe("completed");
    expect(await text((await messagesOf(second.id)).at(-1))).toMatch(/^Continuing session acp-\w+: and again$/); // session/load carried the id
    const page = await client.call("session.page", { sessionId: session.id });
    expect(page.messages).toHaveLength(6); // the replayed history was not written into the transcript a second time
  }, 40_000);

  test("the agent's permission questions become Jolo permission requests, answered once and never 'always'", async () => {
    const { client, events, runTo, text, messagesOf } = await boot();
    let decision = null;
    client.onEvent((event) => { if (event.type === "permission.requested" && !decision) { decision = event.payload; client.call("permission.resolve", { permissionId: event.payload.permissionId, decision: "allow_project" }); } });
    const run = await runTo("req_cmd", "run echo acp-ok");
    expect(run.state).toBe("completed");
    expect(decision).toMatchObject({ tool: "fixture-acp:execute", summary: "Fixture Agent: Execute `echo acp-ok`", script: "echo acp-ok", cwd: "." });
    const messages = await messagesOf(run.id);
    expect(messages.map((m) => m.kind)).toEqual(["text", "reasoning", "tool", "text"]);
    expect(await text(messages[2])).toContain("execute Execute `echo acp-ok` echo acp-ok");
    expect(await text(messages[2])).toContain("acp-ok");
    expect(await text(messages[3])).toBe("The command printed: acp-ok");
    const started = events.find((e) => e.type === "tool.started" && e.runId === run.id);
    const completed = events.find((e) => e.type === "tool.completed" && e.runId === run.id);
    expect(started.payload).toMatchObject({ name: "fixture-acp:execute" });
    expect(completed.payload).toMatchObject({ name: "fixture-acp:execute", status: "ok", invocationId: started.payload.invocationId });

    // The project-wide grant covers the next command; the agent still asks, Jolo answers from the grant.
    const again = await runTo("req_cmd2", "run echo covered-by-grant");
    expect(again.state).toBe("completed");
    expect(events.filter((e) => e.type === "permission.requested")).toHaveLength(1);
    expect(await text((await messagesOf(again.id)).at(-1))).toBe("The command printed: covered-by-grant");
  }, 40_000);

  test("the agent's file access goes through Jolo's file system and stays inside the workspace", async () => {
    const { client, events, repo, home, runTo, text, messagesOf } = await boot();
    const read = await runTo("req_read", `read ${path.join(repo, "notes.txt")}`);
    expect(read.state).toBe("completed");
    expect(await text((await messagesOf(read.id)).at(-1))).toBe("The file says: alpha");
    expect(events.some((e) => e.type === "permission.requested")).toBe(false); // reads inside the workspace need no dialog

    const inside = await runTo("req_write", `write ${path.join(repo, "made.txt")} hello from acp`);
    expect(inside.state).toBe("completed");
    expect(readFileSync(path.join(repo, "made.txt"), "utf8")).toBe("hello from acp");
    expect(events.some(e => e.type === "files.changed" && e.runId === inside.id && e.payload.changes.some(change => change.path === "made.txt"))).toBe(true);
    expect(events.some((e) => e.type === "permission.requested")).toBe(false); // nor do edits: the task's grant covers them
    expect(events.find((e) => e.type === "tool.completed" && e.runId === inside.id && e.payload.name === "fixture-acp:edit").payload).toMatchObject({ name: "fixture-acp:edit", status: "ok" });

    const outside = await runTo("req_escape", `write ${path.join(home, "escaped.txt")} nope`);
    expect(outside.state).toBe("completed");
    expect(existsSync(path.join(home, "escaped.txt"))).toBe(false);
    expect(await text((await messagesOf(outside.id)).at(-1))).toBe("I could not write it: the edit was rejected");
    expect(events.find((e) => e.type === "tool.completed" && e.runId === outside.id).payload).toMatchObject({ status: "denied", errorCode: "permission_denied" });

    // An agent that writes without asking first is stopped at the file system itself.
    const sneaky = await runTo("req_sneak", `sneak ${path.join(home, "sneaked.txt")} nope`);
    expect(sneaky.state).toBe("completed");
    expect(existsSync(path.join(home, "sneaked.txt"))).toBe(false);
    expect(await text((await messagesOf(sneaky.id)).at(-1))).toBe("I could not write it: Jolo policy: writing outside the workspace is not allowed");
    const allowed = await runTo("req_sneak_in", `sneak ${path.join(repo, "sneaked.txt")} fine`);
    expect(allowed.state).toBe("completed");
    expect(readFileSync(path.join(repo, "sneaked.txt"), "utf8")).toBe("fine");

    client.onEvent((event) => { if (event.type === "permission.requested") client.call("permission.resolve", { permissionId: event.payload.permissionId, decision: "deny" }); });
    const declined = await runTo("req_deny", "run touch should-not-exist");
    expect(declined.state).toBe("completed");
    expect(existsSync(path.join(repo, "should-not-exist"))).toBe(false);
    expect(await text((await messagesOf(declined.id)).at(-1))).toBe("I could not run it: the command was rejected");
  }, 40_000);

  test("a single-use approval covers one call, and an agent offering only a standing one is refused", async () => {
    const { client, events, runTo, text, messagesOf } = await boot();
    const asked = [];
    client.onEvent((event) => {
      if (event.type !== "permission.requested") return;
      asked.push(event.payload);
      client.call("permission.resolve", { permissionId: event.payload.permissionId, decision: "allow_once" });
    });
    const twice = await runTo("req_twice", "twice echo spend-me");
    expect(twice.state).toBe("completed");
    // Both asks reached the user: the grant the first decision created was spent on that first call alone.
    expect(asked).toHaveLength(2);
    expect(await text((await messagesOf(twice.id)).at(-1))).toBe("Asked twice and heard 1:allow_once 2:allow_once");

    // The agent offers "always" or nothing; Jolo says no rather than granting more than the user did.
    const standing = await runTo("req_always", "always echo never-standing");
    expect(standing.state).toBe("completed");
    expect(asked).toHaveLength(3); // it still asked the user, who allowed it
    expect(await text((await messagesOf(standing.id)).at(-1))).toBe("The agent was told reject_once");
    const denied = events.filter((event) => event.type === "tool.completed" && event.runId === standing.id);
    expect(denied.at(-1).payload).toMatchObject({ status: "denied" });
  }, 40_000);

  test("an agent that floods its diagnostics still finishes its turn", async () => {
    const { runTo, text, messagesOf } = await boot();
    const run = await runTo("req_noisy", "noisy still here");
    expect(run.state).toBe("completed");
    expect(await text((await messagesOf(run.id)).at(-1))).toBe("Said a lot and still answered: still here");
  }, 40_000);

  test("another agent is called into the conversation by name, for one turn, and then it is Jolo's task again", async () => {
    const { client, engine, events, project, runTo, text, messagesOf } = await boot();
    // A task Jolo answers; the fixture agent is called in by name for a single turn.
    const { session: mine } = await client.call("session.create", { projectId: project.projectId, workspaceId: project.workspaceId, title: "mine" });
    const jolo = async (requestId, prompt) => {
      const { run } = await client.call("run.start", { sessionId: mine.id, requestId, prompt });
      await waitFor(() => events.some((e) => e.type === "run.state" && e.runId === run.id && TERMINAL.includes(e.payload.state)), { label: requestId, timeoutMs: 20_000 });
      return (await client.call("run.snapshot", { runId: run.id })).run;
    };
    const first = await jolo("mine_1", "say something");
    expect(first.state).toBe("completed");
    expect(first.execution).toBeNull(); // nobody was called in

    const guest = await jolo("mine_2", "@fixture-acp what do you make of it?");
    if (guest.state !== "completed") throw new Error(`guest turn failed: ${guest.failure}`);
    expect(guest.execution).toMatchObject({ agentId: "fixture-acp" }); // the run records who answered it
    const messages = await messagesOf(guest.id);
    expect(await text(messages[0])).toBe("@fixture-acp what do you make of it?"); // the transcript keeps what was typed
    expect(await text(messages.at(-1))).toBe("You said: what do you make of it?"); // the agent was asked what followed the name
    expect((await client.call("session.page", { sessionId: mine.id })).session.agentId).toBeNull(); // the task is still Jolo's

    // The guest keeps a thread of its own in this conversation, so calling it again continues where it was.
    const again = await jolo("mine_3", "@fixture-acp and now?");
    expect(await text((await messagesOf(again.id)).at(-1))).toMatch(/^Continuing session acp-\w+: and now\?$/);

    // A name that belongs to nobody, and a name in the middle of a sentence, are ordinary text for Jolo.
    const plain = await jolo("mine_4", "ask @fixture-acp about it later");
    expect(plain.execution).toBeNull();
    expect(await text((await messagesOf(plain.id)).at(-1))).toContain("done:");
    await engine.stop();
  }, 60_000);

  test("Jolo is called into a hosted conversation and is given what was said before", async () => {
    const { client, events, session, runTo, text, messagesOf } = await boot();
    const hosted = await runTo("req_1", "hello there");
    expect(hosted.state).toBe("completed");

    const { run } = await client.call("run.start", { sessionId: session.id, requestId: "ask_jolo", prompt: "@jolo summarise that" });
    await waitFor(() => events.some((e) => e.type === "run.state" && e.runId === run.id && TERMINAL.includes(e.payload.state)), { label: "Jolo answered", timeoutMs: 20_000 });
    const answered = (await client.call("run.snapshot", { runId: run.id })).run;
    expect(answered.state).toBe("completed");
    expect(answered.execution).toMatchObject({ agentId: "jolo" });
    const messages = await messagesOf(run.id);
    expect(await text(messages[0])).toBe("@jolo summarise that");
    expect(await text(messages.at(-1))).toContain("done:"); // Jolo's own fake provider answered, not the agent
    expect((await client.call("session.page", { sessionId: session.id })).session.agentId).toBe("fixture-acp"); // still the agent's task
  }, 60_000);

  test("a failed turn, a cancelled turn, and a headless client that cannot answer", async () => {
    const { client, events, session, runTo, engine } = await boot();
    const failed = await runTo("req_fail", "fail please");
    expect(failed).toMatchObject({ state: "failed", failure: "Fixture Agent: scripted failure" });

    const { run } = await client.call("run.start", { sessionId: session.id, requestId: "req_cancel", prompt: "sleep" });
    await waitFor(() => events.some((e) => e.type === "message.started" && e.runId === run.id && e.payload.kind === "reasoning"), { label: "thinking" });
    await client.call("run.cancel", { runId: run.id });
    await waitFor(() => events.some((e) => e.type === "run.state" && e.runId === run.id && e.payload.state === "cancelled"), { label: "cancelled", timeoutMs: 10_000 });

    const headless = await engine.connect({ clientKind: "headless" });
    const { run: waiting } = await headless.call("run.start", { sessionId: session.id, requestId: "req_headless", prompt: "run echo later" });
    const asked = await waitFor(() => events.find((e) => e.type === "permission.requested" && e.runId === waiting.id), { label: "headless asked" });
    await expect(headless.call("permission.resolve", { permissionId: asked.payload.permissionId, decision: "allow_once" })).rejects.toMatchObject({ code: "permission_denied" });
    await client.call("permission.resolve", { permissionId: asked.payload.permissionId, decision: "allow_once" });
    await waitFor(() => events.some((e) => e.type === "run.state" && e.runId === waiting.id && e.payload.state === "completed"), { label: "completed after approval" });
    await headless.close();
  }, 40_000);
});
