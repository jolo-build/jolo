import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CLI_ENTRY, ROOT, startEngine, tempHome, waitFor, removeHome } from "./helpers.js";

const engines = [];
const homes = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
  for (const dir of homes.splice(0)) removeHome(dir);
});

const NOTES = "alpha\nbeta\n";
// The fake provider replays its script by turn WITHIN a session, and every task gets a session of its own, so
// each task here does the same two turns: append a line, then say so. What tells the tasks apart is the file
// they all work on, which is how a sequential plan is supposed to behave.
const APPEND = [
  { toolCalls: [{ name: "run_command", arguments: { argv: ["/bin/sh", "-c", "printf 'line\\n' >> notes.txt"] } }] },
  { text: ["Appended a line.\n"] },
];

function fixture(home, script) {
  const repo = path.join(home, "repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(path.join(repo, "notes.txt"), NOTES);
  const scriptPath = path.join(home, "script.json");
  writeFileSync(scriptPath, JSON.stringify(script));
  return { repo, scriptPath };
}

async function boot(home, script) {
  const { repo, scriptPath } = fixture(home, script);
  const engine = await startEngine({ home, env: { JOLO_FAKE_SCRIPT: scriptPath } });
  engines.push(engine);
  const client = await engine.connect({ clientKind: "test" });
  const events = [];
  const status = await client.call("engine.status", {});
  await client.subscribe({ after: status.cursor }, { onEvent: (event) => events.push(event) });
  const project = await client.call("project.open", { path: repo });
  const planState = (planId) => events.filter((e) => e.type === "plan.state" && e.payload.planId === planId).map((e) => e.payload.state);
  return { engine, client, events, project, repo, planState };
}

describe("a plan of tasks across agents", () => {
  test("tasks run one at a time in the order written, each in its own session, building on each other", async () => {
    const home = tempHome(); homes.push(home);
    const { client, events, project, repo, planState } = await boot(home, APPEND);

    const { plan, tasks } = await client.call("plan.create", {
      projectId: project.projectId,
      goal: "put the notes right",
      tasks: [
        { title: "first change", brief: "append a line" },
        { title: "second change", brief: "append another line" },
      ],
    });
    expect(plan.state).toBe("draft"); // writing a plan down asks nothing of anyone
    expect(tasks.map((task) => [task.position, task.title, task.state])).toEqual([[0, "first change", "pending"], [1, "second change", "pending"]]);
    expect(events.some((event) => event.type === "plan.created")).toBe(true);

    // The first command asked for is approved for the project, which covers the identical one behind it.
    client.onEvent((event) => {
      if (event.type === "permission.requested") client.call("permission.resolve", { permissionId: event.payload.permissionId, decision: "allow_project" });
    });
    await client.call("plan.start", { planId: plan.id });
    await waitFor(() => planState(plan.id).includes("done"), { label: "the plan finished", timeoutMs: 20_000 });

    const after = await client.call("plan.get", { planId: plan.id });
    expect(after.plan.state).toBe("done");
    expect(after.tasks.map((task) => task.state)).toEqual(["done", "done"]);
    expect(after.tasks.map((task) => task.summary)).toEqual(["Appended a line.", "Appended a line."]);
    // Both tasks worked on the same files, one after the other, so their work adds up.
    expect(readFileSync(path.join(repo, "notes.txt"), "utf8")).toBe("alpha\nbeta\nline\nline\n");

    // One session per task, each carrying the task's own transcript, and one execution per task.
    const sessions = after.tasks.map((task) => task.sessionId);
    expect(new Set(sessions).size).toBe(2);
    for (const [index, sessionId] of sessions.entries()) {
      const page = await client.call("session.page", { sessionId });
      expect(page.session.planTaskId).toBe(after.tasks[index].id);
      expect(page.session.title).toBe(after.tasks[index].title);
    }
    expect(after.executions).toHaveLength(2);
    expect(after.executions.map((execution) => [execution.attempt, execution.purpose, execution.outcome])).toEqual([[1, "implement", "completed"], [1, "implement", "completed"]]);
    expect(after.executions.every((execution) => execution.runId && execution.endedAt)).toBe(true);
    expect(after.tasks.every((task) => task.acceptedExecutionId)).toBe(true);

    // The two tasks never overlapped: the second started only after the first had finished.
    const starts = events.filter((e) => e.type === "plan.task.state" && e.payload.state === "running").map((e) => e.payload.taskId);
    const ends = events.filter((e) => e.type === "plan.task.state" && e.payload.state === "done").map((e) => e.payload.taskId);
    expect(starts).toEqual([after.tasks[0].id, after.tasks[1].id]);
    expect(ends).toEqual(starts);
    expect(events.findIndex((e) => e.type === "plan.task.state" && e.payload.taskId === after.tasks[1].id && e.payload.state === "running"))
      .toBeGreaterThan(events.findIndex((e) => e.type === "plan.task.state" && e.payload.taskId === after.tasks[0].id && e.payload.state === "done"));
  }, 40_000);

  test("a task waiting on the user stops the plan where it stands, and answering lets it go on", async () => {
    const home = tempHome(); homes.push(home);
    const { client, events, project, planState } = await boot(home, APPEND);
    const { plan } = await client.call("plan.create", {
      projectId: project.projectId,
      goal: "ask before working",
      tasks: [{ title: "run something", brief: "append a line" }],
    });
    await client.call("plan.start", { planId: plan.id });

    const asked = await waitFor(() => events.find((e) => e.type === "permission.requested"), { label: "the task asked", timeoutMs: 20_000 });
    const waiting = await client.call("plan.get", { planId: plan.id });
    expect(waiting.plan.state).toBe("running"); // the plan has not given up; it is waiting like any task does
    expect(waiting.tasks[0].state).toBe("running");
    expect(planState(plan.id)).toEqual(["running"]); // and it did not decide anything on the user's behalf

    await client.call("permission.resolve", { permissionId: asked.payload.permissionId, decision: "allow_once" });
    await waitFor(() => planState(plan.id).includes("done"), { label: "the plan finished after the answer", timeoutMs: 20_000 });
    expect((await client.call("plan.get", { planId: plan.id })).tasks[0].state).toBe("done");
  }, 40_000);

  test("a declined task blocks the plan, and the user decides whether to skip it or try again", async () => {
    const home = tempHome(); homes.push(home);
    const { client, events, project, planState } = await boot(home, APPEND);
    let answered = 0;
    client.onEvent((event) => {
      if (event.type !== "permission.requested") return;
      answered += 1;
      client.call("permission.resolve", { permissionId: event.payload.permissionId, decision: answered === 1 ? "deny" : "allow_once" });
    });
    const { plan } = await client.call("plan.create", {
      projectId: project.projectId,
      goal: "decline the first task",
      tasks: [{ title: "run something", brief: "append a line" }, { title: "then another", brief: "append another line" }],
    });
    await client.call("plan.start", { planId: plan.id });
    await waitFor(() => planState(plan.id).includes("paused"), { label: "the plan stopped for the user", timeoutMs: 20_000 });

    const stopped = await client.call("plan.get", { planId: plan.id });
    expect(stopped.tasks[0]).toMatchObject({ state: "blocked", blockedReason: "declined" });
    expect(stopped.tasks[1].state).toBe("pending"); // untouched: the plan did not run past the problem
    await expect(client.call("plan.start", { planId: plan.id })).rejects.toMatchObject({ code: "conflict" });

    // Skipping the blocked task is the user's decision, and the plan carries on from there.
    await client.call("plan.task.skip", { taskId: stopped.tasks[0].id });
    await client.call("plan.start", { planId: plan.id });
    await waitFor(() => planState(plan.id).includes("done"), { label: "the plan finished after the skip", timeoutMs: 20_000 });
    const after = await client.call("plan.get", { planId: plan.id });
    expect(after.tasks.map((task) => task.state)).toEqual(["skipped", "done"]);
    expect(after.executions).toHaveLength(2); // the declined try is still on the record
    expect(after.executions[0]).toMatchObject({ outcome: "paused" });
  }, 40_000);

  test("a plan is edited while it is a draft, and cancelling one leaves nothing pending", async () => {
    const home = tempHome(); homes.push(home);
    const { client, project } = await boot(home, APPEND);
    const { plan, tasks } = await client.call("plan.create", {
      projectId: project.projectId,
      goal: "edit me",
      tasks: [{ title: "one", brief: "first" }, { title: "two", brief: "second" }],
    });

    const { task: added } = await client.call("plan.task.add", { planId: plan.id, task: { title: "zero", brief: "before the others" }, position: 0 });
    expect(added.position).toBe(0);
    expect((await client.call("plan.get", { planId: plan.id })).tasks.map((task) => task.title)).toEqual(["zero", "one", "two"]);

    const { task: moved } = await client.call("plan.task.update", { taskId: added.id, position: 2, title: "last after all" });
    expect(moved.position).toBe(2);
    expect((await client.call("plan.get", { planId: plan.id })).tasks.map((task) => task.title)).toEqual(["one", "two", "last after all"]);

    await client.call("plan.task.remove", { taskId: tasks[1].id });
    expect((await client.call("plan.get", { planId: plan.id })).tasks.map((task) => [task.position, task.title])).toEqual([[0, "one"], [1, "last after all"]]);

    const cancelled = await client.call("plan.cancel", { planId: plan.id });
    expect(cancelled.plan.state).toBe("cancelled");
    const after = await client.call("plan.get", { planId: plan.id });
    expect(after.tasks.every((task) => task.state === "cancelled")).toBe(true);
    await expect(client.call("plan.start", { planId: plan.id })).rejects.toMatchObject({ code: "conflict" });
  }, 40_000);

  test("a plan left running by a previous boot waits for the user rather than starting again", async () => {
    const home = tempHome(); homes.push(home);
    const { client, engine, events, project } = await boot(home, [{ toolCalls: [{ name: "run_command", arguments: { argv: ["sleep", "30"] } }] }, { text: ["done\n"] }]);
    const { plan } = await client.call("plan.create", {
      projectId: project.projectId,
      goal: "get interrupted",
      tasks: [{ title: "long one", brief: "run sleep 30" }],
    });
    await client.call("plan.start", { planId: plan.id });
    await waitFor(() => events.some((e) => e.type === "plan.task.state" && e.payload.state === "running"), { label: "the task started" });
    await waitFor(() => events.some((e) => e.type === "permission.requested"), { label: "it asked before sleeping", timeoutMs: 20_000 });

    await engine.stop();
    engines.splice(engines.indexOf(engine), 1);
    const restarted = await startEngine({ home, env: { JOLO_FAKE_SCRIPT: path.join(home, "script.json") } });
    engines.push(restarted);
    const client2 = await restarted.connect({ clientKind: "test" });
    const after = await client2.call("plan.get", { planId: plan.id });
    expect(after.plan.state).toBe("paused"); // nothing was started again on its own
    expect(after.tasks[0]).toMatchObject({ state: "blocked", blockedReason: "interrupted" });
    expect(after.executions[0]).toMatchObject({ outcome: "interrupted" });
    expect(after.executions[0].endedAt).not.toBeNull();
  }, 40_000);

  test("the terminal writes a plan down, starts it, and reads back what each task did", async () => {
    const home = tempHome(); homes.push(home);
    const { client, repo, project, planState } = await boot(home, APPEND);
    client.onEvent((event) => {
      if (event.type === "permission.requested") client.call("permission.resolve", { permissionId: event.payload.permissionId, decision: "allow_project" });
    });
    const cli = async (...args) => {
      const proc = Bun.spawn([process.execPath, CLI_ENTRY, ...args, "--path", repo, "--home", home, "--profile", "t"], { stdout: "pipe", stderr: "pipe", env: { ...process.env } });
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      if (code !== 0) throw new Error(`jolo ${args.join(" ")} exited ${code}: ${stderr}`);
      return stdout.trim();
    };

    const written = JSON.parse(await cli("plan", "new", "tidy the notes", "--task", "first: append a line", "--task", "second: append another", "--json"));
    expect(written.plan.projectId).toBe(project.projectId);
    expect(written.tasks.map((task) => task.title)).toEqual(["first", "second"]);

    // A task can be handed to a different agent before it starts; "jolo" means Jolo's own loop.
    const assigned = JSON.parse(await cli("plan", "task", "assign", written.tasks[1].id, "--agent", "jolo", "--model", "some-model", "--json"));
    expect(assigned.task).toMatchObject({ agentId: null, model: "some-model" });

    // A plan-wide agent shows on every task that names none of its own, rather than reading as Jolo's.
    const forCodex = await cli("plan", "new", "with an agent", "--task", "one: do it", "--agent", "codex");
    expect(forCodex).toContain("(codex)"); // never started here, so no vendor CLI is reached

    const listed = await cli("plan", "list");
    expect(listed).toContain(written.plan.id);
    expect(listed).toContain("draft");

    await cli("plan", "start", written.plan.id);
    await waitFor(() => planState(written.plan.id).includes("done"), { label: "the plan finished", timeoutMs: 20_000 });
    const shown = await cli("plan", "show", written.plan.id);
    expect(shown).toContain("[done]");
    expect(shown).toContain("Appended a line.");
    expect(shown.split("\n").filter((line) => line.includes("done"))).toHaveLength(3); // the plan and both tasks
  }, 40_000);

  test("one plan hands one task to a hosted agent and the next to Jolo, each with its own model", async () => {
    const home = tempHome(); homes.push(home);
    // A profile whose "fixture-acp" is the ACP fixture, so nothing here reaches a real vendor CLI.
    const launcher = path.join(home, "fake-acp");
    writeFileSync(launcher, `#!/bin/sh\nFAKE_ACP_STATE=${JSON.stringify(path.join(home, "acp-state"))} exec "${process.execPath}" "${path.join(ROOT, "tests", "fixtures", "fake-acp.js")}" "$@"\n`);
    chmodSync(launcher, 0o755);
    const agentsDir = path.join(home, "data", "t", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(path.join(agentsDir, "fixture-acp.json"), JSON.stringify({
      id: "fixture-acp", displayName: "Fixture Agent", binary: launcher, args: ["--acp"], transport: "acp",
      modelArgs: ["-m", "{model}"],
    }));
    const { client, project, planState } = await boot(home, APPEND);

    const { plan, tasks } = await client.call("plan.create", {
      projectId: project.projectId,
      goal: "two agents, one plan",
      tasks: [
        { title: "ask the hosted agent", brief: "model", agentId: "fixture-acp", model: "fake-fast" },
        { title: "then ask Jolo", brief: "append a line" },
      ],
    });
    expect(tasks.map((task) => task.agentId)).toEqual(["fixture-acp", null]);

    // Jolo's own task asks before running a command; the hosted one does not.
    client.onEvent((event) => {
      if (event.type === "permission.requested") client.call("permission.resolve", { permissionId: event.payload.permissionId, decision: "allow_once" });
    });
    await client.call("plan.start", { planId: plan.id });
    await waitFor(() => planState(plan.id).includes("done"), { label: "both agents finished", timeoutMs: 25_000 });

    const after = await client.call("plan.get", { planId: plan.id });
    expect(after.tasks.map((task) => task.state)).toEqual(["done", "done"]);
    // The hosted task ran under the model the task chose, not the agent's configured default.
    const hostedSession = await client.call("session.page", { sessionId: after.tasks[0].sessionId });
    expect(hostedSession.session.agentId).toBe("fixture-acp");
    const reply = await client.call("artifact.read", { artifactId: hostedSession.messages.at(-1).artifactId });
    expect(reply.text).toBe("Running fake-fast at the default effort.");
    expect((await client.call("session.page", { sessionId: after.tasks[1].sessionId })).session.agentId).toBeNull();
    expect(after.executions.map((execution) => [execution.agentId, execution.model])).toEqual([["fixture-acp", "fake-fast"], [null, null]]);
    // Choosing a model for one task never changes what the agent is configured with.
    expect((await client.call("settings.get", {})).settings.agents["fixture-acp"]).toBeUndefined();
  }, 60_000);

  test("a task cannot name an agent that is not there, and a terminal-only agent cannot answer one", async () => {
    const home = tempHome(); homes.push(home);
    const { client, project } = await boot(home, APPEND);
    await expect(client.call("plan.create", {
      projectId: project.projectId, goal: "no such agent",
      tasks: [{ title: "one", brief: "do it", agentId: "not-installed" }],
    })).rejects.toMatchObject({ code: "invalid_params" });
    await expect(client.call("plan.create", {
      projectId: project.projectId, goal: "a terminal agent",
      tasks: [{ title: "one", brief: "do it", agentId: "shell" }],
    })).rejects.toMatchObject({ code: "invalid_params" });
  }, 40_000);
});
