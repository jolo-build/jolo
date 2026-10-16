import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOT, startEngine, tempHome, waitFor, removeHome } from "./helpers.js";

const engines = [];
const homes = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
  for (const dir of homes.splice(0)) removeHome(dir);
});

const FAKE = path.join(ROOT, "tests", "fixtures", "fake-agy.js");
const TERMINAL = ["completed", "failed", "cancelled", "interrupted"];

/** A profile whose "antigravity" is the protocol fixture, so nothing here reaches the real CLI or its account. */
async function boot() {
  const home = tempHome(); homes.push(home);
  const repo = path.join(home, "repo");
  mkdirSync(repo, { recursive: true });
  const launcher = path.join(home, "fake-agy");
  writeFileSync(launcher, `#!/bin/sh\nif [ -f "$0.env" ]; then . "$0.env"; fi\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
  chmodSync(launcher, 0o755);
  const agentsDir = path.join(home, "data", "t", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(path.join(agentsDir, "antigravity.json"), JSON.stringify({ id: "antigravity", displayName: "Antigravity CLI", binary: launcher, transport: "antigravity-stream", modelArgs: ["--model", "{model}"], effortArgs: ["--effort", "{effort}"] }));
  const engine = await startEngine({ home });
  engines.push(engine);
  const client = await engine.connect({ clientKind: "test" });
  const events = [];
  const status = await client.call("engine.status", {});
  await client.subscribe({ after: status.cursor }, { onEvent: (event) => events.push(event) });
  const project = await client.call("project.open", { path: repo });
  const { session } = await client.call("session.create", { projectId: project.projectId, workspaceId: project.workspaceId, title: "hosted", agentId: "antigravity" });
  const runTo = async (requestId, prompt) => {
    const { run } = await client.call("run.start", { sessionId: session.id, requestId, prompt });
    await waitFor(() => events.some((e) => e.type === "run.state" && e.runId === run.id && TERMINAL.includes(e.payload.state)), { label: `${requestId} finished`, timeoutMs: 20_000 });
    return (await client.call("run.snapshot", { runId: run.id })).run;
  };
  const text = async (message) => (await client.call("artifact.read", { artifactId: message.artifactId })).text;
  const messagesOf = async (runId) => (await client.call("run.snapshot", { runId })).messages;
  /** The environment the launcher hands agy from its next start on. */
  const script = (vars) => writeFileSync(`${launcher}.env`, Object.entries(vars).map(([key, value]) => `export ${key}=${value}\n`).join(""));
  return { home, repo, client, events, session, runTo, text, messagesOf, script };
}

describe("Antigravity CLI through its print-mode stream", () => {
  test("a hosted session streams the reply, counts only this turn's tokens, and continues the same conversation next turn", async () => {
    const { events, runTo, text, messagesOf } = await boot();
    const first = await runTo("req_1", "hello there");
    expect(first.state).toBe("completed");
    const messages = await messagesOf(first.id);
    expect(messages.map((m) => [m.role, m.kind])).toEqual([["user", "text"], ["assistant", "text"]]);
    expect(await text(messages[1])).toBe("You said: hello there\n");
    expect(events.filter((e) => e.type === "message.committed" && e.runId === first.id).length).toBeGreaterThan(0); // it streamed
    expect(first.usage).toMatchObject({ inputTokens: 140, outputTokens: 6, iterations: 1 }); // the step's own count, not the conversation's

    const second = await runTo("req_2", "and again");
    expect(second.state).toBe("completed");
    expect(await text((await messagesOf(second.id))[1])).toMatch(/^Continuing conversation agy-\w+: and again\n$/); // --conversation carried the id
    expect(second.usage).toMatchObject({ inputTokens: 140, outputTokens: 6, iterations: 1 });
  }, 40_000);

  test("Jolo's gate decides every tool call: workspace edits pass, outside reads and .git are refused by policy, and a command asks the user", async () => {
    const { client, events, home, repo, runTo, text, messagesOf } = await boot();
    const target = path.join(repo, "made.txt");
    const write = await runTo("req_write", `write ${target} hello from agy`);
    expect(write.state).toBe("completed");
    expect(readFileSync(target, "utf8")).toBe("hello from agy");
    const messages = await messagesOf(write.id);
    expect(messages.map((m) => m.kind)).toEqual(["text", "tool", "text"]);
    expect(await text(messages[1])).toContain(`write_to_file {"TargetFile":${JSON.stringify(target)}`);
    expect(events.find((e) => e.type === "tool.completed" && e.runId === write.id).payload).toMatchObject({ name: "antigravity:write_to_file", status: "ok" });

    // Refused by Jolo's policy without asking anyone; agy is told why and finishes its turn.
    const secret = path.join(home, "secret.txt");
    writeFileSync(secret, "outside");
    const outside = await runTo("req_read", `read ${secret}`);
    expect(outside.state).toBe("completed");
    expect(await text((await messagesOf(outside.id)).at(-1))).toBe(`I could not read ${secret}: tool call denied by pre-tool hook: Jolo policy: view_file outside the workspace is not allowed\n`);
    expect(events.find((e) => e.type === "tool.completed" && e.runId === outside.id).payload).toMatchObject({ name: "antigravity:view_file", status: "error" });
    const git = await runTo("req_git", `write ${path.join(repo, ".git", "config")} [core]`);
    expect(await text((await messagesOf(git.id)).at(-1))).toContain("Jolo policy: write_to_file outside the workspace is not allowed");
    expect(events.some((e) => e.type === "permission.requested")).toBe(false);

    // A command needs the user, through the same permission request as any other agent's.
    let asked = null;
    client.onEvent((event) => { if (event.type === "permission.requested" && !asked) { asked = event.payload; void client.call("permission.resolve", { permissionId: event.payload.permissionId, decision: "allow_once" }); } });
    const command = await runTo("req_cmd", "run echo hosted-ok");
    expect(command.state).toBe("completed");
    expect(asked).toMatchObject({ tool: "antigravity:run_command", summary: "run_command: echo hosted-ok", script: "echo hosted-ok", cwd: realpathSync(repo) });
    expect(await text((await messagesOf(command.id)).at(-1))).toBe("The command printed: hosted-ok\n");
  }, 40_000);

  test("a declined command reaches agy as Jolo's reason, and a subagent's own command asks like any other", async () => {
    const { client, events, runTo, text, messagesOf } = await boot();
    const decisions = ["deny", "allow_once"];
    const asked = [];
    client.onEvent((event) => { if (event.type === "permission.requested") { asked.push(event.payload.tool); void client.call("permission.resolve", { permissionId: event.payload.permissionId, decision: decisions.shift() }); } });
    const declined = await runTo("req_deny", "run touch should-not-exist");
    expect(declined.state).toBe("completed");
    expect(await text((await messagesOf(declined.id)).at(-1))).toBe("I could not run it: tool call denied by pre-tool hook: The user declined this action in Jolo.\n");
    expect(events.find((e) => e.type === "tool.completed" && e.runId === declined.id).payload).toMatchObject({ name: "antigravity:run_command", status: "error" });

    const delegated = await runTo("req_sub", "subagent echo from-subagent");
    expect(delegated.state).toBe("completed");
    expect(await text((await messagesOf(delegated.id)).at(-1))).toBe("The subagent's command printed: from-subagent\n");
    expect(asked).toEqual(["antigravity:run_command", "antigravity:run_command"]); // starting the subagent asked nothing
  }, 40_000);

  test("a failed turn names the agent, and a cancelled turn stops it", async () => {
    const { client, events, session, runTo } = await boot();
    expect(await runTo("req_fail", "fail")).toMatchObject({ state: "failed", failure: "Antigravity CLI: scripted failure" });

    const { run } = await client.call("run.start", { sessionId: session.id, requestId: "req_hang", prompt: "hang" });
    await waitFor(() => events.some((e) => e.type === "run.state" && e.runId === run.id && e.payload.state === "model"), { label: "started" });
    await client.call("run.cancel", { runId: run.id });
    await waitFor(() => events.some((e) => e.type === "run.state" && e.runId === run.id && e.payload.state === "cancelled"), { label: "cancelled" });
  }, 40_000);

  test("the plan's limits are read per model group from /usage, and a refusal is its note and is asked again", async () => {
    const { client, script } = await boot();
    script({ FAKE_AGY_USAGE: "error" });
    expect(await client.call("agent.limits", { agentId: "antigravity", refresh: false })).toMatchObject({ windows: [], source: "none", note: "fake-agy: quota service unavailable" });
    script({});
    const report = await client.call("agent.limits", { agentId: "antigravity", refresh: false });
    expect(report).toMatchObject({ source: "agent", plan: null, note: null });
    expect(report.windows.map(({ label, usedPercent, resetsAt }) => [label, Math.round(usedPercent), resetsAt])).toEqual([
      ["Weekly · Gemini", 3, "2026-10-22T12:23:55.000Z"],
      ["5-hour · Gemini", 13, "2026-10-15T17:23:55.000Z"],
      ["Weekly · Claude and GPT", 0, "2026-10-22T16:04:01.000Z"],
      ["5-hour · Claude and GPT", 0, "2026-10-15T21:04:01.000Z"],
    ]);
  }, 40_000);

  test("the chosen model and effort reach agy as flags, and its models are offered with their thinking levels", async () => {
    const { client, runTo, text, messagesOf } = await boot();
    const report = await client.call("agent.models", { agentId: "antigravity" });
    expect(report).toMatchObject({ source: "agent", note: null, efforts: ["low", "medium", "high"] });
    expect(report.models.map(({ id, displayName, efforts }) => ({ id, displayName, efforts }))).toEqual([
      { id: "gemini-4-argon", displayName: "Gemini 4 Argon", efforts: ["low", "medium", "high"] },
      { id: "gpt-oss-120b", displayName: "GPT-OSS 120B", efforts: ["medium"] },
      { id: "custom-model", displayName: "Custom Model", efforts: [] },
    ]);

    await client.call("settings.update", { agents: { antigravity: { model: "gemini-4-argon", effort: "low" } } });
    const run = await runTo("req_model", "model");
    expect(run.state).toBe("completed");
    expect(await text((await messagesOf(run.id))[1])).toMatch(/^Running gemini-4-argon at low with \S*jolo-gate-\S+ and \S*jolo-agent-\S+ added\.\n$/); // the gate's directory and the turn's scratch directory
  }, 40_000);
});
