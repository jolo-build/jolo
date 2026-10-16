import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOT, startEngine, tempHome, removeHome } from "./helpers.js";

const engines = [];
const homes = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
  for (const dir of homes.splice(0)) removeHome(dir);
});

const FIXTURE = (name) => path.join(ROOT, "tests", "fixtures", name);
const unix = (seconds) => new Date(seconds * 1000).toISOString();

/**
 * One profile whose Claude, Codex and Grok are played by fixtures, so nothing reaches a real CLI. Each launcher
 * counts its starts in "<launcher>.starts" and sources "<launcher>.env" when that exists, so a test can script
 * how the vendor answers (FAKE_CLAUDE_USAGE, FAKE_CODEX_LIMITS) between two calls to the same engine.
 */
async function boot() {
  const home = tempHome(); homes.push(home);
  const agentsDir = path.join(home, "data", "t", "agents");
  mkdirSync(agentsDir, { recursive: true });
  const launcher = (name, fixture) => {
    const file = path.join(home, name);
    writeFileSync(file, `#!/bin/sh\nprintf 'start\\n' >> "$0.starts"\nif [ -f "$0.env" ]; then . "$0.env"; fi\nexec "${process.execPath}" "${FIXTURE(fixture)}" "$@"\n`);
    chmodSync(file, 0o755);
    return file;
  };
  writeFileSync(path.join(agentsDir, "claude.json"), JSON.stringify({ id: "claude", displayName: "Claude Code", binary: launcher("fake-claude", "fake-claude.js"), transport: "claude-stream", modelArgs: ["--model", "{model}"], effortArgs: ["--effort", "{effort}"] }));
  writeFileSync(path.join(agentsDir, "codex.json"), JSON.stringify({ id: "codex", displayName: "Codex", binary: launcher("fake-codex", "fake-codex.js"), transport: "codex-app-server" }));
  writeFileSync(path.join(agentsDir, "grok.json"), JSON.stringify({ id: "grok", displayName: "Grok CLI", binary: launcher("fake-acp", "fake-acp.js"), args: ["--acp"], transport: "acp", modelArgs: ["-m", "{model}"], effortArgs: ["--reasoning-effort", "{effort}"] }));

  const engine = await startEngine({ home });
  engines.push(engine);
  const client = await engine.connect({ clientKind: "test" });
  /** How many times a launcher has started its CLI so far. */
  const starts = (name) => {
    const file = path.join(home, `${name}.starts`);
    return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").length : 0;
  };
  /** The environment a launcher hands its CLI from its next start on; an empty object restores the default answer. */
  const script = (name, vars) => writeFileSync(path.join(home, `${name}.env`), Object.entries(vars).map(([key, value]) => `export ${key}=${value}\n`).join(""));
  const limits = (agentId, refresh) => client.call("agent.limits", { agentId, refresh });
  return { engine, client, starts, script, limits };
}

