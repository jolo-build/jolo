import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_EVENT_TYPES } from "@jolo/protocol";
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

/** Whether a process is still there; a pid the kernel has recycled would read as alive, which these short tests accept. */
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** A profile whose "claude" is the protocol fixture, so nothing here reaches the real CLI or its API. */
/** @param {{ clientKind?: string, env?: Record<string, string>, idleMs?: number, manifest?: Record<string, unknown> }} [options] */
async function boot({ clientKind = "test", env = {}, idleMs, manifest = {} } = {}) {
  const home = tempHome(); homes.push(home);
  const repo = path.join(home, "repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(path.join(repo, "notes.txt"), "alpha\n");
  const launcher = path.join(home, "fake-claude");
  const startsLog = path.join(home, "starts.log");
  // The shell's pid survives exec, so each line is the pid of one fixture process Jolo started.
  writeFileSync(launcher, `#!/bin/sh\necho $$ >> "${startsLog}"\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
  chmodSync(launcher, 0o755);
  const agentsDir = path.join(home, "data", "t", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(path.join(agentsDir, "claude.json"), JSON.stringify({ id: "claude", displayName: "Claude Code", binary: launcher, transport: "claude-stream", ...manifest }));
  const engine = await startEngine({ home, env, ...(idleMs ? { idleMs } : {}) });
  engines.push(engine);
  const client = await engine.connect({ clientKind });
  const events = [];
  const activities = [];
  const status = await client.call("engine.status", {});
  await client.subscribe({ after: status.cursor }, { onEvent: (event) => events.push(event), onActivity: (activity) => activities.push(activity) });
  const project = await client.call("project.open", { path: repo });
  const { session } = await client.call("session.create", { projectId: project.projectId, workspaceId: project.workspaceId, title: "hosted", agentId: "claude" });
  const runTo = async (requestId, prompt) => {
    const { run } = await client.call("run.start", { sessionId: session.id, requestId, prompt });
    await waitFor(() => events.some((e) => e.type === "run.state" && e.runId === run.id && TERMINAL.includes(e.payload.state)), { label: `${requestId} finished`, timeoutMs: 20_000 });
    return (await client.call("run.snapshot", { runId: run.id })).run;
  };
  const text = async (message) => (await client.call("artifact.read", { artifactId: message.artifactId })).text;
  const messagesOf = async (runId) => (await client.call("run.snapshot", { runId })).messages;
  const starts = () => (existsSync(startsLog) ? readFileSync(startsLog, "utf8").split("\n").filter(Boolean).map(Number) : []);
  return { home, repo, engine, client, events, activities, project, session, runTo, text, messagesOf, starts };
}

/**
 * A parent run kept live, as a delegating parent is while it waits on its children: the fixture asks permission for
 * its command and nobody answers. Its prompt selects the fixture itself as the delegation model `m1`.
 */
async function bootWithParent() {
  const booted = await boot({ manifest: { modelArgs: ['--model', '{model}'] } });
  const { client, events, session } = booted;
  const { run: parent } = await client.call('run.start', { sessionId: session.id, requestId: 'parent', prompt: 'run sleep 600 ^agent:claude/default' });
  await waitFor(() => events.some(e => e.type === 'permission.requested' && e.runId === parent.id), { label: 'the parent waits on its permission', timeoutMs: 20_000 });
  return { ...booted, parent };
}

describe("Claude Code through its structured stream", () => {
  test('Claude reports how full its window is, from its own usage report', async () => {
    const { runTo } = await boot();
    const turn = await runTo('hello', 'hello');
    expect(turn.usage).toMatchObject({ contextUsed: 41007, contextWindow: 1_000_000, agentId: 'claude' });
  }, 30_000);

  test('subagent review reports stay in tool activity without corrupting or duplicating the parent reply', async () => {
    const { client, events, runTo, messagesOf, text } = await boot();
    try {
      client.onEvent(event => { if (event.type === 'permission.requested') void client.call('permission.resolve', { permissionId: event.payload.permissionId, decision: 'deny' }); });
      const run = await runTo('review', 'subagent-review');
      expect(run.state).toBe('completed');
      const messages = await messagesOf(run.id);
      const replies = messages.filter(message => message.role === 'assistant');
      expect(await Promise.all(replies.map(text))).toEqual(['I found one issue. Validate the interval before saving.']);
      expect(replies.every(message => message.status === 'complete')).toBe(true);
      const tools = messages.filter(message => message.kind === 'tool');
      expect(tools).toHaveLength(1);
      const call = await text(tools[0]);
      expect(call.split('\n', 1)[0]).toBe('Agent {"subagent_type":"code-reviewer","description":"Review the code","prompt":"Review the code"}');
      // The subagent's model and each tool it used come first, one line each, then its report.
      expect(call).toContain('\n↳ model: claude-opus-5-5\n↳ Bash: echo child-review\n↳ Read app.js\n\n[{"file":"app.js"');
      expect(call).toContain('INTERNAL_REVIEW');
      expect(call).not.toContain('SECOND_INTERNAL_REVIEW');
      expect(tools[0].status).toBe('complete');
      expect(events.filter(event => event.type === 'permission.requested')).toHaveLength(1);
      expect(run.note.summary).toBe('I found one issue. Validate the interval before saving.');
    } finally { await client.close(); }
  }, 20_000);

  test("/compact reaches Claude as its own command, alone, and the task notes the compaction", async () => {
    const { client, runTo, messagesOf, text } = await boot();
    try {
      expect((await runTo('before', 'hello')).state).toBe('completed');
      const run = await runTo('compact', ' /compact ');
      expect(run.state).toBe('completed');
      const replies = (await messagesOf(run.id)).filter(message => message.role === 'assistant');
      expect(await Promise.all(replies.map(text))).toEqual(['Context compacted.']);
    } finally { await client.close(); }
  }, 20_000);

  test("a long subagent's progress stops at whole lines, says more happened, and keeps its report whole", async () => {
    const { client, runTo, messagesOf, text } = await boot();
    try {
      const run = await runTo('long review', 'subagent-long');
      expect(run.state).toBe('completed');
      const [tool] = (await messagesOf(run.id)).filter(message => message.kind === 'tool');
      const lines = (await text(tool)).split('\n');
      const steps = lines.slice(1, lines.indexOf(''));
      expect(steps[0]).toBe('↳ model: claude-opus-5-5');
      expect(steps.at(-1)).toBe('↳ … more steps not shown');
      expect(steps.length).toBeGreaterThan(50);
      expect(steps.slice(1, -1).every(line => /^↳ Read src\/\d{3}\/(deep\/)+/.test(line))).toBe(true);
      expect(lines.slice(lines.indexOf('') + 1).join('\n').trim()).toBe('LONG_REPORT');
    } finally { await client.close(); }
  }, 20_000);

  test("any slash command reaches Claude whole, with no handoff around it, and its command list comes with its models", async () => {
    const { client, runTo, messagesOf, text } = await boot();
    try {
      const report = await client.call('agent.models', { agentId: 'claude' });
      expect(report.commands).toEqual([
        { name: 'compact', description: 'Free up context by summarizing the conversation so far', argumentHint: '<optional custom summarization instructions>' },
        { name: 'deploy', description: 'Ship the current branch to an environment', argumentHint: '<environment>' },
      ]);
      expect((await runTo('before', 'hello')).state).toBe('completed'); // so a later message would otherwise carry the conversation along
      const run = await runTo('deploy', '  /deploy staging  ');
      expect(run.state).toBe('completed');
      const replies = (await messagesOf(run.id)).filter(message => message.role === 'assistant');
      expect(await Promise.all(replies.map(text))).toEqual(['Command received: /deploy staging']);
      // A slash inside a sentence is prose, and travels with the conversation as usual.
      const prose = await runTo('prose', 'what does /deploy do?');
      expect(await text((await messagesOf(prose.id)).at(-1))).toMatch(/^Continuing session fake-\w+: what does \/deploy do\?$/);
    } finally { await client.close(); }
  }, 30_000);

  test('long Claude tools do not inherit the native tool deadline', async () => {
    const { client, events, session, messagesOf, text } = await boot();
    try {
      await client.call('settings.update', { budgets: { toolDeadlineMs: 1000, maxActiveMs: 30_000 } });
      const { run } = await client.call('run.start', { sessionId: session.id, requestId: 'long-command', prompt: 'run sleep 1.8 && echo long-test-finished' });
      const approval = await waitFor(() => events.find(e => e.type === 'permission.requested' && e.runId === run.id));
      await client.call('permission.resolve', { permissionId: approval.payload.permissionId, decision: 'allow_once' });
      await waitFor(() => events.some(e => e.type === 'run.state' && e.runId === run.id && [...TERMINAL, 'paused'].includes(e.payload.state)), { timeoutMs: 10_000 });
      expect((await client.call('run.snapshot', { runId: run.id })).run.state).toBe('completed');
      expect(await text((await messagesOf(run.id)).at(-1))).toContain('long-test-finished');
    } finally { await client.close(); }
  }, 20_000);

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

  test('Claude keeps browser tools while live workspace availability changes', async () => {
    const { client, engine, project, events, runTo, messagesOf, text } = await boot();
    const host = await engine.connect({ clientKind: 'desktop' });
    try {
      const run = await runTo('req_browser', 'browser-check');
      expect(run.state).toBe('completed');
      expect(await text((await messagesOf(run.id)).at(-1))).toBe('Browser unavailable: open this workspace in Jolo desktop to use its inline browser');
      expect(events.some(event => event.type === 'tool.completed' && event.payload.name === 'browser_open' && event.payload.status === 'error')).toBe(true);
      await host.call('browser.setOpener', { workspaceIds: [project.workspaceId, 'stale-workspace'] });
      const discovered = await runTo('req_browser_visible', 'browser-discovery');
      expect(discovered.state).toBe('completed');
      expect(await text((await messagesOf(discovered.id)).at(-1))).toBe('Browser tools available');
      await host.call('browser.setOpener', { workspaceIds: [] });
      const closed = await runTo('req_browser_closed', 'browser-check');
      expect(await text((await messagesOf(closed.id)).at(-1))).toBe('Browser unavailable: open this workspace in Jolo desktop to use its inline browser');
      expect(events.some(event => event.type === 'permission.requested')).toBe(false);
    } finally { await host.close(); await client.close(); }
  }, 25_000);
  test('Claude calls its scoped schedule tools without a permission prompt', async () => {
    const { client, events, session, runTo, messagesOf, text } = await boot();
    try {
      const run = await runTo('req_schedule', 'schedule-check');
      expect(run.state).toBe('completed');
      expect(await text((await messagesOf(run.id)).at(-1))).toBe('Schedules on this task: 1');
      expect(events.some(event => event.type === 'permission.requested')).toBe(false);
      const { schedules } = await client.call('schedule.list', { sessionId: session.id });
      expect(schedules.map(schedule => schedule.prompt)).toEqual(['check the board']);
    } finally { await client.close(); }
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

describe("one Claude process per conversation", () => {
  test("a conversation keeps one Claude process across its turns", async () => {
    const { runTo, text, messagesOf, starts } = await boot();
    const first = await runTo("turn-1", "hello there");
    expect(first.state).toBe("completed");
    const second = await runTo("turn-2", "and again");
    expect(second.state).toBe("completed");
    expect(await text((await messagesOf(second.id)).at(-1))).toMatch(/^Continuing session fake-\w+: and again$/);
    expect(starts()).toHaveLength(1); // the same process answered both turns
    expect(alive(starts()[0])).toBe(true); // and is still there for the next one
  }, 30_000);

  test("background work Claude started outlives the turn and its follow-up becomes a run of its own", async () => {
    const { client, session, runTo, text, messagesOf, starts } = await boot();
    const run = await runTo("bg", "background 400 Background work finished: all good");
    expect(run.state).toBe("completed");
    expect(await text((await messagesOf(run.id)).at(-1))).toBe("Background work started.");
    // The process was not killed when the turn ended, so the turn it starts by itself reaches the conversation.
    const followUp = await waitFor(async () => {
      const { runs } = await client.call("session.page", { sessionId: session.id });
      return runs.find((candidate) => candidate.id !== run.id && candidate.state === "completed");
    }, { label: "the self-started turn recorded as a run", timeoutMs: 10_000 });
    expect(await text((await messagesOf(followUp.id)).at(-1))).toBe("Background work finished: all good");
    expect(starts()).toHaveLength(1);
  }, 30_000);

  test('background work is reported as session activity while it runs and when it ends', async () => {
    const { client, events, session, runTo } = await boot();
    const run = await runTo('bg-activity', 'tasks 2 400');
    expect(run.state).toBe('completed');
    await waitFor(() => events.some(e => e.type === 'session.activity' && e.sessionId === session.id && e.payload.state === 'background'));
    const live = await client.call('session.activity', { sessionId: session.id });
    expect(live.activity.tasks).toHaveLength(2);
    await waitFor(() => events.some(e => e.type === 'session.activity' && e.payload.state === 'idle' && e.payload.tasks.every(t => t.status === 'completed')), { timeoutMs: 5000 });
    const bursts = events.filter(e => e.type === 'session.activity');
    expect(bursts.length).toBeLessThanOrEqual(2 + 2 * 2); // one per state change and per task start or end, none per progress message
  }, 30_000);

  test('progress of background work reaches clients as it happens, and only state and task changes are kept', async () => {
    const { engine, client, events, activities, session, runTo } = await boot();
    // A subscriber that declares only the event types every client knew is never sent an activity notification.
    const older = await engine.connect();
    const toOlder = [];
    await older.subscribe({ eventTypes: [...DEFAULT_EVENT_TYPES] }, { onActivity: (activity) => toOlder.push(activity) });
    const run = await runTo('bg-progress', 'tasks 2 1000');
    expect(run.state).toBe('completed');
    await waitFor(() => events.some(e => e.type === 'session.activity' && e.payload.state === 'idle' && e.payload.tasks.every(t => t.status === 'completed')), { timeoutMs: 5000 });
    await waitFor(async () => (await client.call('session.page', { sessionId: session.id })).runs.some(r => r.id !== run.id && r.state === 'completed'), { label: 'the turn reporting the tasks done', timeoutMs: 10_000 });
    expect(activities.some(a => a.sessionId === session.id && a.activity.state === 'background' && a.activity.tasks.every(t => t.usage.totalTokens !== null))).toBe(true);
    const durable = events.filter(e => e.type === 'session.activity' && e.sessionId === session.id).map(e => e.payload);
    expect(durable.length).toBeLessThanOrEqual(2 + 2 * 2); // one per state change and per task start or end
    const shape = (activity) => JSON.stringify([activity.state, activity.tasks.map(t => [t.taskId, t.status])]);
    durable.slice(1).forEach((activity, i) => expect(shape(activity)).not.toBe(shape(durable[i]))); // none for usage alone
    expect(toOlder).toEqual([]);
    await older.close();
  }, 30_000);

  test('session activity is null for a conversation with no process and not_found for an unknown one', async () => {
    const { client, session } = await boot();
    expect(await client.call('session.activity', { sessionId: session.id })).toEqual({ activity: null });
    await expect(client.call('session.activity', { sessionId: 'no-such-session' })).rejects.toMatchObject({ code: 'not_found' });
  }, 30_000);

  test('Stop background work ends a conversation\'s background tasks and keeps its process', async () => {
    const { client, events, session, runTo, starts } = await boot();
    await runTo('bg', 'tasks 2 20000');
    await waitFor(() => events.some(e => e.type === 'session.activity' && e.payload.state === 'background'));
    expect(await client.call('session.stopBackground', { sessionId: session.id })).toEqual({ requested: 2, stopped: 2, escalated: false });
    await waitFor(() => events.some(e => e.type === 'session.activity' && e.payload.state === 'idle'));
    expect(starts()).toHaveLength(1);
    expect(alive(starts()[0])).toBe(true);
  }, 30_000);

  test('force-stopping a conversation closes its process, which ends the tasks that ignored stop_task', async () => {
    const { client, events, session, runTo, starts } = await boot();
    await runTo('stubborn', 'tasks-stubborn 2');
    await waitFor(() => events.some(e => e.type === 'session.activity' && e.payload.state === 'background'));
    expect(await client.call('session.stopBackground', { sessionId: session.id })).toMatchObject({ requested: 2, stopped: 0 }); // stubborn tasks acknowledge stop_task and keep running: escalated stays false
    expect(await client.call('session.closeProcess', { sessionId: session.id })).toEqual({ closing: true });
    await waitFor(() => !alive(starts()[0]), { timeoutMs: 15_000 });
    const activityOf = () => events.filter(e => e.type === 'session.activity' && e.sessionId === session.id).at(-1);
    await waitFor(() => activityOf().payload.state !== 'background', { label: 'the process end reported' }); // reported once the engine reads its output's end, a moment after it is gone
    const last = activityOf();
    expect(last.payload.state).toBe('idle');
    expect(last.payload.tasks.map(t => t.status)).toEqual(['failed', 'failed']); // both stubborn tasks ended with the process
    expect(await client.call('session.closeProcess', { sessionId: session.id })).toEqual({ closing: false });
  }, 30_000);

  test('stopping one background task ends only that task, and Claude\'s reason comes back when it will not', async () => {
    const { client, events, session, runTo } = await boot();
    await runTo('bg', 'tasks 2 20000');
    await waitFor(() => events.some(e => e.type === 'session.activity' && e.payload.state === 'background'));
    expect(await client.call('session.stopTask', { sessionId: session.id, taskId: 'task-1' })).toEqual({ ok: true, error: null });
    await waitFor(async () => (await client.call('session.activity', { sessionId: session.id })).activity.tasks.find(t => t.taskId === 'task-1').status === 'stopped');
    expect((await client.call('session.activity', { sessionId: session.id })).activity.tasks.map(t => [t.taskId, t.status])).toEqual([['task-1', 'stopped'], ['task-2', 'running']]);
    expect(await client.call('session.stopTask', { sessionId: session.id, taskId: 'nope' })).toEqual({ ok: false, error: 'stop_task: unknown task' });
  }, 30_000);

  test('stopping background work, a task or the process of a conversation with no process stops nothing; an unknown one is not_found', async () => {
    const { engine, client, session } = await boot();
    expect(await client.call('session.stopBackground', { sessionId: session.id })).toEqual({ requested: 0, stopped: 0, escalated: false });
    expect(await client.call('session.stopTask', { sessionId: session.id, taskId: 'task-1' })).toEqual({ ok: false, error: 'no process' });
    expect(await client.call('session.closeProcess', { sessionId: session.id })).toEqual({ closing: false });
    await expect(client.call('session.stopBackground', { sessionId: 'no-such-session' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(client.call('session.stopTask', { sessionId: 'no-such-session', taskId: 'task-1' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(client.call('session.closeProcess', { sessionId: 'no-such-session' })).rejects.toMatchObject({ code: 'not_found' });
    // Closing a process ends Claude's work: only an interactive client may ask.
    const headless = await engine.connect({ clientKind: 'headless' });
    await expect(headless.call('session.closeProcess', { sessionId: session.id })).rejects.toMatchObject({ code: 'permission_denied' });
    await headless.close();
  }, 30_000);

  test("an empty result ahead of the answer does not end the turn", async () => {
    const { runTo, text, messagesOf } = await boot();
    const run = await runTo("zero", "zero-result hello");
    expect(run.state).toBe("completed");
    expect(await text((await messagesOf(run.id)).at(-1))).toBe("You said: hello");
    expect(run.usage.iterations).toBe(1); // the real answer's usage, not the empty result's
  }, 30_000);

  test("cancelling a turn interrupts Claude and keeps its process for the next turn", async () => {
    const { client, events, session, runTo, text, messagesOf, starts } = await boot();
    const { run } = await client.call("run.start", { sessionId: session.id, requestId: "cancel-me", prompt: "run sleep 30" });
    await waitFor(() => events.some((e) => e.type === "permission.requested" && e.runId === run.id), { label: "asked" });
    await client.call("run.cancel", { runId: run.id });
    await waitFor(() => events.some((e) => e.type === "run.state" && e.runId === run.id && e.payload.state === "cancelled"), { label: "cancelled" });
    const next = await runTo("after-cancel", "still here?");
    expect(next.state).toBe("completed");
    expect(await text((await messagesOf(next.id)).at(-1))).toMatch(/^Continuing session fake-\w+: still here\?$/);
    expect(starts()).toHaveLength(1);
  }, 30_000);

  test("the Claude process is closed when the conversation is archived", async () => {
    const { client, session, runTo, starts } = await boot();
    await runTo("before-archive", "hello");
    const [pid] = starts();
    expect(alive(pid)).toBe(true);
    const page = await client.call("session.page", { sessionId: session.id });
    await client.call("session.archive", { sessionId: session.id, expectedRevision: page.session.revision, archived: true });
    await waitFor(() => !alive(pid), { label: "process gone after archive", timeoutMs: 5_000 });
  }, 30_000);

  test("an idle Claude process is closed after the idle timeout and the next turn resumes the conversation", async () => {
    const { runTo, text, messagesOf, starts } = await boot({ env: { JOLO_HOSTED_IDLE_MS: "500" } });
    await runTo("idle-1", "hello");
    const [pid] = starts();
    await waitFor(() => !alive(pid), { label: "idle process closed", timeoutMs: 5_000 });
    const again = await runTo("idle-2", "back again");
    expect(again.state).toBe("completed");
    expect(await text((await messagesOf(again.id)).at(-1))).toMatch(/^Continuing session fake-\w+: back again$/); // --resume carried the id
    expect(starts()).toHaveLength(2);
  }, 30_000);

  test("handing the conversation to another agent and back starts Claude afresh from the shared chat", async () => {
    const { client, session, runTo, text, messagesOf, starts } = await boot();
    await runTo("with-claude", "hello");
    const [first] = starts();
    // Jolo answers for a while; Claude's remembered thread is dropped with the switch, as it would miss these turns.
    let page = await client.call("session.page", { sessionId: session.id });
    await client.call("session.setAgent", { sessionId: session.id, agentId: null, expectedRevision: page.session.revision });
    await waitFor(() => !alive(first), { label: "process gone after the switch", timeoutMs: 5_000 });
    page = await client.call("session.page", { sessionId: session.id });
    await client.call("session.setAgent", { sessionId: session.id, agentId: "claude", expectedRevision: page.session.revision });
    const back = await runTo("back-with-claude", "history");
    expect(back.state).toBe("completed");
    expect(await text((await messagesOf(back.id)).at(-1))).toStartWith("Fresh agent context:"); // a new process, no --resume
    expect(starts()).toHaveLength(2);
  }, 30_000);

  test("a Claude process that leaves on its own is replaced on the next turn", async () => {
    const { runTo, text, messagesOf, starts } = await boot();
    const gone = await runTo("leaves", "exit-after-turn");
    expect(gone.state).toBe("completed");
    const again = await runTo("replaced", "anyone there?");
    expect(again.state).toBe("completed");
    expect(await text((await messagesOf(again.id)).at(-1))).toMatch(/^Continuing session fake-\w+: anyone there\?$/);
    expect(starts()).toHaveLength(2);
  }, 30_000);
});

describe('background work after the turn, against a binary that queues turns like the real one', () => {
  /** The runs that appeared after `known`, with their state and what they said. */
  const later = async ({ client, events, messagesOf, text }, known) => {
    const ids = [...new Set(events.filter((e) => e.type === 'run.state' && !known.includes(e.runId)).map((e) => e.runId))];
    return Promise.all(ids.map(async (id) => ({ id, state: (await client.call('run.snapshot', { runId: id })).run.state, said: (await Promise.all((await messagesOf(id)).filter((m) => m.role === 'assistant').map(text))).join('') })));
  };

  test('a background subagent asking permission gets a short run of its own and leaves the conversation free', async () => {
    const booted = await boot();
    const { client, events, runTo, messagesOf, text, starts } = booted;
    const asked = [];
    client.onEvent((event) => { if (event.type === 'permission.requested') { asked.push(event.runId); void client.call('permission.resolve', { permissionId: event.payload.permissionId, decision: 'allow_once' }); } });
    const launch = await runTo('launch', 'background-permission 100 1500');
    expect(launch.state).toBe('completed');
    await waitFor(() => asked.length === 1, { label: 'the subagent asked', timeoutMs: 5000 });
    const question = asked[0];
    expect(question).not.toBe(launch.id);
    // The question's run ends as soon as it is answered, long before the subagent reports back.
    await waitFor(() => events.some((e) => e.type === 'run.state' && e.runId === question && e.payload.state === 'completed'), { label: 'the question run ended', timeoutMs: 1000 });
    // So a message now is answered at once instead of waiting behind the background work.
    const sent = Date.now();
    const hello = await runTo('hello', 'hello');
    expect(Date.now() - sent).toBeLessThan(1200);
    expect(hello.state).toBe('completed');
    expect((await Promise.all((await messagesOf(hello.id)).filter((m) => m.role === 'assistant').map(text))).join('')).toMatch(/: hello$/);
    // Nothing else is started while the subagent works: what followed its question was a notice, not a turn.
    expect(await later(booted, [launch.id, question, hello.id])).toEqual([]);
    // When the subagent finishes, the same process says so in a run of its own.
    await waitFor(async () => (await later(booted, [launch.id, question, hello.id])).some((run) => run.state === 'completed' && run.said === 'Background agent finished: allow'), { label: 'the report', timeoutMs: 5000 });
    expect(starts()).toHaveLength(1);
    expect(alive(starts()[0])).toBe(true);
  }, 30_000);

  test('a background subagent asking the person gets a short run of its own, held by its dialog until answered', async () => {
    const booted = await boot();
    const { client, events, runTo, starts } = booted;
    const launch = await runTo('launch', 'background-dialog 100 300');
    expect(launch.state).toBe('completed');
    const asked = await waitFor(() => events.find((e) => e.type === 'dialog.requested'), { label: 'the subagent asked the person', timeoutMs: 5000 });
    expect(asked.runId).not.toBe(launch.id);
    expect(events.some((e) => e.type === 'permission.requested')).toBe(false);
    expect((await client.call('run.snapshot', { runId: asked.runId })).run.state).toBe('awaiting_permission');
    await client.call('dialog.resolve', { dialogId: asked.payload.dialogId, response: { answers: { 'tea or coffee?': 'coffee' } } });
    // The question's run ends as soon as it is answered, before the subagent reports back.
    await waitFor(() => events.some((e) => e.type === 'run.state' && e.runId === asked.runId && e.payload.state === 'completed'), { label: 'the question run ended', timeoutMs: 1000 });
    await waitFor(async () => (await later(booted, [launch.id, asked.runId])).some((run) => run.state === 'completed' && run.said === 'Background agent finished: coffee'), { label: 'the report', timeoutMs: 5000 });
    expect(starts()).toHaveLength(1);
    expect(alive(starts()[0])).toBe(true);
  }, 30_000);

  test('stopping a background subagent’s question denies it and keeps the process and its work', async () => {
    const booted = await boot();
    const { client, events, runTo, starts } = booted;
    const asked = [];
    client.onEvent((event) => { if (event.type === 'permission.requested') asked.push(event.runId); });
    const launch = await runTo('launch', 'background-permission 100 200');
    await waitFor(() => asked.length === 1, { label: 'the subagent asked', timeoutMs: 5000 });
    await client.call('run.cancel', { runId: asked[0] });
    await waitFor(() => events.some((e) => e.type === 'run.state' && e.runId === asked[0] && TERMINAL.includes(e.payload.state)), { label: 'the question run ended', timeoutMs: 3000 });
    expect((await client.call('run.snapshot', { runId: asked[0] })).run.state).toBe('cancelled');
    // The subagent was told no rather than killed: it finishes, and the same process reports it.
    await waitFor(async () => (await later(booted, [launch.id, asked[0]])).some((run) => run.state === 'completed' && run.said === 'Background agent finished: deny'), { label: 'the report', timeoutMs: 5000 });
    expect(starts()).toHaveLength(1);
    expect(alive(starts()[0])).toBe(true);
  }, 30_000);

  test('a message taken up just after a turn the process began by itself still gets its own answer', async () => {
    const booted = await boot();
    const { runTo, messagesOf, text, starts } = booted;
    await runTo('hello', 'hello');
    // The binary starts a turn of its own a moment before it takes the message up; that turn's result is not the answer.
    const raced = await runTo('raced', 'race-self what about mine');
    expect(raced.state).toBe('completed');
    const said = (await Promise.all((await messagesOf(raced.id)).filter((m) => m.role === 'assistant').map(text))).join(' | ');
    expect(said).toContain('A background task finished first.');
    expect(said).toMatch(/You said: what about mine$/);
    expect(starts()).toHaveLength(1);
  }, 30_000);

  test('while one of two background questions is still open, the run keeps waiting on the user', async () => {
    const booted = await boot();
    const { client, events, runTo } = booted;
    const asked = [];
    client.onEvent((event) => { if (event.type === 'permission.requested') asked.push(event); });
    const launch = await runTo('launch', 'background-two 100');
    await waitFor(() => asked.length === 2, { label: 'both subagents asked', timeoutMs: 5000 });
    const run = asked[0].runId;
    expect(asked[1].runId).toBe(run);
    const stateOf = () => events.filter((e) => e.type === 'run.state' && e.runId === run).at(-1)?.payload.state;
    await client.call('permission.resolve', { permissionId: asked[0].payload.permissionId, decision: 'allow_once' });
    await Bun.sleep(200);
    expect(stateOf()).toBe('awaiting_permission');
    await client.call('permission.resolve', { permissionId: asked[1].payload.permissionId, decision: 'allow_once' });
    await waitFor(() => stateOf() === 'completed', { label: 'the question run ended', timeoutMs: 3000 });
    await waitFor(async () => (await later(booted, [launch.id, run])).some((entry) => entry.said === 'Background agents finished: allow, allow'), { label: 'the report', timeoutMs: 5000 });
  }, 30_000);

  test('a background question asked just as a run is stopped is told no at once, without asking the user', async () => {
    const booted = await boot();
    const { client, events, session, runTo, messagesOf, text, starts } = booted;
    const asked = [];
    client.onEvent((event) => { if (event.type === 'permission.requested') asked.push(event); });
    const hello = await runTo('hello', 'hello');
    const { run } = await client.call('run.start', { sessionId: session.id, requestId: 'ask-on-stop', prompt: 'ask-on-stop' });
    await waitFor(async () => (await Promise.all((await messagesOf(run.id)).filter((m) => m.role === 'assistant').map(text))).join('') === 'Working on it.', { label: 'the binary took the message up', timeoutMs: 10_000 });
    await client.call('run.cancel', { runId: run.id });
    await waitFor(() => events.some((e) => e.type === 'run.state' && e.runId === run.id && TERMINAL.includes(e.payload.state)), { label: 'the stopped run ended', timeoutMs: 5000 });
    expect((await client.call('run.snapshot', { runId: run.id })).run.state).toBe('cancelled');
    await waitFor(async () => (await later(booted, [hello.id, run.id])).some((entry) => entry.state === 'completed' && entry.said === 'Background agent finished: deny: The run was stopped in Jolo.'), { label: 'the report', timeoutMs: 5000 });
    expect(asked).toEqual([]);
    expect(starts()).toHaveLength(1);
  }, 30_000);

  test('a background question open when the empty-result grace passes keeps the run until it is answered', async () => {
    const booted = await boot({ env: { JOLO_EMPTY_RESULT_GRACE_MS: '300' } });
    const { client, events, session } = booted;
    const asked = [];
    client.onEvent((event) => { if (event.type === 'permission.requested') asked.push(event); });
    const { run } = await client.call('run.start', { sessionId: session.id, requestId: 'empty-ask', prompt: 'zero-result-ask' });
    const ended = () => events.some((e) => e.type === 'run.state' && e.runId === run.id && TERMINAL.includes(e.payload.state));
    await waitFor(() => asked.length === 1, { label: 'the subagent asked', timeoutMs: 5000 });
    expect(asked[0].runId).toBe(run.id);
    await Bun.sleep(800); // well past the grace
    expect(ended()).toBe(false);
    await client.call('permission.resolve', { permissionId: asked[0].payload.permissionId, decision: 'allow_once' });
    await waitFor(ended, { label: 'the run ended', timeoutMs: 3000 });
    expect((await client.call('run.snapshot', { runId: run.id })).run.state).toBe('completed');
    await waitFor(async () => (await later(booted, [run.id])).some((entry) => entry.said === 'Background agent finished: allow'), { label: 'the report', timeoutMs: 5000 });
  }, 30_000);

  test('a turn the process begins while the run waits only on a question is not cut off when the question is answered', async () => {
    const booted = await boot();
    const { client, events, session, messagesOf, text } = booted;
    const asked = [];
    client.onEvent((event) => { if (event.type === 'permission.requested') asked.push(event); });
    const { run } = await client.call('run.start', { sessionId: session.id, requestId: 'ask-then-turn', prompt: 'ask-then-turn 1500' });
    const said = async () => (await Promise.all((await messagesOf(run.id)).filter((m) => m.role === 'assistant').map(text))).join(' | ');
    await waitFor(() => asked.length === 1, { label: 'the subagent asked', timeoutMs: 5000 });
    // The run's own answer is out; the process has begun a report of its own, which arrives in this run.
    await waitFor(async () => (await said()).includes('Report part one'), { label: 'the report began', timeoutMs: 5000 });
    await client.call('permission.resolve', { permissionId: asked[0].payload.permissionId, decision: 'allow_once' });
    await Bun.sleep(300);
    expect(events.some((e) => e.type === 'run.state' && e.runId === run.id && TERMINAL.includes(e.payload.state))).toBe(false);
    await waitFor(() => events.some((e) => e.type === 'run.state' && e.runId === run.id && TERMINAL.includes(e.payload.state)), { label: 'the run ended', timeoutMs: 5000 });
    expect((await client.call('run.snapshot', { runId: run.id })).run.state).toBe('completed');
    expect(await said()).toBe('Launched. | Report part one, part two.');
    expect(await later(booted, [run.id])).toEqual([]); // nothing of the report was split off into a run of its own
  }, 30_000);

  test('a turn the process begins after Stop on an empty result gets a run of its own, and the process lives', async () => {
    const booted = await boot();
    const { client, events, session, messagesOf, text, starts } = booted;
    const asked = [];
    client.onEvent((event) => { if (event.type === 'permission.requested') asked.push(event); });
    // The empty result is the whole turn; a subagent asks during the grace that follows it.
    const { run } = await client.call('run.start', { sessionId: session.id, requestId: 'empty-ask', prompt: 'zero-result-ask' });
    await waitFor(() => asked.length === 1, { label: 'the subagent asked', timeoutMs: 5000 });
    await client.call('run.cancel', { runId: run.id });
    // Told no, the subagent reports back at once: in a run of its own, not the stopped one.
    await waitFor(async () => (await later(booted, [run.id])).some((entry) => entry.state === 'completed' && entry.said === 'Background agent finished: deny'), { label: 'the report', timeoutMs: 5000 });
    expect((await client.call('run.snapshot', { runId: run.id })).run.state).toBe('cancelled');
    expect((await Promise.all((await messagesOf(run.id)).filter((m) => m.role === 'assistant').map(text))).join('')).toBe('');
    await Bun.sleep(5500); // past the interrupt grace: nothing closes the process for an interrupt it never had to answer
    expect(starts()).toHaveLength(1);
    expect(alive(starts()[0])).toBe(true);
  }, 30_000);

  test('a question taken back while the turn goes on closes its prompt; the run shows the wait only while it lasts', async () => {
    const { client, events, session, messagesOf, text } = await boot();
    const asked = [];
    client.onEvent((event) => { if (event.type === 'permission.requested') asked.push(event); });
    const { run } = await client.call('run.start', { sessionId: session.id, requestId: 'withdraw-in-turn', prompt: 'ask-withdraw-in-turn' });
    const states = () => events.filter((e) => e.type === 'run.state' && e.runId === run.id).map((e) => e.payload.state);
    const said = async () => (await Promise.all((await messagesOf(run.id)).filter((m) => m.role === 'assistant').map(text))).join('');
    await waitFor(() => asked.length === 1, { label: 'the subagent asked', timeoutMs: 5000 });
    // The main thread talks while the question is open: the run still shows it waiting on the user.
    await waitFor(async () => (await said()).includes('Still working.'), { label: 'the main thread talked', timeoutMs: 5000 });
    expect(states().at(-1)).toBe('awaiting_permission');
    const { permissionId } = asked[0].payload;
    await waitFor(() => events.some((e) => e.type === 'permission.resolved' && e.payload.permissionId === permissionId), { label: 'the withdrawn prompt closed', timeoutMs: 3000 });
    await expect(client.call('permission.resolve', { permissionId, decision: 'allow_project' })).rejects.toMatchObject({ code: 'conflict' });
    await waitFor(() => states().includes('completed'), { label: 'the run ended', timeoutMs: 5000 });
    expect(states().slice(states().lastIndexOf('awaiting_permission') + 1)).toContain('model'); // back at work once nobody was asked
    expect(await said()).toBe('Still working. Done.');
  }, 30_000);
});

test('a worktree removal that is refused leaves the conversation’s process and its work running', async () => {
  const { client, project, repo, events, starts } = await boot();
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
  const git = (...args) => Bun.spawnSync(['git', ...args], { cwd: repo, env });
  git('init', '-q', '-b', 'main'); git('add', '.'); git('commit', '-q', '-m', 'init');
  const { workspace } = await client.call('workspace.create', { projectId: project.projectId, title: 'side work' });
  const { session } = await client.call('session.create', { projectId: project.projectId, workspaceId: workspace.id, title: 'in the worktree', agentId: 'claude' });
  const { run } = await client.call('run.start', { sessionId: session.id, requestId: 'worktree-hello', prompt: 'hello' });
  await waitFor(() => events.some((e) => e.type === 'run.state' && e.runId === run.id && TERMINAL.includes(e.payload.state)), { label: 'the worktree turn', timeoutMs: 20_000 });
  const pid = starts().at(-1);
  expect(alive(pid)).toBe(true);
  writeFileSync(path.join(workspace.path, 'draft.txt'), 'unsaved\n');
  await expect(client.call('workspace.remove', { workspaceId: workspace.id })).rejects.toMatchObject({ code: 'conflict' });
  expect(alive(pid)).toBe(true); // the refusal did not stop the agent working there
  await client.call('workspace.remove', { workspaceId: workspace.id, force: true });
  await waitFor(() => !alive(pid), { label: 'the process closed with its worktree', timeoutMs: 5000 });
}, 30_000);

test('an answer that starts after an empty result is not cut off by the empty-result grace', async () => {
  const { runTo, messagesOf, text } = await boot({ env: { JOLO_EMPTY_RESULT_GRACE_MS: '300' } });
  const run = await runTo('slow-answer', 'zero-result-slow 900 and then the rest');
  expect(run.state).toBe('completed');
  expect((await Promise.all((await messagesOf(run.id)).filter((m) => m.role === 'assistant').map(text))).join('')).toBe('Partly and then the rest');
}, 30_000);

test('a tool call that arrives just after Stop does not kill the process', async () => {
  const { client, events, session, runTo, messagesOf, text, starts } = await boot();
  await runTo('hello', 'hello');
  const { run } = await client.call('run.start', { sessionId: session.id, requestId: 'stop-race', prompt: 'stop-race' });
  await waitFor(async () => (await Promise.all((await messagesOf(run.id)).filter((m) => m.role === 'assistant').map(text))).join('') === 'Working on it.', { label: 'the turn is under way', timeoutMs: 10_000 });
  await client.call('run.cancel', { runId: run.id });
  await waitFor(() => events.some((e) => e.type === 'run.state' && e.runId === run.id && TERMINAL.includes(e.payload.state)), { label: 'the stopped run ended', timeoutMs: 10_000 });
  expect((await client.call('run.snapshot', { runId: run.id })).run.state).toBe('cancelled');
  const after = await runTo('after', 'after');
  expect(after.state).toBe('completed');
  expect(starts()).toHaveLength(1); // the same process answered: Stop interrupted it, nothing killed it
  expect(alive(starts()[0])).toBe(true);
}, 30_000);

test('a turn the process begins by itself while another run is finishing still arrives as a run of its own', async () => {
  const { client, events, runTo, messagesOf, text } = await boot();
  const launch = await runTo('launch', 'background 150 finished in the background');
  const busy = await runTo('busy', 'slow 400 still busy'); // the background task reports during this turn, so its turn queues behind it
  const reported = async () => {
    const ids = [...new Set(events.filter((e) => e.type === 'run.state' && ![launch.id, busy.id].includes(e.runId)).map((e) => e.runId))];
    for (const id of ids) {
      const run = (await client.call('run.snapshot', { runId: id })).run;
      const said = (await Promise.all((await messagesOf(id)).filter((m) => m.role === 'assistant').map(text))).join('');
      if (run.state === 'completed' && said === 'finished in the background') return true;
    }
    return false;
  };
  await waitFor(reported, { label: 'the background report as its own run', timeoutMs: 5000 });
}, 30_000);

test('a message the binary does not echo back still gets its own answer', async () => {
  const { runTo, messagesOf, text } = await boot();
  await runTo('hello', 'hello');
  // Claude keeps <task-notification> and command output tags for itself and does not echo a message carrying them;
  // the turn's init and result still name the message.
  const quoted = await runTo('quoted', 'about <task-notification>done</task-notification> in my notes');
  expect(quoted.state).toBe('completed');
  expect((await Promise.all((await messagesOf(quoted.id)).filter((m) => m.role === 'assistant').map(text))).join('')).toMatch(/about <task-notification>done<\/task-notification> in my notes$/);
}, 30_000);

test('a run queued behind a turn the process began by itself can be stopped before its message is ever sent', async () => {
  const { client, events, session, runTo, messagesOf, text, starts } = await boot();
  const launch = await runTo('launch', 'background-slow 100 1500 the background report');
  // The process begins its own long turn; a message sent now waits behind it.
  await Bun.sleep(300);
  const { run } = await client.call('run.start', { sessionId: session.id, requestId: 'behind', prompt: 'never answer this' });
  await Bun.sleep(200);
  await client.call('run.cancel', { runId: run.id });
  await waitFor(() => events.some((e) => e.type === 'run.state' && e.runId === run.id && TERMINAL.includes(e.payload.state)), { label: 'the stopped run ended', timeoutMs: 10_000 });
  expect((await client.call('run.snapshot', { runId: run.id })).run.state).toBe('cancelled');
  // The stopped message is not answered later in some other run.
  await Bun.sleep(2500);
  const runIds = [...new Set(events.filter((e) => e.type === 'run.state' && ![launch.id, run.id].includes(e.runId)).map((e) => e.runId))];
  const said = (await Promise.all(runIds.map(async (id) => (await Promise.all((await messagesOf(id)).filter((m) => m.role === 'assistant').map(text))).join('')))).join(' | ');
  expect(said).not.toContain('never answer this');
  expect(starts()).toHaveLength(1);
  expect(alive(starts()[0])).toBe(true);
}, 30_000);

test('stopping an answer that follows an empty result interrupts it, and it does not go on in another run', async () => {
  const { client, events, session, runTo, messagesOf, text, starts } = await boot();
  await runTo('hello', 'hello');
  const { run } = await client.call('run.start', { sessionId: session.id, requestId: 'stopped-answer', prompt: 'zero-result-slow 1500 the rest of the stopped answer' });
  await waitFor(() => events.some((e) => e.type === 'run.state' && e.runId === run.id && e.payload.state === 'model'), { label: 'the answer is streaming', timeoutMs: 10_000 });
  await Bun.sleep(200);
  await client.call('run.cancel', { runId: run.id });
  await waitFor(() => events.some((e) => e.type === 'run.state' && e.runId === run.id && TERMINAL.includes(e.payload.state)), { label: 'the stopped run ended', timeoutMs: 10_000 });
  await Bun.sleep(2000);
  const others = [...new Set(events.filter((e) => e.type === 'run.state' && e.runId !== run.id).map((e) => e.runId))];
  const said = (await Promise.all(others.map(async (id) => (await Promise.all((await messagesOf(id)).filter((m) => m.role === 'assistant').map(text))).join('')))).join(' | ');
  expect(said).not.toContain('the rest of the stopped answer');
  expect(starts()).toHaveLength(1);
  expect(alive(starts()[0])).toBe(true);
}, 30_000);

test('while a background question waits for an answer the process is still read, however much it says meanwhile', async () => {
  const { client, events, runTo, messagesOf, text, starts } = await boot();
  const asked = [];
  client.onEvent((event) => { if (event.type === 'permission.requested') asked.push(event.payload.permissionId); });
  const launch = await runTo('launch', 'background-chatter 100 30000');
  await waitFor(() => asked.length === 1, { label: 'the subagent asked', timeoutMs: 5000 });
  await Bun.sleep(1500); // the main thread answers at length by itself while the question is open
  expect(alive(starts()[0])).toBe(true); // a reader stuck on the question would have let its queue overflow and the process die
  await client.call('permission.resolve', { permissionId: asked[0], decision: 'allow_once' });
  const reported = async () => {
    for (const id of [...new Set(events.filter((e) => e.type === 'run.state' && e.runId !== launch.id).map((e) => e.runId))]) {
      const said = (await Promise.all((await messagesOf(id)).filter((m) => m.role === 'assistant').map(text))).join('');
      if (said.includes('Background agent finished: allow')) return true;
    }
    return false;
  };
  await waitFor(reported, { label: 'the report after the answer', timeoutMs: 10_000 });
  expect(starts()).toHaveLength(1);
}, 30_000);

test('a background question the process takes back ends its run without an answer and leaves the process be', async () => {
  const { client, events, runTo, messagesOf, text, starts } = await boot();
  const asked = [];
  client.onEvent((event) => { if (event.type === 'permission.requested') asked.push(event.runId); });
  const launch = await runTo('launch', 'background-withdraw 100 300');
  await waitFor(() => asked.length === 1, { label: 'the subagent asked', timeoutMs: 5000 });
  await waitFor(() => events.some((e) => e.type === 'run.state' && e.runId === asked[0] && TERMINAL.includes(e.payload.state)), { label: 'the withdrawn question ended its run', timeoutMs: 5000 });
  const reported = async () => {
    for (const id of [...new Set(events.filter((e) => e.type === 'run.state' && ![launch.id, asked[0]].includes(e.runId)).map((e) => e.runId))]) {
      if ((await Promise.all((await messagesOf(id)).filter((m) => m.role === 'assistant').map(text))).join('') === 'Background agent finished: withdrawn') return true;
    }
    return false;
  };
  await waitFor(reported, { label: 'the report', timeoutMs: 5000 });
  expect(starts()).toHaveLength(1);
  expect(alive(starts()[0])).toBe(true);
}, 30_000);

test('a notice after an empty result that was the whole turn does not keep the run open', async () => {
  const { client, events, session } = await boot({ env: { JOLO_EMPTY_RESULT_GRACE_MS: '300' } });
  const { run } = await client.call('run.start', { sessionId: session.id, requestId: 'empty-only', prompt: 'zero-result-only' });
  await waitFor(() => events.some((e) => e.type === 'run.state' && e.runId === run.id && TERMINAL.includes(e.payload.state)), { label: 'the run ended', timeoutMs: 3000 });
  expect((await client.call('run.snapshot', { runId: run.id })).run.state).toBe('completed');
}, 30_000);

test('an answer that comes after a long compaction behind an empty result still belongs to the run', async () => {
  const { runTo, messagesOf, text } = await boot({ env: { JOLO_EMPTY_RESULT_GRACE_MS: '300' } });
  await runTo('hello', 'hello');
  const run = await runTo('compacted', 'zero-result-compact 900 after compacting');
  expect(run.state).toBe('completed');
  expect((await Promise.all((await messagesOf(run.id)).filter((m) => m.role === 'assistant').map(text))).join('')).toMatch(/after compacting$/);
}, 30_000);

test('a run paused on one of two questions asked together resumes once that one is allowed', async () => {
  const { engine, client, events, session } = await boot({ clientKind: 'headless' });
  const asked = [];
  client.onEvent((event) => { if (event.type === 'permission.requested') asked.push(event.payload.permissionId); });
  const { run } = await client.call('run.start', { sessionId: session.id, requestId: 'two-in-turn', prompt: 'two-in-turn' });
  await waitFor(() => events.some((e) => e.type === 'run.state' && e.runId === run.id && e.payload.state === 'paused'), { label: 'the run paused with nobody to ask', timeoutMs: 10_000 });
  const paused = events.find((e) => e.type === 'run.state' && e.runId === run.id && e.payload.state === 'paused').payload;
  expect(paused.pauseReason).toBe('permission');
  expect(asked).toHaveLength(2);
  // The question it did not pause on was turned down when it stopped: its prompt is closed, not left in the way.
  const other = asked.find((id) => id !== paused.permissionId);
  expect(events.some((e) => e.type === 'permission.resolved' && e.payload.permissionId === other)).toBe(true);
  const human = await engine.connect({ clientKind: 'tui' });
  await human.call('permission.resolve', { permissionId: paused.permissionId, decision: 'allow_once' });
  await waitFor(() => events.filter((e) => e.type === 'run.state' && e.runId === run.id).at(-1)?.payload.state !== 'paused', { label: 'the run resumed', timeoutMs: 5000 });
  await human.close();
}, 30_000);

test('a run held only by a question after its answer spends no active time while it waits', async () => {
  const booted = await boot();
  const { client, events, session } = booted;
  await client.call('settings.update', { budgets: { maxActiveMs: 1000 } });
  const asked = [];
  client.onEvent((event) => { if (event.type === 'permission.requested') asked.push(event); });
  const { run } = await client.call('run.start', { sessionId: session.id, requestId: 'ask-then-quiet', prompt: 'ask-then-quiet' });
  const stateOf = () => events.filter((e) => e.type === 'run.state' && e.runId === run.id).at(-1)?.payload.state;
  await waitFor(() => asked.length === 1, { label: 'the subagent asked', timeoutMs: 5000 });
  await Bun.sleep(2500); // well past the active-time budget, all of it spent waiting on the user
  expect(stateOf()).toBe('awaiting_permission');
  await client.call('permission.resolve', { permissionId: asked[0].payload.permissionId, decision: 'allow_once' });
  await waitFor(() => stateOf() === 'completed', { label: 'the run ended', timeoutMs: 5000 });
}, 30_000);

test('with nobody to ask, a run held only by a background question after its answer waits for a window', async () => {
  const { engine, client, events, session } = await boot({ clientKind: 'headless' });
  const asked = [];
  client.onEvent((event) => { if (event.type === 'permission.requested') asked.push(event); });
  const { run } = await client.call('run.start', { sessionId: session.id, requestId: 'ask-then-quiet', prompt: 'ask-then-quiet' });
  const stateOf = () => events.filter((e) => e.type === 'run.state' && e.runId === run.id).at(-1)?.payload.state;
  await waitFor(() => asked.length === 1, { label: 'the subagent asked', timeoutMs: 5000 });
  await Bun.sleep(1000);
  expect(stateOf()).toBe('awaiting_permission'); // not paused, and the subagent not denied
  const human = await engine.connect({ clientKind: 'tui' });
  await human.call('permission.resolve', { permissionId: asked[0].payload.permissionId, decision: 'allow_once' });
  await waitFor(() => stateOf() === 'completed', { label: 'the run ended', timeoutMs: 5000 });
  await human.close();
}, 30_000);

test('a run paused for its budget while a question is open closes that question and can be resumed', async () => {
  const { client, events, session } = await boot();
  await client.call('settings.update', { budgets: { maxActiveMs: 1000 } });
  const asked = [];
  client.onEvent((event) => { if (event.type === 'permission.requested') asked.push(event.payload.permissionId); });
  const { run } = await client.call('run.start', { sessionId: session.id, requestId: 'ask-and-work', prompt: 'ask-and-work' });
  await waitFor(() => events.some((e) => e.type === 'run.state' && e.runId === run.id && e.payload.state === 'paused'), { label: 'the run paused', timeoutMs: 10_000 });
  expect(events.find((e) => e.type === 'run.state' && e.runId === run.id && e.payload.state === 'paused').payload.pauseReason).toBe('budget');
  expect(asked).toHaveLength(1);
  expect(events.some((e) => e.type === 'permission.resolved' && e.payload.permissionId === asked[0])).toBe(true);
  await expect(client.call('run.resume', { runId: run.id })).resolves.toBeTruthy();
}, 30_000);

test('a command the main thread was allowed to run while another question is open counts against the budget', async () => {
  const { client, events, session } = await boot();
  await client.call('settings.update', { budgets: { maxActiveMs: 1000 } });
  const asked = [];
  client.onEvent((event) => { if (event.type === 'permission.requested') asked.push(event.payload); });
  const { run } = await client.call('run.start', { sessionId: session.id, requestId: 'main-asks', prompt: 'ask-then-main-asks' });
  await waitFor(() => asked.length === 2, { label: 'both asked', timeoutMs: 5000 });
  const main = asked.find((request) => request.summary?.includes('sleep 5') || JSON.stringify(request).includes('sleep 5'));
  expect(main).toBeTruthy();
  await client.call('permission.resolve', { permissionId: main.permissionId, decision: 'allow_once' });
  await waitFor(() => events.some((e) => e.type === 'run.state' && e.runId === run.id && e.payload.state === 'paused'), { label: 'the budget ran out during the command', timeoutMs: 4000 });
  expect(events.find((e) => e.type === 'run.state' && e.runId === run.id && e.payload.state === 'paused').payload.pauseReason).toBe('budget');
}, 30_000);

test('a run Claude began by itself that was paused for permission carries on once allowed', async () => {
  const { engine, client, events, runTo, messagesOf, text } = await boot({ clientKind: 'headless' });
  const launch = await runTo('launch', 'background-ask 100');
  await waitFor(() => events.some((e) => e.type === 'run.state' && e.runId !== launch.id && e.payload.state === 'paused'), { label: 'the continuation paused with nobody to ask', timeoutMs: 10_000 });
  const paused = events.find((e) => e.type === 'run.state' && e.runId !== launch.id && e.payload.state === 'paused');
  const human = await engine.connect({ clientKind: 'tui' });
  await human.call('permission.resolve', { permissionId: paused.payload.permissionId, decision: 'allow_once' });
  await waitFor(() => events.filter((e) => e.type === 'run.state' && e.runId === paused.runId).at(-1)?.payload.state === 'completed', { label: 'the resumed run ended', timeoutMs: 10_000 });
  const said = (await Promise.all((await messagesOf(paused.runId)).filter((m) => m.role === 'assistant').map(text))).join(' | ');
  expect(said).toContain('Carry on where you left off.'); // Claude was asked to go on, not left where the pause stopped it
  await human.close();
}, 30_000);

test('a turn the process begins during the grace after a run that was only an empty result gets a run of its own', async () => {
  const booted = await boot();
  const { client, events, session, messagesOf, text } = booted;
  const { run } = await client.call('run.start', { sessionId: session.id, requestId: 'empty-then-self', prompt: 'zero-result-then-self' });
  await waitFor(() => events.some((e) => e.type === 'run.state' && e.runId === run.id && TERMINAL.includes(e.payload.state)), { label: 'the run ended well inside the grace', timeoutMs: 5000 });
  expect((await client.call('run.snapshot', { runId: run.id })).run.state).toBe('completed');
  expect((await Promise.all((await messagesOf(run.id)).filter((m) => m.role === 'assistant').map(text))).join('')).toBe('');
  const reported = async () => {
    for (const id of [...new Set(events.filter((e) => e.type === 'run.state' && e.runId !== run.id).map((e) => e.runId))]) {
      if ((await Promise.all((await messagesOf(id)).filter((m) => m.role === 'assistant').map(text))).join('') === 'Background report.') return true;
    }
    return false;
  };
  await waitFor(reported, { label: 'the report as a run of its own', timeoutMs: 5000 });
}, 30_000);

test('a run waiting on one of two questions of the main thread spends no active time once the other one\'s tool is done', async () => {
  const { client, events, session } = await boot();
  await client.call('settings.update', { budgets: { maxActiveMs: 1000 } });
  const asked = [];
  client.onEvent((event) => { if (event.type === 'permission.requested') asked.push(event.payload); });
  const { run } = await client.call('run.start', { sessionId: session.id, requestId: 'two-main-asks', prompt: 'two-main-asks' });
  const stateOf = () => events.filter((e) => e.type === 'run.state' && e.runId === run.id).at(-1)?.payload.state;
  await waitFor(() => asked.length === 2, { label: 'both asked', timeoutMs: 5000 });
  const first = asked.find((request) => JSON.stringify(request).includes('one.example'));
  const second = asked.find((request) => JSON.stringify(request).includes('two.example'));
  await client.call('permission.resolve', { permissionId: first.permissionId, decision: 'allow_once' });
  await Bun.sleep(2500); // the first fetch is long done; the main thread only waits on the second question
  expect(stateOf()).toBe('awaiting_permission');
  await client.call('permission.resolve', { permissionId: second.permissionId, decision: 'allow_once' });
  await waitFor(() => stateOf() === 'completed', { label: 'the run ended', timeoutMs: 5000 });
}, 30_000);

test('a turn the process begins while a run waits on a question counts against that run\'s budget', async () => {
  const { client, events, session } = await boot();
  await client.call('settings.update', { budgets: { maxActiveMs: 1000 } });
  const { run } = await client.call('run.start', { sessionId: session.id, requestId: 'slow-turn', prompt: 'ask-then-slow-turn' });
  await waitFor(() => events.some((e) => e.type === 'run.state' && e.runId === run.id && e.payload.state === 'paused'), { label: 'the budget ran out while the new turn thought', timeoutMs: 5000 });
  expect(events.find((e) => e.type === 'run.state' && e.runId === run.id && e.payload.state === 'paused').payload.pauseReason).toBe('budget');
}, 30_000);

test('refusing one of two questions of the main thread leaves it waiting on the other, at no cost', async () => {
  const { client, events, session } = await boot();
  await client.call('settings.update', { budgets: { maxActiveMs: 1000 } });
  const asked = [];
  client.onEvent((event) => { if (event.type === 'permission.requested') asked.push(event.payload); });
  const { run } = await client.call('run.start', { sessionId: session.id, requestId: 'two-main-asks', prompt: 'two-main-asks' });
  const stateOf = () => events.filter((e) => e.type === 'run.state' && e.runId === run.id).at(-1)?.payload.state;
  await waitFor(() => asked.length === 2, { label: 'both asked', timeoutMs: 5000 });
  const first = asked.find((request) => JSON.stringify(request).includes('one.example'));
  const second = asked.find((request) => JSON.stringify(request).includes('two.example'));
  await client.call('permission.resolve', { permissionId: first.permissionId, decision: 'deny' });
  await Bun.sleep(2500); // the main thread does not go back to the model: it waits on the second question
  expect(stateOf()).toBe('awaiting_permission');
  await client.call('permission.resolve', { permissionId: second.permissionId, decision: 'allow_once' });
  await waitFor(() => stateOf() === 'completed', { label: 'the run ended', timeoutMs: 5000 });
}, 30_000);

test('a command the main thread runs without asking still counts while a background question is open', async () => {
  const { client, events, session } = await boot();
  await client.call('settings.update', { budgets: { maxActiveMs: 1000 } });
  const { run } = await client.call('run.start', { sessionId: session.id, requestId: 'work-bg-ask', prompt: 'work-then-bg-ask' });
  await waitFor(() => events.some((e) => e.type === 'run.state' && e.runId === run.id && e.payload.state === 'paused'), { label: 'the budget ran out during the command', timeoutMs: 4000 });
  expect(events.find((e) => e.type === 'run.state' && e.runId === run.id && e.payload.state === 'paused').payload.pauseReason).toBe('budget');
}, 30_000);

test('a turn the process begins beside an open question is not counted as a model call before it makes one', async () => {
  const { client, events, session } = await boot();
  // Two model calls are the run's own (before and after the subagent asked) and one is the turn the process begins.
  // That turn's call counts once, when it is made, not also when the turn begins.
  await client.call('settings.update', { budgets: { maxIterations: 3 } });
  const asked = [];
  client.onEvent((event) => { if (event.type === 'permission.requested') asked.push(event.payload); });
  const { run } = await client.call('run.start', { sessionId: session.id, requestId: 'slow-turn-iterations', prompt: 'ask-then-slow-turn' });
  const stateOf = () => events.filter((e) => e.type === 'run.state' && e.runId === run.id).at(-1)?.payload.state;
  await waitFor(() => asked.length === 1, { label: 'the subagent asked', timeoutMs: 5000 });
  await Bun.sleep(1000); // the process's own turn has begun and is thinking
  expect(stateOf()).toBe('awaiting_permission');
  await client.call('permission.resolve', { permissionId: asked[0].permissionId, decision: 'allow_once' });
  await waitFor(() => TERMINAL.includes(stateOf()), { label: 'the run ended', timeoutMs: 10_000 });
  expect(stateOf()).toBe('completed');
}, 30_000);

test('a slash command Claude answers without the model ends with its empty result, without waiting for more', async () => {
  const { runTo } = await boot();
  await runTo('hello', 'hello');
  const started = Date.now();
  const run = await runTo('cost', '/cost');
  expect(run.state).toBe('completed');
  expect(Date.now() - started).toBeLessThan(5000); // not the empty-result grace that waits for an answer after it
}, 30_000);

test('what Claude replays after compacting is not shown again as the run\'s answer', async () => {
  const { runTo, messagesOf, text } = await boot();
  await runTo('hello', 'hello');
  const run = await runTo('compacted', 'compact-then-answer');
  expect(run.state).toBe('completed');
  expect((await Promise.all((await messagesOf(run.id)).filter((m) => m.role === 'assistant').map(text))).join(' | ')).toBe('The fresh answer.');
}, 30_000);

test('a turn Claude begins by itself shows no message from the user, only its answer', async () => {
  const { client, events, session, runTo, messagesOf, text } = await boot();
  const launch = await runTo('launch', 'background 150 finished in the background');
  const own = async () => {
    for (const id of [...new Set(events.filter((e) => e.type === 'run.state' && e.runId !== launch.id).map((e) => e.runId))]) {
      if ((await client.call('run.snapshot', { runId: id })).run.state === 'completed') return id;
    }
    return null;
  };
  await waitFor(own, { label: 'Claude carried on', timeoutMs: 5000 });
  const id = await own();
  const messages = await messagesOf(id);
  expect(messages.filter((m) => m.role === 'user')).toEqual([]);
  expect((await Promise.all(messages.filter((m) => m.role === 'assistant').map(text))).join('')).toBe('finished in the background');
  const page = await client.call('session.page', { sessionId: session.id });
  expect(page.runs.find((run) => run.id === id).prompt).toBe('');
  expect(page.messages.filter((m) => m.runId === id && m.role === 'user')).toEqual([]);
  expect((await client.call('session.get', { sessionId: session.id }).catch(() => ({ session: page.session }))).session.title).not.toMatch(/carried on/);
}, 30_000);

test('stopping a turn leaves the background work running until it is stopped itself, and the next message is answered', async () => {
  const { client, events, session, runTo, messagesOf, text, starts } = await boot();
  await runTo('launch', 'tasks 1 2500');
  const { run } = await client.call('run.start', { sessionId: session.id, requestId: 'stopped', prompt: 'slow 5000 never shown' });
  await waitFor(() => events.some((e) => e.type === 'run.state' && e.runId === run.id && e.payload.state === 'model'), { label: 'the turn is under way', timeoutMs: 5000 });
  await Bun.sleep(300);
  await client.call('run.cancel', { runId: run.id });
  await waitFor(() => events.some((e) => e.type === 'run.state' && e.runId === run.id && e.payload.state === 'cancelled'), { label: 'stopped', timeoutMs: 5000 });
  expect((await client.call('session.activity', { sessionId: session.id })).activity.tasks.map((t) => t.status)).toEqual(['running']); // Stop spared it
  expect(await client.call('session.stopBackground', { sessionId: session.id })).toEqual({ requested: 1, stopped: 1, escalated: false });
  await Bun.sleep(2500); // past when the background work would have reported
  expect(new Set(events.filter((e) => e.type === 'run.state').map((e) => e.runId)).size).toBe(2); // no report: the work was stopped
  const next = await runTo('next', 'hello');
  expect((await Promise.all((await messagesOf(next.id)).filter((m) => m.role === 'assistant').map(text))).join('')).toMatch(/: hello$/);
  expect(starts()).toHaveLength(1); // the same process answers on
}, 30_000);

test('a Jolo call made by a background agent\'s own subagent reports back and releases its run', async () => {
  const { events, runTo } = await boot();
  const launch = await runTo('launch', 'nested-background-jolo');
  await waitFor(() => events.some((e) => e.type === 'run.state' && e.runId !== launch.id), { label: 'a run for the nested agent', timeoutMs: 5000 });
  const holder = events.find((e) => e.type === 'run.state' && e.runId !== launch.id).runId;
  await waitFor(() => events.some((e) => e.type === 'run.state' && e.runId === holder && e.payload.state === 'completed'), { label: 'the run ended once the nested call reported', timeoutMs: 5000 });
}, 30_000);

test('a run that allowed one of Jolo\'s own tools stays live until the call reports back', async () => {
  const booted = await boot();
  const { client, events, runTo } = booted;
  const launch = await runTo('launch', 'background-jolo 800');
  // The subagent's question is allowed at once (Jolo's own tools never ask the user); the call then runs for a while.
  await waitFor(() => events.some((e) => e.type === 'run.state' && e.runId !== launch.id), { label: 'a run for the subagent', timeoutMs: 5000 });
  const holder = events.find((e) => e.type === 'run.state' && e.runId !== launch.id).runId;
  await Bun.sleep(400);
  expect(TERMINAL.includes(events.filter((e) => e.type === 'run.state' && e.runId === holder).at(-1)?.payload.state)).toBe(false); // the call can still find its run
  await waitFor(() => events.some((e) => e.type === 'run.state' && e.runId === holder && e.payload.state === 'completed'), { label: 'the run ended once the call reported', timeoutMs: 5000 });
  void client;
}, 30_000);

test('with no window open, the engine stays up while an agent\'s background work runs, and stops once it is done', async () => {
  const { engine, client, runTo } = await boot({ idleMs: 500 });
  await runTo('launch', 'background 2500 finished in the background');
  await client.close(); // the window closes; nothing else holds the engine
  await Bun.sleep(1500);
  expect(engine.child.exitCode).toBeNull(); // still up: the background work would die with it
  await waitFor(() => engine.child.exitCode !== null, { label: 'the engine stopped after the work ended', timeoutMs: 10_000 });
}, 30_000);

test('a question from background work while Claude is idle gets a short run, whoever asks', async () => {
  const booted = await boot();
  const { client, events, runTo, messagesOf, text } = booted;
  const asked = [];
  client.onEvent((event) => { if (event.type === 'permission.requested') asked.push(event); });
  const launch = await runTo('launch', 'background-net');
  await waitFor(() => asked.length === 1, { label: 'the sandbox asked', timeoutMs: 5000 });
  const holder = asked[0].runId;
  await client.call('permission.resolve', { permissionId: asked[0].payload.permissionId, decision: 'allow_once' });
  await waitFor(() => events.some((e) => e.type === 'run.state' && e.runId === holder && e.payload.state === 'completed'), { label: 'the question run ended once answered', timeoutMs: 3000 });
  const reported = async () => {
    for (const id of [...new Set(events.filter((e) => e.type === 'run.state' && ![launch.id, holder].includes(e.runId)).map((e) => e.runId))]) {
      if ((await Promise.all((await messagesOf(id)).filter((m) => m.role === 'assistant').map(text))).join('') === 'Network access: allow') return true;
    }
    return false;
  };
  await waitFor(reported, { label: 'the server reported back', timeoutMs: 5000 });
}, 30_000);

describe('budgets and pauses count work, not waiting on the user', () => {
  /** @param {string} prompt @param {any} budgets @param {{ clientKind?: string }} [options] */
  const budgetRun = async (prompt, budgets, { clientKind } = {}) => {
    const booted = await boot(clientKind ? { clientKind } : {});
    await booted.client.call('settings.update', { budgets });
    const asked = [];
    booted.client.onEvent((event) => { if (event.type === 'permission.requested') asked.push(event); });
    const { run } = await booted.client.call('run.start', { sessionId: booted.session.id, requestId: prompt, prompt });
    const states = () => booted.events.filter((e) => e.type === 'run.state' && e.runId === run.id).map((e) => e.payload);
    return { ...booted, run, asked, states, stateOf: () => states().at(-1)?.state };
  };

  test('a foreground subagent waiting on the user costs no active time', async () => {
    const { client, asked, stateOf } = await budgetRun('foreground-agent-asks', { maxActiveMs: 1000 });
    await waitFor(() => asked.length === 1, { label: 'the subagent asked', timeoutMs: 5000 });
    await Bun.sleep(2500);
    expect(stateOf()).toBe('awaiting_permission');
    await client.call('permission.resolve', { permissionId: asked[0].payload.permissionId, decision: 'allow_once' });
    await waitFor(() => stateOf() === 'completed', { label: 'the run ended', timeoutMs: 5000 });
  }, 30_000);

  test('a command waiting behind one that asks is waiting on the user too', async () => {
    const { client, asked, stateOf } = await budgetRun('two-tools-one-asks', { maxActiveMs: 1000 });
    await waitFor(() => asked.length === 1, { label: 'the first command asked', timeoutMs: 5000 });
    await Bun.sleep(2500);
    expect(stateOf()).toBe('awaiting_permission');
    await client.call('permission.resolve', { permissionId: asked[0].payload.permissionId, decision: 'allow_once' });
    await waitFor(() => stateOf() === 'completed', { label: 'the run ended', timeoutMs: 5000 });
  }, 30_000);

  test('a model still streaming after one of its commands asked is still working', async () => {
    const { asked, states } = await budgetRun('ask-while-streaming', { maxActiveMs: 1000 });
    await waitFor(() => asked.length === 1, { label: 'the command asked', timeoutMs: 5000 });
    await waitFor(() => states().some((s) => s.state === 'paused'), { label: 'the budget ran out while the model streamed', timeoutMs: 4000 });
    expect(states().find((s) => s.state === 'paused').pauseReason).toBe('budget');
  }, 30_000);

  test('with nobody to ask, background work\'s question does not pause a main thread that is working', async () => {
    const { engine, asked, stateOf } = await budgetRun('ask-and-work', { maxActiveMs: 60_000 }, { clientKind: 'headless' });
    await waitFor(() => asked.length === 1, { label: 'the subagent asked', timeoutMs: 5000 });
    await Bun.sleep(1500);
    expect(stateOf()).toBe('awaiting_permission'); // still working, not paused
    const human = await engine.connect({ clientKind: 'tui' });
    await human.call('permission.resolve', { permissionId: asked[0].payload.permissionId, decision: 'allow_once' });
    await waitFor(() => stateOf() === 'completed', { label: 'the run ended', timeoutMs: 10_000 });
    await human.close();
  }, 30_000);

  test('model calls that only use tools count against the iteration budget', async () => {
    const { states } = await budgetRun('tool-loop', { maxIterations: 2 });
    await waitFor(() => states().some((s) => s.state === 'paused'), { label: 'the iteration budget ran out', timeoutMs: 5000 });
    expect(states().find((s) => s.state === 'paused').failure ?? '').toMatch(/iteration/);
  }, 30_000);

  test('each model call counts once: as many calls as the budget allows still finish', async () => {
    const { stateOf } = await budgetRun('tool-loop', { maxIterations: 4 }); // three calls that read, then the answer
    await waitFor(() => ['completed', 'paused'].includes(stateOf()), { label: 'the run ended', timeoutMs: 8000 });
    expect(stateOf()).toBe('completed');
  }, 30_000);

  test('a question opened and answered partway through a model call does not count that call again', async () => {
    const { client, asked, stateOf } = await budgetRun('ask-mid-call', { maxIterations: 1 });
    await waitFor(() => asked.length === 1, { label: 'background work asked', timeoutMs: 5000 });
    await client.call('permission.resolve', { permissionId: asked[0].payload.permissionId, decision: 'allow_once' });
    await waitFor(() => ['completed', 'paused'].includes(stateOf()), { label: 'the run ended', timeoutMs: 8000 });
    expect(stateOf()).toBe('completed');
  }, 30_000);

  test('a call the binary dropped does not hold a tool deadline over the rest of the turn', async () => {
    const { stateOf } = await budgetRun('lost-tool', { hostedToolDeadlineMs: 1000 });
    await waitFor(() => ['completed', 'paused'].includes(stateOf()), { label: 'the run ended', timeoutMs: 8000 });
    expect(stateOf()).toBe('completed');
  }, 30_000);

  test('allowing one question for the project answers the others it covers', async () => {
    const { client, events, asked, stateOf } = await budgetRun('two-main-asks', {});
    await waitFor(() => asked.length === 2, { label: 'both asked', timeoutMs: 5000 });
    await client.call('permission.resolve', { permissionId: asked[0].payload.permissionId, decision: 'allow_project' });
    await waitFor(() => events.some((e) => e.type === 'permission.resolved' && e.payload.permissionId === asked[1].payload.permissionId), { label: 'the other question was answered too', timeoutMs: 3000 });
    await waitFor(() => stateOf() === 'completed', { label: 'the run ended without asking again', timeoutMs: 5000 });
  }, 30_000);

  test('allowing background work for this run covers that work\'s next identical request', async () => {
    const booted = await boot();
    const asked = [];
    booted.client.onEvent((event) => { if (event.type === 'permission.requested') asked.push(event); });
    const launch = await booted.runTo('launch', 'background-asks-twice');
    await waitFor(() => asked.length === 1, { label: 'the background work asked', timeoutMs: 5000 });
    await booted.client.call('permission.resolve', { permissionId: asked[0].payload.permissionId, decision: 'allow_run' });
    const reported = async () => {
      for (const id of [...new Set(booted.events.filter((e) => e.type === 'run.state' && e.runId !== launch.id).map((e) => e.runId))]) {
        if ((await Promise.all((await booted.messagesOf(id)).filter((m) => m.role === 'assistant').map(booted.text))).join('') === 'Background agent finished: allow, allow') return true;
      }
      return false;
    };
    await waitFor(reported, { label: 'both requests allowed', timeoutMs: 5000 });
    expect(asked).toHaveLength(1); // the second was not asked again
  }, 30_000);

  test('with nobody to ask, a turn the process begins inside a run held for a question pauses on its own question', async () => {
    const { states } = await budgetRun('ask-then-main-turn-asks', {}, { clientKind: 'headless' });
    await waitFor(() => states().some((s) => s.state === 'paused'), { label: 'the run paused on the new turn\'s question', timeoutMs: 5000 });
    expect(states().find((s) => s.state === 'paused').pauseReason).toBe('permission');
  }, 30_000);

  test('a subagent\'s own subagent waiting on the user costs no active time', async () => {
    const { client, asked, stateOf } = await budgetRun('nested-agent-asks', { maxActiveMs: 1000 });
    await waitFor(() => asked.length === 1, { label: 'the nested subagent asked', timeoutMs: 5000 });
    await Bun.sleep(2500);
    expect(stateOf()).toBe('awaiting_permission');
    await client.call('permission.resolve', { permissionId: asked[0].payload.permissionId, decision: 'allow_once' });
    await waitFor(() => stateOf() === 'completed', { label: 'the run ended', timeoutMs: 5000 });
  }, 30_000);

  for (const nested of [false, true]) {
    test(`background work asking${nested ? ' through a subagent of its own' : ''} while a foreground subagent works on does not stop the clock`, async () => {
      const { asked, states } = await budgetRun(`bg-ask-beside-fg-work${nested ? ' nested' : ''}`, { maxActiveMs: 1000 });
      await waitFor(() => asked.length === 1, { label: 'the background work asked', timeoutMs: 5000 });
      await waitFor(() => states().some((s) => s.state === 'paused'), { label: 'the budget ran out while the subagent worked', timeoutMs: 4000 });
      expect(states().find((s) => s.state === 'paused').pauseReason).toBe('budget');
    }, 30_000);
  }

  test('one foreground subagent asking while another works on is still work', async () => {
    const { asked, states } = await budgetRun('fg-ask-beside-fg-work', { maxActiveMs: 1000 });
    await waitFor(() => asked.length === 1, { label: 'the first subagent asked', timeoutMs: 5000 });
    await waitFor(() => states().some((s) => s.state === 'paused'), { label: 'the budget ran out while the second worked', timeoutMs: 4000 });
    expect(states().find((s) => s.state === 'paused').pauseReason).toBe('budget');
  }, 30_000);

  test('with nobody to ask, a run pauses on the main thread\'s own question, not a background one', async () => {
    const { states, asked } = await budgetRun('main-then-background-asks', {}, { clientKind: 'headless' });
    await waitFor(() => states().some((s) => s.state === 'paused'), { label: 'the run paused', timeoutMs: 5000 });
    const paused = states().find((s) => s.state === 'paused');
    const main = asked.find((event) => JSON.stringify(event.payload).includes('echo main'));
    expect(paused.permissionId).toBe(main.payload.permissionId);
  }, 30_000);
});

test('allowing a foreground subagent for this run covers the run, and only this run', async () => {
  const { client, runTo, messagesOf, text } = await boot();
  const asked = [];
  client.onEvent((event) => {
    if (event.type !== 'permission.requested') return;
    asked.push(event);
    void client.call('permission.resolve', { permissionId: event.payload.permissionId, decision: 'allow_run' });
  });
  const first = await runTo('first', 'fg-ask-twice');
  expect(asked).toHaveLength(1); // the main thread's identical request beside it was covered within the run
  const said = async (run) => (await Promise.all((await messagesOf(run.id)).filter((m) => m.role === 'assistant').map(text))).join('');
  expect(await said(first)).toBe('Asked: allow, allow');
  const second = await runTo('second', 'fg-ask-twice');
  expect(asked).toHaveLength(2); // the next run asks again
  expect(await said(second)).toBe('Asked: allow, allow');
}, 30_000);

test('allowing background work for this run covers the helpers it runs, but not another background agent', async () => {
  const booted = await boot();
  const asked = [];
  booted.client.onEvent((event) => {
    if (event.type !== 'permission.requested') return;
    asked.push(event);
    void booted.client.call('permission.resolve', { permissionId: event.payload.permissionId, decision: asked.length === 1 ? 'allow_run' : 'allow_once' });
  });
  const launch = await booted.runTo('launch', 'background-scopes');
  const reported = async () => {
    for (const id of [...new Set(booted.events.filter((e) => e.type === 'run.state' && e.runId !== launch.id).map((e) => e.runId))]) {
      if ((await Promise.all((await booted.messagesOf(id)).filter((m) => m.role === 'assistant').map(booted.text))).join('') === 'Agents finished: allow, allow, allow') return true;
    }
    return false;
  };
  await waitFor(reported, { label: 'every agent was answered', timeoutMs: 8000 });
  expect(asked).toHaveLength(2); // the helper was covered; the other agent was asked itself
}, 30_000);

test('a background agent launched in an earlier turn, asking beside a working foreground subagent, does not stop the clock', async () => {
  const booted = await boot();
  const asked = [];
  booted.client.onEvent((event) => { if (event.type === 'permission.requested') asked.push(event); });
  await booted.runTo('launch', 'launch-bg-agent');
  await booted.client.call('settings.update', { budgets: { maxActiveMs: 1000 } });
  const { run } = await booted.client.call('run.start', { sessionId: booted.session.id, requestId: 'work', prompt: 'fg-work-then-old-bg-asks' });
  const states = () => booted.events.filter((e) => e.type === 'run.state' && e.runId === run.id).map((e) => e.payload);
  await waitFor(() => asked.length === 1, { label: 'the earlier background agent asked', timeoutMs: 5000 });
  await waitFor(() => states().some((s) => s.state === 'paused'), { label: 'the budget ran out while the subagent worked', timeoutMs: 4000 });
  expect(states().find((s) => s.state === 'paused').pauseReason).toBe('budget');
}, 30_000);

test('a standing answer resumes the other runs paused on the question it answered', async () => {
  const booted = await boot({ clientKind: 'headless' });
  const { client, events, project } = booted;
  const other = (await client.call('session.create', { projectId: project.projectId, workspaceId: project.workspaceId, title: 'other', agentId: 'claude' })).session;
  const paused = (runId) => events.some((e) => e.type === 'run.state' && e.runId === runId && e.payload.state === 'paused');
  const one = (await client.call('run.start', { sessionId: booted.session.id, requestId: 'one', prompt: 'run echo shared' })).run;
  await waitFor(() => paused(one.id), { label: 'the first run paused', timeoutMs: 8000 });
  const two = (await client.call('run.start', { sessionId: other.id, requestId: 'two', prompt: 'run echo shared' })).run;
  await waitFor(() => paused(two.id), { label: 'the second run paused', timeoutMs: 8000 });
  const human = await booted.engine.connect({ clientKind: 'tui' });
  const first = events.find((e) => e.type === 'run.state' && e.runId === one.id && e.payload.state === 'paused').payload.permissionId;
  await human.call('permission.resolve', { permissionId: first, decision: 'allow_project' });
  const completed = (runId) => events.some((e) => e.type === 'run.state' && e.runId === runId && e.payload.state === 'completed');
  await waitFor(() => completed(one.id) && completed(two.id), { label: 'both runs went on', timeoutMs: 10_000 });
  await human.close();
}, 30_000);

test('a message the user\'s own hook blocks right after a turn the process began by itself still shows the reason', async () => {
  const { runTo, messagesOf, text } = await boot();
  await runTo('hello', 'hello');
  const run = await runTo('blocked', 'race-self-blocked');
  expect(run.state).toBe('completed');
  const said = (await Promise.all((await messagesOf(run.id)).filter((m) => m.role === 'assistant').map(text))).join(' | ');
  expect(said).toContain('A background task finished first.');
  expect(said).toContain('Blocked by your hook: the message contains a secret.');
}, 30_000);

test('a message the user\'s own hook blocks ends at once, with the reason', async () => {
  const { runTo, messagesOf, text } = await boot();
  await runTo('hello', 'hello');
  const started = Date.now();
  const run = await runTo('blocked', 'hook-blocked');
  expect(Date.now() - started).toBeLessThan(5000); // not the grace kept for an answer that follows an empty result
  expect(run.state).toBe('completed');
  expect((await Promise.all((await messagesOf(run.id)).filter((m) => m.role === 'assistant').map(text))).join('')).toBe('Blocked by your hook: the message contains a secret.');
}, 30_000);

test('a run that only answered background work\'s question, by policy, finishes quietly', async () => {
  const { events, runTo } = await boot();
  const launch = await runTo('launch', 'background-read');
  await waitFor(() => events.some((e) => e.type === 'run.state' && e.runId !== launch.id && e.payload.state === 'completed'), { label: 'the question run ended', timeoutMs: 5000 });
  const ended = events.find((e) => e.type === 'run.state' && e.runId !== launch.id && e.payload.state === 'completed');
  expect(ended.payload.quiet).toBe(true);
  expect(events.find((e) => e.type === 'run.state' && e.runId === launch.id && e.payload.state === 'completed').payload.quiet).toBeUndefined();
}, 30_000);

describe('slash commands and the task\'s own choices inside a kept process', () => {
  test('a local command\'s output is shown once, and not again by the compaction after it', async () => {
    const { runTo, messagesOf, text } = await boot();
    await runTo('hello', 'hello');
    const cost = await runTo('cost', '/cost');
    expect((await Promise.all((await messagesOf(cost.id)).filter((m) => m.role === 'assistant').map(text))).join(' | ')).toBe('Total cost: $0.0042');
    const compacted = await runTo('compact', '/compact');
    expect((await Promise.all((await messagesOf(compacted.id)).filter((m) => m.role === 'assistant').map(text))).join(' | ')).toBe('Context compacted.');
  }, 30_000);

  test('a run that made no model call reports no context size of its own', async () => {
    const { client, runTo } = await boot();
    await runTo('hello', 'hello');
    const cost = await runTo('cost', '/cost');
    expect((await client.call('run.snapshot', { runId: cost.id })).run.usage.contextWindow ?? null).toBeNull();
  }, 30_000);

  test('Claude\'s own /model is answered by Jolo, pointing to its model menu, and never reaches the process', async () => {
    const { runTo, messagesOf, text, starts } = await boot();
    const run = await runTo('model', '/model sonnet');
    expect(run.state).toBe('completed');
    expect((await Promise.all((await messagesOf(run.id)).filter((m) => m.role === 'assistant').map(text))).join('')).toMatch(/model menu in Jolo/);
    expect(starts()).toHaveLength(0);
  }, 30_000);

  test('asking Claude for /model after picking another model leaves the work its process runs alone', async () => {
    // The model is passed on the command line, so another model means another process.
    const { client, events, session, runTo, messagesOf, text, starts } = await boot({ manifest: { modelArgs: ['--model', '{model}'] } });
    const launch = await runTo('launch', 'background 1500 finished in the background');
    const { session: current } = await client.call('session.page', { sessionId: session.id });
    await client.call('session.setAgentModel', { sessionId: session.id, model: 'fable', effort: null, expectedRevision: current.revision });
    const asked = await runTo('model', '/model');
    expect(asked.state).toBe('completed');
    expect(alive(starts()[0])).toBe(true); // the background work is still running
    const reported = async () => {
      for (const id of [...new Set(events.filter((e) => e.type === 'run.state' && ![launch.id, asked.id].includes(e.runId)).map((e) => e.runId))]) {
        if ((await Promise.all((await messagesOf(id)).filter((m) => m.role === 'assistant').map(text))).join('') === 'finished in the background') return true;
      }
      return false;
    };
    await waitFor(reported, { label: 'the background work reported back', timeoutMs: 8000 });
  }, 30_000);

  test('a turn Claude begins by itself runs on the model the user picked for the task', async () => {
    const { client, events, session, runTo } = await boot();
    await client.call('session.setAgentModel', { sessionId: session.id, model: 'fable', effort: null, expectedRevision: session.revision });
    const launch = await runTo('launch', 'background 150 finished in the background');
    await waitFor(() => events.some((e) => e.type === 'run.state' && e.runId !== launch.id && e.payload.state === 'completed'), { label: 'Claude carried on', timeoutMs: 5000 });
    const own = events.find((e) => e.type === 'run.state' && e.runId !== launch.id).runId;
    expect((await client.call('run.snapshot', { runId: own })).run.execution?.model).toBe('fable');
  }, 30_000);

  test('removing a folder closes the agent processes of the tasks it archives', async () => {
    const { client, project, runTo, starts } = await boot();
    await runTo('hello', 'hello');
    expect(alive(starts()[0])).toBe(true);
    await client.call('project.remove', { projectId: project.projectId });
    await waitFor(() => !alive(starts()[0]), { label: 'the process closed with its task', timeoutMs: 5000 });
  }, 30_000);
});


describe("Claude's questions to the person reach Jolo as dialogs", () => {
  test('a question Claude asks the person reaches Jolo as a dialog and the answer goes back', async () => {
    const { client, events, session, messagesOf, text } = await boot();
    const { run } = await client.call('run.start', { sessionId: session.id, requestId: 'ask', prompt: 'ask-user tea or coffee?' });
    const asked = await waitFor(() => events.find(e => e.type === 'dialog.requested' && e.runId === run.id), { label: 'dialog requested' });
    expect(asked.payload.tool).toBe('AskUserQuestion');
    expect(asked.payload.input.questions[0].question).toBe('tea or coffee?');
    expect(events.some(e => e.type === 'permission.requested' && e.runId === run.id)).toBe(false);
    expect((await client.call('run.snapshot', { runId: run.id })).run.state).toBe('awaiting_permission');
    await client.call('dialog.resolve', { dialogId: asked.payload.dialogId, response: { answers: { 'tea or coffee?': 'coffee' } } });
    await waitFor(() => events.some(e => e.type === 'run.state' && e.runId === run.id && e.payload.state === 'completed'), { label: 'completed' });
    expect(await text((await messagesOf(run.id)).at(-1))).toBe('You answered: coffee');
  }, 30_000);

  test('a plan approval Claude asks for reaches Jolo as a dialog and approving it lets Claude go on', async () => {
    const { client, events, session, messagesOf, text } = await boot();
    const { run } = await client.call('run.start', { sessionId: session.id, requestId: 'plan', prompt: 'exit-plan Ship it' });
    const asked = await waitFor(() => events.find(e => e.type === 'dialog.requested' && e.runId === run.id), { label: 'dialog requested' });
    expect(asked.payload.tool).toBe('ExitPlanMode');
    expect(asked.payload.input.plan.startsWith('# Ship it')).toBe(true);
    await client.call('dialog.resolve', { dialogId: asked.payload.dialogId, response: {} });
    await waitFor(() => events.some(e => e.type === 'run.state' && e.runId === run.id && e.payload.state === 'completed'), { label: 'completed' });
    expect(await text((await messagesOf(run.id)).at(-1))).toBe('Plan approved: Ship it');
  }, 30_000);

  test('a client that opens the conversation while a question is still waiting finds it in pendingDialogs until it is answered', async () => {
    const { client, events, session } = await boot();
    const { run } = await client.call('run.start', { sessionId: session.id, requestId: 'ask-page', prompt: 'ask-user tea or coffee?' });
    const asked = await waitFor(() => events.find(e => e.type === 'dialog.requested' && e.runId === run.id), { label: 'dialog requested' });
    expect((await client.call('session.page', { sessionId: session.id })).pendingDialogs).toEqual([asked.payload]);
    await client.call('dialog.resolve', { dialogId: asked.payload.dialogId, response: { answers: { 'tea or coffee?': 'coffee' } } });
    expect((await client.call('session.page', { sessionId: session.id })).pendingDialogs).toEqual([]);
  }, 30_000);

  test('dismissing a dialog tells Claude the person did not answer', async () => {
    const { client, events, session, messagesOf, text } = await boot();
    const { run } = await client.call('run.start', { sessionId: session.id, requestId: 'ask-dismiss', prompt: 'ask-user tea or coffee?' });
    const asked = await waitFor(() => events.find(e => e.type === 'dialog.requested' && e.runId === run.id), { label: 'dialog requested' });
    await client.call('dialog.dismiss', { dialogId: asked.payload.dialogId, message: 'Not now.' });
    await waitFor(() => events.some(e => e.type === 'run.state' && e.runId === run.id && e.payload.state === 'completed'), { label: 'completed' });
    expect(await text((await messagesOf(run.id)).at(-1))).toBe('No answer: Not now.');
  }, 30_000);

  test('stopping a run with a dialog open cancels the dialog and answers Claude exactly once', async () => {
    const { client, events, session, runTo, starts } = await boot();
    const { run } = await client.call('run.start', { sessionId: session.id, requestId: 'ask-stop', prompt: 'ask-user tea or coffee?' });
    const asked = await waitFor(() => events.find(e => e.type === 'dialog.requested' && e.runId === run.id), { label: 'dialog requested' });
    await client.call('run.cancel', { runId: run.id });
    await waitFor(() => events.some(e => e.type === 'dialog.resolved' && e.payload.dialogId === asked.payload.dialogId && e.payload.state === 'cancelled'), { label: 'dialog cancelled' });
    await waitFor(() => events.some(e => e.type === 'run.state' && e.runId === run.id && e.payload.state === 'cancelled'), { label: 'run cancelled' });
    await expect(client.call('dialog.resolve', { dialogId: asked.payload.dialogId, response: {} })).rejects.toMatchObject({ code: 'conflict' });
    // A second answer to the question would have made Claude leave; the same process answers the next message.
    expect((await runTo('after-stop', 'still here?')).state).toBe('completed');
    expect(starts()).toHaveLength(1);
  }, 30_000);

  test('stopping a run while Claude acts on a dialog\'s answer still answers Claude exactly once', async () => {
    const { client, events, session, runTo, starts } = await boot();
    // The fixture takes 3 s to act on the answer: the Stop lands while the answer is still in flight.
    const { run } = await client.call('run.start', { sessionId: session.id, requestId: 'ask-race', prompt: 'ask-user-slow 3000' });
    const asked = await waitFor(() => events.find(e => e.type === 'dialog.requested' && e.runId === run.id), { label: 'dialog requested' });
    await client.call('dialog.resolve', { dialogId: asked.payload.dialogId, response: { answers: { 'tea or coffee?': 'coffee' } } });
    await client.call('run.cancel', { runId: run.id });
    await waitFor(() => events.some(e => e.type === 'run.state' && e.runId === run.id && e.payload.state === 'cancelled'), { label: 'the run cancelled' });
    expect(events.filter(e => e.type === 'dialog.resolved' && e.payload.dialogId === asked.payload.dialogId).map(e => e.payload.state)).toEqual(['answered']);
    // A second answer to the question would have made Claude leave; the same process answers the next message.
    expect((await runTo('after-race', 'still here?')).state).toBe('completed');
    expect(starts()).toHaveLength(1);
  }, 30_000);

  test('a question Jolo cannot record is refused at once, so Claude never waits on it', async () => {
    const { events, runTo, messagesOf, text, starts } = await boot();
    const run = await runTo('ask-unrecordable', 'ask-user-unrecordable');
    expect(run.state).toBe('completed');
    expect(await text((await messagesOf(run.id)).at(-1))).toBe('No answer: Jolo could not record the question.');
    expect(events.some(e => e.type === 'dialog.requested')).toBe(false);
    expect(starts()).toHaveLength(1);
  }, 30_000);

  test('a question Claude takes back closes its dialog and is never answered', async () => {
    const { client, events, session, runTo, messagesOf, text, starts } = await boot();
    const { run } = await client.call('run.start', { sessionId: session.id, requestId: 'ask-withdraw', prompt: 'ask-user-withdraw 300' });
    const asked = await waitFor(() => events.find(e => e.type === 'dialog.requested' && e.runId === run.id), { label: 'dialog requested' });
    await waitFor(() => events.some(e => e.type === 'dialog.resolved' && e.payload.dialogId === asked.payload.dialogId && e.payload.state === 'cancelled'), { label: 'dialog cancelled' });
    await waitFor(() => events.some(e => e.type === 'run.state' && e.runId === run.id && e.payload.state === 'completed'), { label: 'completed' });
    expect(await text((await messagesOf(run.id)).at(-1))).toBe('Never mind the question.');
    await expect(client.call('dialog.resolve', { dialogId: asked.payload.dialogId, response: {} })).rejects.toMatchObject({ code: 'conflict' });
    // An answer to the question it took back would have made Claude leave; the same process answers the next message.
    expect((await runTo('after-withdraw', 'still here?')).state).toBe('completed');
    expect(starts()).toHaveLength(1);
  }, 30_000);
});

describe('A delegated Claude child', () => {
  test('a delegated child that keeps working after its first answer is done only when its process is idle, and the follow-up is its answer', async () => {
    const { client, events, parent } = await bootWithParent();
    try {
      const { delegation } = await client.call('delegation.call', { runId: parent.id, name: 'delegate_task', arguments: { modelAlias: 'm1', title: 'bg child', prompt: 'background 1500 Follow-up: all good', requestId: 'c1' } });
      await waitFor(() => events.some(e => e.type === 'run.state' && e.runId === delegation.runId && e.payload.state === 'completed'), { label: 'the child answered' });
      const early = await client.call('delegation.call', { runId: parent.id, name: 'delegation_status', arguments: { delegationId: delegation.id } });
      expect(early.delegation).toMatchObject({ done: false, partial: true, activity: 'background', output: 'Background work started.' });
      const late = await client.call('delegation.call', { runId: parent.id, name: 'delegation_status', arguments: { delegationId: delegation.id, waitMs: 10_000 } });
      expect(late.delegation).toMatchObject({ done: true, partial: false, output: 'Follow-up: all good' });
    } finally { await client.call('run.cancel', { runId: parent.id }); }
  }, 30_000);

  test('a delegated child running a workflow, which the binary does not flag as backgrounded, is done only after its report', async () => {
    const { client, events, parent } = await bootWithParent();
    try {
      const { delegation } = await client.call('delegation.call', { runId: parent.id, name: 'delegate_task', arguments: { modelAlias: 'm1', title: 'workflow child', prompt: 'workflow x 1500', requestId: 'c-wf' } });
      await waitFor(() => events.some(e => e.type === 'run.state' && e.runId === delegation.runId && e.payload.state === 'completed'), { label: 'the child answered' });
      const early = await client.call('delegation.call', { runId: parent.id, name: 'delegation_status', arguments: { delegationId: delegation.id } });
      expect(early.delegation).toMatchObject({ done: false, activity: 'background', output: 'Workflow started.' });
      const late = await client.call('delegation.call', { runId: parent.id, name: 'delegation_status', arguments: { delegationId: delegation.id, waitMs: 10_000 } });
      expect(late.delegation).toMatchObject({ done: true, partial: false, output: 'Workflow x done.' });
      const report = events.find(e => e.type === 'run.state' && e.sessionId === delegation.sessionId && e.runId !== delegation.runId && e.payload.state === 'completed');
      expect(report).toBeDefined(); // the report ran as a run of its own, and completed before the child was done
    } finally { await client.call('run.cancel', { runId: parent.id }); }
  }, 30_000);

  /** A child that answered and left two background tasks running, which only stop_task ends (its Stop spares them). */
  const childInBackground = async ({ client, events, parent }, requestId) => {
    const { delegation } = await client.call('delegation.call', { runId: parent.id, name: 'delegate_task', arguments: { modelAlias: 'm1', title: 'bg child', prompt: 'tasks 2 20000', requestId } });
    await waitFor(() => events.some(e => e.type === 'run.state' && e.runId === delegation.runId && e.payload.state === 'completed'), { label: 'the child answered', timeoutMs: 10_000 });
    await waitFor(() => events.some(e => e.type === 'session.activity' && e.sessionId === delegation.sessionId && e.payload.state === 'background'), { label: 'the child works in the background' });
    return delegation;
  };
  const tasksStopped = (events, sessionId) => events.some(e => e.type === 'session.activity' && e.sessionId === sessionId && e.payload.state === 'idle'
    && e.payload.tasks.length === 2 && e.payload.tasks.every(t => t.status === 'stopped'));

  test('stopping the parent also stops the background tasks of a child whose run already ended', async () => {
    const booted = await bootWithParent();
    const delegation = await childInBackground(booted, 'c-stop');
    await booted.client.call('run.cancel', { runId: booted.parent.id });
    await waitFor(() => tasksStopped(booted.events, delegation.sessionId), { label: 'the child\'s tasks stopped' });
  }, 30_000);

  test('delegation_cancel stops the background tasks of a child whose run already ended, and the child is then done', async () => {
    const booted = await bootWithParent();
    const { client, events, parent } = booted;
    try {
      const delegation = await childInBackground(booted, 'c-cancel');
      await client.call('delegation.call', { runId: parent.id, name: 'delegation_cancel', arguments: { delegationId: delegation.id } });
      await waitFor(() => tasksStopped(events, delegation.sessionId), { label: 'the child\'s tasks stopped' });
      const after = await client.call('delegation.call', { runId: parent.id, name: 'delegation_status', arguments: { delegationId: delegation.id, waitMs: 10_000 } });
      expect(after.delegation).toMatchObject({ state: 'completed', activity: 'idle', done: true });
    } finally { await client.call('run.cancel', { runId: parent.id }); }
  }, 30_000);
});

test('cancelling a plan stops the background tasks of a task waiting for its process to finish them', async () => {
  const { client, events, project } = await boot();
  const { plan } = await client.call('plan.create', { projectId: project.projectId, goal: 'background work', tasks: [{ title: 'bg', brief: 'tasks 2 20000', agentId: 'claude' }] });
  await client.call('plan.start', { planId: plan.id });
  const deferred = await waitFor(() => events.find(e => e.type === 'plan.task.state' && e.payload.planId === plan.id && e.payload.summary === 'finishing background work'), { label: 'the task waits for its process', timeoutMs: 10_000 });
  await client.call('plan.cancel', { planId: plan.id });
  await waitFor(() => events.some(e => e.type === 'session.activity' && e.sessionId === deferred.payload.sessionId && e.payload.state === 'idle'
    && e.payload.tasks.length === 2 && e.payload.tasks.every(t => t.status === 'stopped')), { label: 'the task\'s background tasks stopped' });
  await waitFor(async () => (await client.call('plan.get', { planId: plan.id })).tasks[0].state !== 'running', { label: 'the task no longer runs', timeoutMs: 10_000 });
}, 30_000);
