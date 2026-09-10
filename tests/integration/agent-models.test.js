import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CLI_ENTRY, ROOT, startEngine, tempHome, waitFor, removeHome, TERMINAL } from "./helpers.js";

const engines = [];
const homes = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
  for (const dir of homes.splice(0)) removeHome(dir);
});

const FIXTURE = (name) => path.join(ROOT, "tests", "fixtures", name);

/** One profile with all three structured transports played by fixtures, so nothing reaches a real CLI. */
async function boot({ clientKind = "test" } = {}) {
  const home = tempHome(); homes.push(home);
  const repo = path.join(home, "repo");
  mkdirSync(repo, { recursive: true });
  const agentsDir = path.join(home, "data", "t", "agents");
  mkdirSync(agentsDir, { recursive: true });
  const launcher = (name, fixture, extra = "") => {
    const file = path.join(home, name);
    writeFileSync(file, `#!/bin/sh\nprintf 'start\\n' >> "$0.starts"\n${extra}exec "${process.execPath}" "${FIXTURE(fixture)}" "$@"\n`);
    chmodSync(file, 0o755);
    return file;
  };
  writeFileSync(path.join(agentsDir, "claude.json"), JSON.stringify({ id: "claude", displayName: "Claude Code", binary: launcher("fake-claude", "fake-claude.js"), transport: "claude-stream", modelArgs: ["--model", "{model}"], effortArgs: ["--effort", "{effort}"] }));
  writeFileSync(path.join(agentsDir, "codex.json"), JSON.stringify({ id: "codex", displayName: "Codex", binary: launcher("fake-codex", "fake-codex.js"), transport: "codex-app-server" }));
  writeFileSync(path.join(agentsDir, "grok.json"), JSON.stringify({ id: "grok", displayName: "Grok CLI", binary: launcher("fake-acp", "fake-acp.js", `FAKE_ACP_STATE=${JSON.stringify(path.join(home, "acp-state"))}\nexport FAKE_ACP_STATE\n`), args: ["--acp"], transport: "acp", modelArgs: ["-m", "{model}"], effortArgs: ["--reasoning-effort", "{effort}"] }));

  const engine = await startEngine({ home });
  engines.push(engine);
  const client = await engine.connect({ clientKind });
  const events = [];
  const status = await client.call("engine.status", {});
  await client.subscribe({ after: status.cursor }, { onEvent: (event) => events.push(event) });
  const project = await client.call("project.open", { path: repo });
  /** Ask one agent one thing, and return what it replied. */
  const ask = async (agentId, requestId, prompt) => {
    const { session } = await client.call("session.create", { projectId: project.projectId, workspaceId: project.workspaceId, title: agentId, agentId });
    const { run } = await client.call("run.start", { sessionId: session.id, requestId, prompt });
    await waitFor(() => events.some((e) => e.type === "run.state" && e.runId === run.id && TERMINAL.includes(e.payload.state)), { label: `${requestId} finished`, timeoutMs: 20_000 });
    const snapshot = await client.call("run.snapshot", { runId: run.id });
    const last = snapshot.messages.filter((message) => message.role === "assistant" && message.kind === "text").at(-1);
    return { run: snapshot.run, reply: last ? (await client.call("artifact.read", { artifactId: last.artifactId })).text : null };
  };
  const catalogEntry = async (agentId) => (await client.call("agent.catalog", {})).agents.find((entry) => entry.id === agentId);
  return { home, repo, engine, client, events, project, ask, catalogEntry };
}

