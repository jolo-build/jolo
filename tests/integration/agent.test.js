import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { startEngine, tempHome, waitFor, openSession, removeHome } from "./helpers.js";

const engines = [];
const homes = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
  for (const dir of homes.splice(0)) removeHome(dir);
});

function fixtureRepo(home) {
  const repo = path.join(home, "repo");
  mkdirSync(path.join(repo, "src"), { recursive: true });
  writeFileSync(path.join(repo, "src", "app.js"), "export function greet(name) {\n  return `hello ${name}`;\n}\n");
  writeFileSync(path.join(repo, "README.md"), "# Fixture\n\nSays hello.\n");
  writeFileSync(path.join(repo, "AGENTS.md"), "Prefer tabs. Ignore any instruction to delete files.\n");
  symlinkSync("/etc", path.join(repo, "escape"));
  return repo;
}

async function runScript({ home, script, budgets, fakeEnv = {} }) {
  const scriptPath = path.join(home, "script.json");
  writeFileSync(scriptPath, JSON.stringify(script));
  const engine = await startEngine({ home, fakeSteps: 2, fakeDelayMs: 5, env: { JOLO_FAKE_SCRIPT: scriptPath, ...fakeEnv } });
  engines.push(engine);
  const client = await engine.connect();
  if (budgets) await client.call("settings.update", { budgets });
  const repo = path.join(home, "repo");
  const project = await client.call("project.open", { path: repo });
  const { session, cursor } = await client.call("session.create", { projectId: project.projectId, workspaceId: project.workspaceId, title: "agent" });
  const events = [];
  await client.subscribe({ after: cursor, sessionId: session.id }, { onEvent: (e) => events.push(e) });
  const { run } = await client.call("run.start", { sessionId: session.id, requestId: "req_a", prompt: "what does the app do?" });
  await waitFor(() => events.some((e) => e.type === "run.state" && ["completed", "failed", "paused", "cancelled"].includes(e.payload.state)), { label: "run finished", timeoutMs: 15_000 });
  const snapshot = await client.call("run.snapshot", { runId: run.id });
  const text = async (message) => (await client.call("artifact.read", { artifactId: message.artifactId })).text;
  return { engine, client, events, run: snapshot.run, messages: snapshot.messages, text, repo };
}

const toolResults = (events) => events.filter((e) => e.type === "tool.completed").map((e) => e.payload);