describe("asking a hosted agent how much of its plan is used", () => {
  test("an answer is reused inside the cache window, and refresh asks the agent again", async () => {
    const { starts, limits } = await boot();
    for (const [agentId, name] of [["claude", "fake-claude"], ["codex", "fake-codex"]]) {
      const first = await limits(agentId, false);
      expect(first).toMatchObject({ agentId, source: "agent", note: null });
      expect(first.windows.length).toBeGreaterThan(0);
      expect(starts(name)).toBe(1);

      expect(await limits(agentId, false)).toEqual(first); // the very same answer, checkedAt included
      expect(starts(name)).toBe(1);

      const refreshed = await limits(agentId, true);
      expect(starts(name)).toBe(2);
      expect(refreshed).toMatchObject({ agentId, windows: first.windows, plan: first.plan, source: "agent", note: null });
      expect(await limits(agentId, false)).toEqual(refreshed); // the refreshed answer is the one kept
      expect(starts(name)).toBe(2);
    }
  }, 30_000);

  test("concurrent requests for one agent share a single probe, a refresh among them included", async () => {
    const { starts, limits } = await boot();
    const reports = await Promise.all([limits("claude", false), limits("claude", true), limits("claude", false)]);
    expect(starts("fake-claude")).toBe(1);
    expect(reports[0]).toMatchObject({ agentId: "claude", source: "agent" });
    expect(reports[1]).toEqual(reports[0]);
    expect(reports[2]).toEqual(reports[0]);

    // A refresh of one agent does not start another's CLI.
    const [claude, codex] = await Promise.all([limits("claude", true), limits("codex", false)]);
    expect(claude).toMatchObject({ agentId: "claude", source: "agent" });
    expect(codex).toMatchObject({ agentId: "codex", source: "agent" });
    expect(starts("fake-claude")).toBe(2);
    expect(starts("fake-codex")).toBe(1);
  }, 30_000);

  test("Claude refusing get_usage is reported in its own words", async () => {
    const { starts, script, limits } = await boot();
    script("fake-claude", { FAKE_CLAUDE_USAGE: "error" });
    expect(await limits("claude", false)).toMatchObject({ agentId: "claude", windows: [], plan: null, source: "none", note: "fake-claude: usage endpoint returned 503" });
    expect(starts("fake-claude")).toBe(1);

    script("fake-claude", {});
    expect(await limits("claude", true)).toMatchObject({ source: "agent", plan: "max", note: null });
    expect(starts("fake-claude")).toBe(2);
  }, 30_000);

  test("a refused get_usage is not kept: the next call asks Claude again", async () => {
    const { starts, script, limits } = await boot();
    script("fake-claude", { FAKE_CLAUDE_USAGE: "error" });
    expect((await limits("claude", false)).note).toBe("fake-claude: usage endpoint returned 503");
    expect(starts("fake-claude")).toBe(1);

    expect((await limits("claude", false)).note).toBe("fake-claude: usage endpoint returned 503");
    expect(starts("fake-claude")).toBe(2);

    // Once Claude answers again, so does the panel, without asking for a refresh.
    script("fake-claude", {});
    expect(await limits("claude", false)).toMatchObject({ source: "agent", plan: "max", note: null });
    expect(starts("fake-claude")).toBe(3);
  }, 30_000);

  test("an API-key sign-in has no plan limits, and that answer is kept like any other", async () => {
    const { starts, script, limits } = await boot();
    script("fake-claude", { FAKE_CLAUDE_USAGE: "api-key" });
    const first = await limits("claude", false);
    expect(first).toMatchObject({ agentId: "claude", windows: [], plan: null, source: "none", note: "Claude Code reports no plan limits for this sign-in" });
    expect(await limits("claude", false)).toEqual(first);
    expect(starts("fake-claude")).toBe(1);
  }, 30_000);

  test("a CLI that exits without answering is reported with its exit and asked again on the next call", async () => {
    const { starts, script, limits } = await boot();
    script("fake-claude", { FAKE_CLAUDE_USAGE: "exit" });
    const gone = await limits("claude", false);
    expect(gone).toMatchObject({ agentId: "claude", windows: [], plan: null, source: "none" });
    expect(gone.note).toBe("Claude Code exited 3 without an answer: fake-claude: scripted exit before answering get_usage");
    expect(starts("fake-claude")).toBe(1);

    expect((await limits("claude", false)).source).toBe("none");
    expect(starts("fake-claude")).toBe(2);

    script("fake-claude", {});
    expect(await limits("claude", false)).toMatchObject({ source: "agent", note: null });
    expect(starts("fake-claude")).toBe(3);
  }, 30_000);

  test("Codex reports a refusal as its note, does not keep it, and lists each bucket's windows in order", async () => {
    const { starts, script, limits } = await boot();
    script("fake-codex", { FAKE_CODEX_LIMITS: "error" });
    expect(await limits("codex", false)).toMatchObject({ agentId: "codex", windows: [], plan: null, source: "none", note: "fake-codex: rate limits need a ChatGPT sign-in" });
    expect(starts("fake-codex")).toBe(1);

    // The refusal was not kept, so the panel's next ask reaches Codex without a refresh.
    script("fake-codex", {});
    expect(await limits("codex", false)).toMatchObject({ source: "agent", note: null });
    expect(starts("fake-codex")).toBe(2);

    // A weekly-only bucket (secondary: null, as 0.153.3 sent it live) and a named bucket with a 5-hour and a weekly window.
    script("fake-codex", { FAKE_CODEX_LIMITS: "buckets" });
    const report = await limits("codex", true);
    expect(report).toMatchObject({ agentId: "codex", plan: "self serve business usage based", source: "agent", note: null });
    expect(report.windows).toEqual([
      { label: "Weekly", usedPercent: 17, resetsAt: unix(1792497649) },
      { label: "5-hour · Fake Spark", usedPercent: 3, resetsAt: unix(1792018200) },
      { label: "Weekly · Fake Spark", usedPercent: 8, resetsAt: unix(1792497649) },
    ]);
  }, 30_000);

  test("while Claude cannot fetch its usage it keeps the plan, says so, and is asked again next time", async () => {
    const { starts, script, limits } = await boot();
    script("fake-claude", { FAKE_CLAUDE_USAGE: "unavailable" });
    expect(await limits("claude", false)).toMatchObject({ agentId: "claude", windows: [], plan: "max", source: "none", note: "Claude Code could not fetch its usage limits right now" });
    expect(starts("fake-claude")).toBe(1);

    script("fake-claude", {});
    expect(await limits("claude", false)).toMatchObject({ source: "agent", plan: "max", note: null });
    expect(starts("fake-claude")).toBe(2);
  }, 30_000);

  test("names longer than agent.limits may carry are cut instead of failing the call", async () => {
    const { script, limits } = await boot();
    script("fake-claude", { FAKE_CLAUDE_USAGE: "long" });
    const report = await limits("claude", false);
    expect(report).toMatchObject({ agentId: "claude", source: "agent", plan: "p".repeat(80) });
    expect(report.windows.map((window) => window.label)).toEqual(["5-hour", "Weekly", `Weekly · ${"m".repeat(200)}`.slice(0, 120)]);
  }, 30_000);

  test("an agent that never answers is reported after the probe's wait and asked again next time", async () => {
    const { starts, script, limits } = await boot();
    script("fake-claude", { FAKE_CLAUDE_USAGE: "hang" });
    expect(await limits("claude", false)).toMatchObject({ agentId: "claude", windows: [], plan: null, source: "none", note: "Claude Code did not answer within 15 seconds" });
    expect(starts("fake-claude")).toBe(1);

    script("fake-claude", {});
    expect(await limits("claude", false)).toMatchObject({ source: "agent", note: null });
    expect(starts("fake-claude")).toBe(2);
  }, 30_000);

  test("the catalog says which agents can report usage limits", async () => {
    const { client } = await boot();
    const { agents } = await client.call("agent.catalog", {});
    const support = Object.fromEntries(agents.map((entry) => [entry.id, { transport: entry.transport, supportsLimits: entry.supportsLimits }]));
    expect(support).toMatchObject({
      claude: { transport: "claude-stream", supportsLimits: true },
      codex: { transport: "codex-app-server", supportsLimits: true },
      grok: { transport: "acp", supportsLimits: false },
      antigravity: { transport: "antigravity-stream", supportsLimits: true },
      shell: { transport: "pty", supportsLimits: false },
    });
    expect(agents.filter((entry) => entry.supportsLimits).map((entry) => entry.id).sort()).toEqual(["antigravity", "claude", "codex"]);
  }, 30_000);

  test("an unknown agent, a headless client and an agent without limits are answered without starting a CLI", async () => {
    const { engine, starts, limits } = await boot();
    await expect(limits("no-such-agent", false)).rejects.toMatchObject({ code: "not_found" });

    // Starting an agent is a user's action, so a headless client cannot ask.
    const headless = await engine.connect({ clientKind: "headless" });
    await expect(headless.call("agent.limits", { agentId: "claude", refresh: false })).rejects.toMatchObject({ code: "permission_denied" });
    await headless.close();

    expect(await limits("grok", false)).toMatchObject({ agentId: "grok", windows: [], plan: null, source: "none", note: "Grok CLI does not report usage limits" });
    expect(await limits("shell", false)).toMatchObject({ agentId: "shell", windows: [], plan: null, source: "none", note: "Login shell does not report usage limits" });
    expect(starts("fake-acp")).toBe(0);
    expect(starts("fake-claude")).toBe(0);
  }, 30_000);
});