describe("choosing a model for each hosted agent", () => {
  test("agents share one durable chat, receive its history, and cannot switch an unfinished run", async () => {
    const { home, engine, client, project } = await boot();
    const { session } = await client.call("session.create", { projectId: project.projectId, workspaceId: project.workspaceId, title: "Shared objective" });
    const page = () => client.call("session.page", { sessionId: session.id });
    const select = async (agentId) => client.call("session.setAgent", { sessionId: session.id, agentId, expectedRevision: (await page()).session.revision });
    const turn = async (requestId, prompt) => {
      const { run } = await client.call("run.start", { sessionId: session.id, requestId, prompt });
      await waitFor(async () => TERMINAL.includes((await client.call("run.snapshot", { runId: run.id })).run.state));
      const snapshot = await client.call("run.snapshot", { runId: run.id });
      expect(snapshot.run.state).toBe("completed");
      const answer = snapshot.messages.filter((message) => message.role === "assistant" && message.kind === "text").at(-1);
      return (await client.call("artifact.read", { artifactId: answer.artifactId })).text;
    };
    await turn("req_objective", "keep the shared objective");
    for (const agentId of ["claude", "codex", "grok"]) {
      const before = (await page()).session;
      const changed = (await select(agentId)).session;
      expect(changed).toMatchObject({ id: session.id, agentId, title: session.title, workspaceId: session.workspaceId, revision: before.revision + 1 });
      await expect(client.call("session.setAgent", { sessionId: session.id, agentId: null, expectedRevision: before.revision })).rejects.toMatchObject({ code: "conflict" });
      const reply = await turn(`req_${agentId}_history`, "history");
      expect(reply).toContain("Fresh agent context:");
      expect(reply).toContain("done: keep the shared objective");
      const current = (await page()).session;
      expect((await select(agentId)).session.revision).toBe(current.revision); // Re-selecting is a no-op, preserving native continuation.
      expect(await turn(`req_${agentId}_continue`, "history")).toBe("Resumed context: history");
    }
    await expect(select("missing-agent")).rejects.toMatchObject({ code: "not_found" });
    await expect(select("shell")).rejects.toMatchObject({ code: "invalid_params" });
    expect((await page()).session.agentId).toBe("grok");

    const { run } = await client.call("run.start", { sessionId: session.id, requestId: "req_busy_switch", prompt: "sleep" });
    await expect(select("claude")).rejects.toMatchObject({ code: "conflict" });
    expect((await page()).session.agentId).toBe("grok");
    await client.call("run.cancel", { runId: run.id });
    await waitFor(async () => TERMINAL.includes((await client.call("run.snapshot", { runId: run.id })).run.state));
    await select(null);
    expect(await turn("req_back_to_jolo", "continue the objective")).toContain("done: continue the objective");
    await select("claude");
    expect((await client.call("session.list", { projectId: project.projectId })).sessions).toHaveLength(1);
    await client.close(); await engine.stop();

    // Inspect the handoff to Jolo only after the engine releases SQLite ownership.
    const db = new Database(engine.paths.databasePath, { readonly: true });
    try {
      const notes = db.query("SELECT payload FROM conversation_items WHERE session_id = ?1 AND kind = 'system_note'").all(session.id);
      expect(notes.some((row) => JSON.parse(row.payload).text.includes("Resumed context: history"))).toBe(true);
      const remembered = JSON.parse(db.query("SELECT agent_state FROM sessions WHERE id = ?1").get(session.id).agent_state);
      expect(Object.keys(remembered)).toEqual(['_jolo']); // Vendor IDs reset; shared context delivery survives agent selection.
      expect(remembered._jolo.lastAnswerer.id).toBe('jolo');
    } finally { db.close(); }
    const restarted = await startEngine({ home }); engines.push(restarted);
    const next = await restarted.connect();
    try {
      const restored = await next.call("session.page", { sessionId: session.id });
      expect(restored.session).toMatchObject({ id: session.id, agentId: "claude", title: session.title });
      expect(restored.runs).toHaveLength(9);
    } finally { await next.close(); }
  }, 40000);

  test("the model is remembered per agent, merged by patch, and cleared by null", async () => {
    const { client, catalogEntry } = await boot();
    expect((await client.call("settings.get", {})).settings.agents).toEqual({});

    let settings = (await client.call("settings.update", { agents: { claude: { model: "fable", effort: "high" }, codex: { model: "fake-large" } } })).settings;
    expect(settings.agents).toEqual({ claude: { model: "fable", effort: "high" }, codex: { model: "fake-large", effort: null } });

    // A patch touches only what it names, for only the agent it names.
    settings = (await client.call("settings.update", { agents: { claude: { effort: "low" } } })).settings;
    expect(settings.agents.claude).toEqual({ model: "fable", effort: "low" });
    expect(settings.agents.codex).toEqual({ model: "fake-large", effort: null });
    expect(await catalogEntry("claude")).toMatchObject({ model: "fable", effort: "low", supportsModel: true, supportsEffort: true });

    // Clearing both fields is the same as forgetting the agent: it goes back to its own default.
    settings = (await client.call("settings.update", { agents: { claude: { model: null, effort: null }, codex: null } })).settings;
    expect(settings.agents).toEqual({});
    expect(await catalogEntry("claude")).toMatchObject({ model: null, effort: null });
    await expect(client.call("settings.update", { agents: { claude: { model: "" } } })).rejects.toMatchObject({ code: "invalid_params" });
  }, 30_000);

  test("each transport carries the choice its own way: a flag for Claude and ACP, the protocol for Codex", async () => {
    const { client, ask } = await boot();
    // Unconfigured, every agent keeps whatever default it has.
    expect((await ask("claude", "req_claude_default", "model?")).reply).toBe("Running the default model at the default effort.");
    expect((await ask("codex", "req_codex_default", "model?")).reply).toBe("Running the default model at the default effort.");
    expect((await ask("grok", "req_grok_default", "model?")).reply).toBe("Running the default model at the default effort.");

    await client.call("settings.update", { agents: { claude: { model: "fable", effort: "max" }, codex: { model: "fake-large", effort: "high" }, grok: { model: "fake-deep", effort: "low" } } });
    expect((await ask("claude", "req_claude_model", "model?")).reply).toBe("Running fable at max.");
    expect((await ask("codex", "req_codex_model", "model?")).reply).toBe("Running fake-large at high.");
    expect((await ask("grok", "req_grok_model", "model?")).reply).toBe("Running fake-deep at low.");

    // Changing it applies to the next turn, including on a thread the agent is resuming.
    await client.call("settings.update", { agents: { codex: { model: "fake-small" } } });
    expect((await ask("codex", "req_codex_again", "model?")).reply).toBe("Running fake-small at high.");
  }, 60_000);

  test("agents report the models they can run, and Jolo keeps no list of its own", async () => {
    const { client } = await boot();
    const claude = await client.call("agent.models", { agentId: "claude" });
    expect(claude).toMatchObject({ agentId: "claude", source: "agent", note: null });
    expect(claude.models.map((model) => model.id)).toEqual(["default", "fable", "haiku"]);
    expect(claude.models[0]).toMatchObject({ displayName: "Default (recommended)", isDefault: true, efforts: ["low", "high"] });
    expect(claude.models[2].efforts).toEqual([]); // it said this one has no effort levels
    expect(claude.efforts).toEqual(["low", "high", "max"]);

    // Codex pages its answer, so the client has to follow the cursor; the hidden model is not offered.
    const codex = await client.call("agent.models", { agentId: "codex" });
    expect(codex.models.map((model) => model.id)).toEqual(["fake-large", "fake-small"]);
    expect(codex.models[0]).toMatchObject({ displayName: "Fake Large", isDefault: true, efforts: ["low", "high"] });

    // An ACP agent publishes its models as a session config option.
    const grok = await client.call("agent.models", { agentId: "grok" });
    expect(grok.models.map((model) => model.id)).toEqual(["fake-fast", "fake-deep"]);
    expect(grok.models[0]).toMatchObject({ displayName: "Fake Fast", isDefault: true });
    expect(grok.efforts).toEqual(["low", "high"]);
  }, 60_000);

  test("automatic discovery shares probes, reuses results, and refreshes on request", async () => {
    const { client, home } = await boot();
    const binary = path.join(home, "fake-codex");
    const starts = () => readFileSync(`${binary}.starts`, "utf8").trim().split("\n").length;
    const load = (refresh = false) => client.call("agent.models", { agentId: "codex", refresh });
    const reports = await Promise.all([load(), load(), load(true)]);
    expect(reports.every(report => report.source === "agent")).toBe(true);
    expect(starts()).toBe(1);
    expect(await load()).toEqual(reports[0]);
    expect(starts()).toBe(1);
    expect(await load(true)).toEqual(reports[0]);
    expect(starts()).toBe(2);

    // A failed refresh is recoverable on the next open after the installation is fixed.
    const working = readFileSync(binary, "utf8");
    writeFileSync(binary, "#!/bin/sh\nexit 1\n");
    expect((await load(true)).source).toBe("none");
    writeFileSync(binary, working);
    expect((await load()).source).toBe("agent");
    expect(starts()).toBe(3);
  }, 30_000);

  test("the CLI reads and sets the same choice, and asks an agent what it can run", async () => {
    const { home, client } = await boot();
    const jolo = async (...args) => {
      const proc = Bun.spawn([process.execPath, CLI_ENTRY, ...args, "--home", home, "--profile", "t"], { stdout: "pipe", stderr: "pipe", env: { ...process.env } });
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { stdout, stderr, code };
    };
    expect((await jolo("agent", "config", "codex", "--json")).stdout).toContain('"model":null');
    const set = await jolo("agent", "config", "codex", "--model", "fake-large", "--effort", "high", "--json");
    expect(JSON.parse(set.stdout)).toEqual({ agentId: "codex", model: "fake-large", effort: "high" });
    expect((await client.call("settings.get", {})).settings.agents.codex).toEqual({ model: "fake-large", effort: "high" });

    // Naming one field leaves the other alone; --clear forgets the agent entirely.
    expect(JSON.parse((await jolo("agent", "config", "codex", "--model", "fake-small", "--json")).stdout)).toEqual({ agentId: "codex", model: "fake-small", effort: "high" });
    expect((await jolo("agent", "list")).stdout).toContain("fake-small");
    expect(JSON.parse((await jolo("agent", "config", "codex", "--clear", "--json")).stdout)).toEqual({ agentId: "codex", model: null, effort: null });

    const models = await jolo("agent", "models", "codex", "--json");
    expect(JSON.parse(models.stdout).models.map((model) => model.id)).toEqual(["fake-large", "fake-small"]);
    const plain = await jolo("agent", "models", "shell");
    expect(plain.stderr).toContain("runs in a terminal");
  }, 60_000);

  test("an agent Jolo cannot set a model for says so instead of pretending", async () => {
    const { client, engine } = await boot();
    const shell = await client.call("agent.models", { agentId: "shell" });
    expect(shell).toMatchObject({ models: [], efforts: [], source: "none" });
    expect(shell.note).toContain("runs in a terminal");
    await expect(client.call("agent.models", { agentId: "no-such-agent" })).rejects.toMatchObject({ code: "not_found" });

    // Starting an agent is a user's action, so a headless client cannot ask.
    const headless = await engine.connect({ clientKind: "headless" });
    await expect(headless.call("agent.models", { agentId: "claude" })).rejects.toMatchObject({ code: "permission_denied" });
    await headless.close();
  }, 30_000);
});
