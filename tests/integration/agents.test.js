import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { startEngine, tempHome, waitFor, removeHome } from "./helpers.js";

const engines = [];
const homes = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
  for (const dir of homes.splice(0)) removeHome(dir);
});

/** A stand-in for a vendor CLI: asks a question, waits for the answer, then exits with a distinctive code. */
const FIXTURE = `#!/bin/sh
printf 'fixture agent ready\\n'
printf 'Do you want to proceed? (y/n) '
read answer
printf '\\nanswered %s\\n' "$answer"
exit 7
`;

test("a hosted agent runs in its workspace, reports observed status, and stops with the user in control", async () => {
  const home = tempHome(); homes.push(home);
  const repo = path.join(home, "repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(path.join(repo, "marker.txt"), "hello\n");
  const script = path.join(home, "fixture-agent.sh");
  writeFileSync(script, FIXTURE);
  chmodSync(script, 0o755);
  // A user manifest, discovered from the profile's agents directory before the engine starts.
  const agentsDir = path.join(home, "data", "t", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(path.join(agentsDir, "fixture.json"), JSON.stringify({
    id: "fixture", displayName: "Fixture Agent", description: "test double", binary: script,
    statusModel: "screen", idleMs: 600,
    rules: [
      { id: "asks", state: "needs_input", priority: 1000, region: "bottom", regionLines: 6, contains: "(y/n)" },
      { id: "busy", state: "working", priority: 500, region: "bottom", regionLines: 6, regex: "fixture agent ready" },
    ],
  }));
  writeFileSync(path.join(agentsDir, "broken.json"), "{ not json");

  const engine = await startEngine({ home });
  engines.push(engine);
  const client = await engine.connect();
  try {
    const events = [];
    const status = await client.call("engine.status", {});
    await client.subscribe({ after: status.cursor }, { onEvent: (event) => events.push(event) });

    const { agents: catalog } = await client.call("agent.catalog", {});
    const fixture = catalog.find((entry) => entry.id === "fixture");
    expect(fixture).toMatchObject({ displayName: "Fixture Agent", available: true, source: "user", statusModel: "screen", resolvedPath: script });
    expect(catalog.map((entry) => entry.id)).toContain("claude"); // built-ins are always offered, installed or not
    expect(catalog.find((entry) => entry.id === "broken")).toBeUndefined(); // the malformed manifest was skipped
    expect(catalog.find((entry) => entry.id === "shell").available).toBe(true);

    const project = await client.call("project.open", { path: repo });
    const started = await client.call("agent.start", { workspaceId: project.workspaceId, agentId: "fixture", cols: 80, rows: 24 });
    expect(started.agent).toMatchObject({ agentId: "fixture", displayName: "Fixture Agent", workspaceId: project.workspaceId, exitCode: null });
    expect(started.terminal.agentId).toBe("fixture");
    expect(started.inputLease).toBe(true);
    const terminalId = started.agent.terminalId;
    await waitFor(() => events.some((event) => event.type === "agent.started" && event.payload.terminalId === terminalId), { label: "agent.started" });

    // The question on screen is observed, and the answer says which signal produced it.
    const asking = await waitFor(() => events.find((event) => event.type === "agent.status" && event.payload.status === "needs_input"), { label: "needs_input", timeoutMs: 15_000 });
    expect(asking.payload).toMatchObject({ terminalId, agentId: "fixture", source: "screen", detail: "asks" });
    expect((await client.call("agent.list", { workspaceId: project.workspaceId })).agents[0]).toMatchObject({ status: "needs_input", statusSource: "screen", statusDetail: "asks" });

    // Input is the user's, through the ordinary terminal lease: Jolo never answers for them.
    await client.call("terminal.input", { terminalId, data: "y\n" });
    const exited = await waitFor(() => events.find((event) => event.type === "agent.exited"), { label: "agent.exited", timeoutMs: 15_000 });
    expect(exited.payload).toMatchObject({ terminalId, agentId: "fixture", exitCode: 7 });
    await waitFor(() => events.some((event) => event.type === "agent.status" && event.payload.status === "done" && event.payload.source === "process" && event.payload.detail === "exit 7"), { label: "done" });
    expect((await client.call("agent.list", {})).agents[0]).toMatchObject({ status: "done", exitCode: 7 });

    expect(await client.call("agent.stop", { terminalId })).toEqual({ stopped: true });
    expect((await client.call("agent.list", {})).agents).toHaveLength(0);
    await expect(client.call("agent.start", { workspaceId: project.workspaceId, agentId: "no-such-agent" })).rejects.toMatchObject({ code: "not_found" });

    const headless = await engine.connect({ clientKind: "headless" });
    await expect(headless.call("agent.start", { workspaceId: project.workspaceId, agentId: "fixture" })).rejects.toMatchObject({ code: "permission_denied" });
    expect((await headless.call("agent.catalog", {})).agents.length).toBeGreaterThan(0); // reading the catalog is fine
    await headless.close();
  } finally {
    await client.close();
  }
}, 40_000);

test("an agent whose binary is missing is offered but refuses to start, and silence becomes idle", async () => {
  const home = tempHome(); homes.push(home);
  const repo = path.join(home, "repo");
  mkdirSync(repo, { recursive: true });
  const agentsDir = path.join(home, "data", "t", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(path.join(agentsDir, "absent.json"), JSON.stringify({ id: "absent", displayName: "Absent", binary: "definitely-not-installed-jolo" }));
  writeFileSync(path.join(agentsDir, "quiet.json"), JSON.stringify({ id: "quiet", displayName: "Quiet", binary: "/bin/cat", statusModel: "screen", idleMs: 600 }));

  const engine = await startEngine({ home });
  engines.push(engine);
  const client = await engine.connect();
  try {
    const events = [];
    const status = await client.call("engine.status", {});
    await client.subscribe({ after: status.cursor }, { onEvent: (event) => events.push(event) });
    const { agents: catalog } = await client.call("agent.catalog", {});
    expect(catalog.find((entry) => entry.id === "absent")).toMatchObject({ available: false, resolvedPath: null });

    const project = await client.call("project.open", { path: repo });
    await expect(client.call("agent.start", { workspaceId: project.workspaceId, agentId: "absent" })).rejects.toMatchObject({ code: "unavailable" });

    // cat produces nothing until it is written to: no rule matches, so silence has to answer.
    const started = await client.call("agent.start", { workspaceId: project.workspaceId, agentId: "quiet", cols: 80, rows: 24 });
    await client.call("terminal.input", { terminalId: started.agent.terminalId, data: "wake\n" });
    await waitFor(() => events.some((event) => event.type === "agent.status" && event.payload.status === "idle" && event.payload.source === "silence"), { label: "idle from silence", timeoutMs: 15_000 });
    await client.call("agent.stop", { terminalId: started.agent.terminalId });
  } finally {
    await client.close();
  }
}, 40_000);