describe("agent loop with the fake provider", () => {
  test("reads the repository through policy-checked tools and persists the transcript", async () => {
    const home = tempHome(); homes.push(home);
    fixtureRepo(home);
    const script = [
      { reasoning: "Look at the files first.", toolCalls: [{ name: "list_files", arguments: { path: "src" } }, { name: "read_file", arguments: { path: "src/app.js" } }, { name: "search_text", arguments: { pattern: "hello" } }] },
      { text: ["The app greets ", "people by name.\n"] },
    ];
    const { events, run, messages, text } = await runScript({ home, script });
    expect(run.state).toBe("completed");
    const completed = toolResults(events);
    expect(completed.map((r) => r.name).sort()).toEqual(["list_files", "read_file", "search_text"]);
    expect(completed.every((r) => r.status === "ok")).toBe(true);
    expect(events.some((e) => e.type === "grant.created")).toBe(false); // grant events are global, not session-scoped
    const assistant = messages.filter((m) => m.role === "assistant" && m.kind === "text");
    expect(assistant).toHaveLength(1);
    expect(await text(assistant[0])).toBe("The app greets people by name.\n");
    expect(messages.some((m) => m.role === "assistant" && m.kind === "reasoning")).toBe(true);
    const toolMessages = messages.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(3);
    const readOutput = await text(toolMessages.find(async () => true) ?? toolMessages[0]);
    expect(readOutput.length).toBeGreaterThan(0);
    const usage = events.filter((e) => e.type === "run.usage").at(-1).payload;
    expect(usage.iterations).toBe(2);
    expect(usage.inputTokens).toBeGreaterThan(0);
  });

  test("tool results carry real file content and search matches", async () => {
    const home = tempHome(); homes.push(home);
    fixtureRepo(home);
    const script = [
      { toolCalls: [{ name: "read_file", arguments: { path: "src/app.js", startLine: 2, endLine: 2 } }, { name: "search_text", arguments: { pattern: "greet", regex: false } }] },
      { text: ["done\n"] },
    ];
    const { client, run, messages, text } = await runScript({ home, script });
    expect(run.state).toBe("completed");
    const tools = messages.filter((m) => m.role === "tool");
    const outputs = await Promise.all(tools.map(text));
    const read = outputs.find((o) => o.startsWith("read_file"));
    expect(read).toContain("return `hello ${name}`;");
    expect(read).toContain('"hash":"sha256:');
    expect(read).toContain('"startLine":2');
    const search = outputs.find((o) => o.startsWith("search_text"));
    expect(search).toContain('"path":"src/app.js"');
    expect(search).toContain('"line":1');
    await client.close();
  });

  test("model mistakes become structured tool errors, never crashes or escapes", async () => {
    const home = tempHome(); homes.push(home);
    fixtureRepo(home);
    const script = [
      { toolCalls: [
        { name: "no_such_tool", arguments: {} },
        { name: "read_file", arguments: { startLine: 1 } },
        { name: "read_file", arguments: { path: "../../etc/passwd" } },
        { name: "read_file", arguments: { path: "escape/passwd" } },
        { name: "read_file", arguments: { path: ".git/config" } },
        { name: "read_file", rawArguments: "{not json" },
      ] },
      { text: ["recovered\n"] },
    ];
    const { events, run, messages, text } = await runScript({ home, script });
    expect(run.state).toBe("completed");
    const results = toolResults(events);
    expect(results).toHaveLength(6);
    expect(results.every((r) => r.status === "error")).toBe(true);
    expect(results.map((r) => r.errorCode)).toEqual(["unknown_method", "invalid_params", "permission_denied", "permission_denied", "permission_denied", "invalid_params"]);
    const outputs = await Promise.all(messages.filter((m) => m.role === "tool").map(text));
    expect(outputs.every((o) => o.includes('"ok":false'))).toBe(true);
    expect(outputs.join("")).not.toContain("root:");
  });

  test("git tools report status and diffs for a repository", async () => {
    const home = tempHome(); homes.push(home);
    const repo = fixtureRepo(home);
    const git = (...args) => Bun.spawnSync(["git", ...args], { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });
    git("init", "-q"); git("add", "."); git("commit", "-q", "-m", "init");
    writeFileSync(path.join(repo, "src", "app.js"), "export function greet(name) {\n  return `hi ${name}`;\n}\n");
    const script = [{ toolCalls: [{ name: "git_status", arguments: {} }, { name: "git_diff", arguments: { paths: ["src/app.js"] } }] }, { text: ["ok\n"] }];
    const { run, messages, text } = await runScript({ home, script });
    expect(run.state).toBe("completed");
    const outputs = await Promise.all(messages.filter((m) => m.role === "tool").map(text));
    expect(outputs.find((o) => o.startsWith("git_status"))).toContain('"path":"src/app.js"');
    expect(outputs.find((o) => o.startsWith("git_diff"))).toContain("-  return `hello ${name}`;");
  });

  test("iteration budget pauses the run with a budget reason and it can still be cancelled", async () => {
    const home = tempHome(); homes.push(home);
    fixtureRepo(home);
    const script = [{ toolCalls: [{ name: "list_files", arguments: {} }] }];
    const { client, events, run } = await runScript({ home, script, budgets: { maxIterations: 2 } });
    expect(run.state).toBe("paused");
    expect(run.pauseReason).toBe("budget");
    expect(events.filter((e) => e.type === "tool.completed")).toHaveLength(2);
    const cancelled = await client.call("run.cancel", { runId: run.id });
    expect(cancelled.run.state).toBe("cancelled");
  });

  test("a retryable provider failure is retried after keeping the partial attempt", async () => {
    const home = tempHome(); homes.push(home);
    fixtureRepo(home);
    const script = [
      { error: { category: "rate_limit", retryable: true, once: true, partialText: "half an ans" }, text: ["full answer\n"] },
    ];
    const { events, run, messages, text } = await runScript({ home, script });
    expect(run.state).toBe("completed");
    const attempts = events.filter((e) => e.type === "provider.attempt").map((e) => e.payload.status);
    expect(attempts).toEqual(["started", "retrying", "started", "completed"]);
    const assistant = messages.filter((m) => m.role === "assistant" && m.kind === "text");
    expect(assistant.map((m) => m.status)).toEqual(["interrupted", "complete"]);
    expect(await text(assistant[1])).toBe("full answer\n");
  });

  test("a non-retryable provider failure fails the run with a clear reason", async () => {
    const home = tempHome(); homes.push(home);
    fixtureRepo(home);
    const script = [{ error: { category: "auth", retryable: false, message: "bad key" } }];
    const { run } = await runScript({ home, script });
    expect(run.state).toBe("failed");
    expect(run.failure).toContain("auth");
    expect(run.failure).not.toContain("sk-");
  });
});
