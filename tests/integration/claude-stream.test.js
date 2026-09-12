import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOT, startEngine, tempHome, waitFor, removeHome } from "./helpers.js";
import { checkHostedBrowser } from './browser-agent-check.js';

const engines = [];
const homes = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
  for (const dir of homes.splice(0)) removeHome(dir);
});

const FAKE = path.join(ROOT, "tests", "fixtures", "fake-claude.js");
const TERMINAL = ["completed", "failed", "cancelled", "interrupted"];

test('Claude controls the inline browser on first and resumed turns with Jolo guidance', async () => {
  await checkHostedBrowser(await boot());
}, 30_000);

/** A profile whose "claude" is the protocol fixture, so nothing here reaches the real CLI or its API. */
async function boot({ clientKind = "test" } = {}) {
  const home = tempHome(); homes.push(home);
  const repo = path.join(home, "repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(path.join(repo, "notes.txt"), "alpha\n");
  const launcher = path.join(home, "fake-claude");
  writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
  chmodSync(launcher, 0o755);
  const agentsDir = path.join(home, "data", "t", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(path.join(agentsDir, "claude.json"), JSON.stringify({ id: "claude", displayName: "Claude Code", binary: launcher, transport: "claude-stream" }));
  const engine = await startEngine({ home });
  engines.push(engine);
  const client = await engine.connect({ clientKind });
  const events = [];
  const status = await client.call("engine.status", {});
  await client.subscribe({ after: status.cursor }, { onEvent: (event) => events.push(event) });
  const project = await client.call("project.open", { path: repo });
  const { session } = await client.call("session.create", { projectId: project.projectId, workspaceId: project.workspaceId, title: "hosted", agentId: "claude" });
  const runTo = async (requestId, prompt) => {
    const { run } = await client.call("run.start", { sessionId: session.id, requestId, prompt });
    await waitFor(() => events.some((e) => e.type === "run.state" && e.runId === run.id && TERMINAL.includes(e.payload.state)), { label: `${requestId} finished`, timeoutMs: 20_000 });
    return (await client.call("run.snapshot", { runId: run.id })).run;
  };
  const text = async (message) => (await client.call("artifact.read", { artifactId: message.artifactId })).text;
  const messagesOf = async (runId) => (await client.call("run.snapshot", { runId })).messages;
  return { home, repo, engine, client, events, project, session, runTo, text, messagesOf };
}

describe("Claude Code through its structured stream", () => {
  test('multiple Claude chats in one folder keep independent turns, permissions, and history', async () => {
    const { client, events, project, session, messagesOf, text } = await boot({ clientKind: 'desktop' });
    try {
      const chats = [session];
      for (let index = 1; index < 4; index++) chats.push((await client.call('session.create', {
        projectId: project.projectId, workspaceId: project.workspaceId, agentId: 'claude', title: `Chat ${index}`,
      })).session);
      const waiting = [];
      for (const [index, chat] of chats.slice(0, 3).entries()) {
        const { run } = await client.call('run.start', { sessionId: chat.id, requestId: `parallel-${index}`, prompt: `run echo chat-${index}` });
        waiting.push(run);
        await waitFor(() => events.some(event => event.type === 'permission.requested' && event.runId === run.id));
      }
      expect((await client.call('engine.status', {})).activeRuns).toBe(3);
      const followup = (await client.call('run.start', { sessionId: chats[0].id, requestId: 'followup', prompt: 'continue here' })).run;
      expect((await client.call('run.snapshot', { runId: followup.id })).run.state).toBe('queued');
      const quick = (await client.call('run.start', { sessionId: chats[3].id, requestId: 'independent', prompt: 'Explain TCP/IP' })).run;
      await waitFor(async () => (await client.call('run.snapshot', { runId: quick.id })).run.state === 'completed');
      expect(await text((await messagesOf(quick.id)).at(-1))).toBe('You said: Explain TCP/IP');
      for (const run of waiting) expect((await client.call('run.snapshot', { runId: run.id })).run.state).toBe('awaiting_permission');
      // Resolving one chat's permission must not resume the others or consume their requests.
      const approval = events.find(event => event.type === 'permission.requested' && event.runId === waiting[0].id).payload;
      await client.call('permission.resolve', { permissionId: approval.permissionId, decision: 'allow_once' });
      await waitFor(async () => (await client.call('run.snapshot', { runId: followup.id })).run.state === 'completed');
      expect(await text((await messagesOf(followup.id)).at(-1))).toMatch(/^Continuing session fake-\w+: continue here$/);
      for (const run of waiting.slice(1)) expect((await client.call('run.snapshot', { runId: run.id })).run.state).toBe('awaiting_permission');
      for (const [index, chat] of chats.entries()) {
        const page = await client.call('session.page', { sessionId: chat.id });
        expect(page.runs.every(run => run.sessionId === chat.id)).toBe(true);
        expect(page.messages.every(message => message.sessionId === chat.id)).toBe(true);
        expect(page.runs).toHaveLength(index === 0 ? 2 : 1);
      }
    } finally { await client.close(); }
  }, 20_000);

  test('Claude gets browser tools only while its own workspace is displayed in desktop', async () => {
    const { client, engine, project, events, runTo, messagesOf, text } = await boot();
    const host = await engine.connect({ clientKind: 'desktop' });
    try {
      const run = await runTo('req_browser', 'browser-check');
      expect(run.state).toBe('completed');
      expect(await text((await messagesOf(run.id)).at(-1))).toBe('Browser tools unavailable');
      expect(events.some(event => event.type === 'tool.completed' && event.payload.name.startsWith('browser_'))).toBe(false);
      await host.call('browser.setOpener', { workspaceIds: [project.workspaceId, 'stale-workspace'] });
      const discovered = await runTo('req_browser_visible', 'browser-discovery');
      expect(discovered.state).toBe('completed');
      expect(await text((await messagesOf(discovered.id)).at(-1))).toBe('Browser tools available');
      await host.call('browser.setOpener', { workspaceIds: [] });
      const closed = await runTo('req_browser_closed', 'browser-check');
      expect(await text((await messagesOf(closed.id)).at(-1))).toBe('Browser tools unavailable');
      expect(events.some(event => event.type === 'permission.requested')).toBe(false);
    } finally { await host.close(); await client.close(); }
  }, 25_000);
  test("a hosted session streams replies as Jolo messages and continues the same Claude session next turn", async () => {
    const { client, events, session, runTo, text, messagesOf } = await boot();
    expect(session.agentId).toBe("claude");
    const first = await runTo("req_1", "hello there");
    expect(first.state).toBe("completed");
    const messages = await messagesOf(first.id);
    expect(messages.map((m) => [m.role, m.kind])).toEqual([["user", "text"], ["assistant", "text"]]);
    expect(await text(messages[0])).toBe("hello there");
    expect(await text(messages[1])).toBe("You said: hello there");
    expect(events.filter((e) => e.type === "message.committed" && e.runId === first.id).length).toBeGreaterThan(0); // it streamed
    expect(first.usage).toMatchObject({ inputTokens: 35, outputTokens: 7, iterations: 1 });
    expect(first.verification).toMatchObject({ status: "not_run" });
    expect(first.note.summary).toBe("You said: hello there");

    const second = await runTo("req_2", "and again");
    expect(second.state).toBe("completed");
    expect(await text((await messagesOf(second.id))[1])).toMatch(/^Continuing session fake-\w+: and again$/); // --resume carried the id
    const page = await client.call("session.page", { sessionId: session.id });
    expect(page.session.agentId).toBe("claude");
    expect(page.messages).toHaveLength(4);
  }, 40_000);

  test("Claude's permission prompts become Jolo permission requests, decided by Jolo's grants and the user", async () => {
    const { client, events, repo, session, runTo, text, messagesOf } = await boot();
    // A command needs the user; a grant for the task then covers the next one without asking.
    let decision = null;
    client.onEvent((event) => { if (event.type === "permission.requested" && !decision) { decision = event.payload; client.call("permission.resolve", { permissionId: event.payload.permissionId, decision: "allow_project" }); } });
    const run = await runTo("req_cmd", "run echo hosted-ok");
    expect(run.state).toBe("completed");
    expect(decision).toMatchObject({ tool: "claude:Bash", summary: "Bash: echo hosted-ok", script: "echo hosted-ok", cwd: realpathSync(repo) });
    expect(events.some((e) => e.type === "run.state" && e.runId === run.id && e.payload.state === "awaiting_permission")).toBe(true);
    const messages = await messagesOf(run.id);
    expect(messages.map((m) => m.kind)).toEqual(["text", "tool", "text"]);
    expect(await text(messages[1])).toContain('Bash {"command":"echo hosted-ok"}');
    expect(await text(messages[1])).toContain("hosted-ok");
    expect(await text(messages[2])).toBe("The command printed: hosted-ok");
    const started = events.find((e) => e.type === "tool.started" && e.runId === run.id);
    const completed = events.find((e) => e.type === "tool.completed" && e.runId === run.id);
    expect(started.payload).toMatchObject({ name: "claude:Bash" });
    expect(completed.payload).toMatchObject({ name: "claude:Bash", status: "ok", invocationId: started.payload.invocationId });

    // The project-wide grant from that decision covers the next command without asking anyone.
    const again = await runTo("req_cmd2", "run echo covered-by-grant");
    expect(again.state).toBe("completed");
    expect(events.filter((e) => e.type === "permission.requested")).toHaveLength(1);
    expect(await text((await messagesOf(again.id)).at(-1))).toBe("The command printed: covered-by-grant");
  }, 40_000);

  test("edits inside the workspace are allowed by the task's grant; outside it, and a declined command, are refused in Claude's own words", async () => {
    const { client, events, repo, home, runTo, text, messagesOf } = await boot();
    const inside = await runTo("req_write", `write ${path.join(repo, "made.txt")} hello from claude`);
    expect(inside.state).toBe("completed");
    expect(readFileSync(path.join(repo, "made.txt"), "utf8")).toBe("hello from claude");
    expect(events.some((e) => e.type === "permission.requested")).toBe(false); // no dialog for an in-workspace edit

    const outside = await runTo("req_escape", `write ${path.join(home, "escaped.txt")} nope`);
    expect(outside.state).toBe("completed"); // Claude finished its turn; the tool was refused, not the run
    expect(existsSync(path.join(home, "escaped.txt"))).toBe(false);
    expect(await text((await messagesOf(outside.id)).at(-1))).toContain("Jolo policy: Write outside the workspace is not allowed");

    client.onEvent((event) => { if (event.type === "permission.requested") client.call("permission.resolve", { permissionId: event.payload.permissionId, decision: "deny" }); });
    const declined = await runTo("req_deny", "run touch should-not-exist");
    expect(declined.state).toBe("completed");
    expect(existsSync(path.join(repo, "should-not-exist"))).toBe(false);
    expect(await text((await messagesOf(declined.id)).at(-1))).toBe("I could not run it: The user declined this action in Jolo.");
    expect(events.find((e) => e.type === "tool.completed" && e.runId === declined.id).payload).toMatchObject({ status: "error", errorCode: "tool_error" });
  }, 40_000);

  test("a failed turn, a cancelled turn, and a headless client that cannot answer", async () => {
    const { client, events, session, runTo, engine } = await boot();
    const failed = await runTo("req_fail", "fail please");
    expect(failed).toMatchObject({ state: "failed", failure: "scripted failure" });

    const { run } = await client.call("run.start", { sessionId: session.id, requestId: "req_cancel", prompt: "run sleep 30" });
    await waitFor(() => events.some((e) => e.type === "permission.requested" && e.runId === run.id), { label: "asked" });
    await client.call("run.cancel", { runId: run.id });
    await waitFor(() => events.some((e) => e.type === "run.state" && e.runId === run.id && e.payload.state === "cancelled"), { label: "cancelled" });
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

  test("only a structured-transport agent can answer as a session", async () => {
    const { client, project } = await boot();
    await expect(client.call("session.create", { projectId: project.projectId, workspaceId: project.workspaceId, agentId: "shell" })).rejects.toMatchObject({ code: "invalid_params" });
    await expect(client.call("session.create", { projectId: project.projectId, workspaceId: project.workspaceId, agentId: "no-such-agent" })).rejects.toMatchObject({ code: "not_found" });
  }, 20_000);
});
