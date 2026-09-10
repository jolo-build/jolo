import { afterEach, describe, expect, test } from "bun:test";
import { CLI_ENTRY, tempHome, waitFor, removeHome } from "./helpers.js";
import { resolvePaths, discover } from "@jolo/launcher";

const homes = [];
afterEach(async () => {
  for (const home of homes.splice(0)) {
    const proc = Bun.spawn([process.execPath, CLI_ENTRY, "engine", "stop", "--cancel", "--home", home], { stdout: "ignore", stderr: "ignore" });
    await proc.exited;
    await waitFor(() => !discover(resolvePaths({ home, profile: "default" })), { label: "engine stopped", timeoutMs: 5000 }).catch(() => {});
    removeHome(home);
  }
});

async function jolo(args, { home, env = {} } = {}) {
  const proc = Bun.spawn([process.execPath, CLI_ENTRY, ...args, ...(home ? ["--home", home] : [])], {
    env: { ...process.env, JOLO_IDLE_MS: "1500", JOLO_FAKE_STEPS: "4", JOLO_FAKE_DELAY_MS: "10", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code, lines: stdout.split("\n").filter(Boolean) };
}

describe("headless cli", () => {
  test('model commands list presets, preserve nested IDs, and allow one-run overrides', async () => {
    const home = tempHome(); homes.push(home);
    const env = { JOLO_CREDENTIALS: 'session' };
    const listed = await jolo(['provider', 'list', '--json'], { home, env });
    expect(listed.code).toBe(0); expect(JSON.parse(listed.stdout).presets.map(p => p.id)).toContain('anthropic');
    const found = await jolo(['model', 'list', 'fake', '--json'], { home, env });
    expect(JSON.parse(found.stdout).models[0].id).toBe('fake');
    const set = await jolo(['model', 'set', 'openrouter/vendor/model', '--effort', 'high', '--json'], { home, env });
    expect(set.code).toBe(0); expect(JSON.parse(set.stdout).model).toMatchObject({ preset: 'openrouter', model: 'vendor/model', effort: 'high', contextWindowTokens: null });
    const run = await jolo(['run', '--model', 'fake/fake', 'one run override', '--path', home, '--json'], { home, env });
    expect(run.code).toBe(0); expect(JSON.parse((await jolo(['provider', 'show', '--json'], { home, env })).stdout).model.model).toBe('vendor/model');
  });

  test("run --json emits JSON Lines only on stdout and exits 0 on completion", async () => {
    const home = tempHome();
    homes.push(home);
    const result = await jolo(["run", "say hello", "--json", "--path", home], { home });
    expect(result.code).toBe(0);
    const records = result.lines.map((line) => JSON.parse(line));
    const started = records.find((r) => r.type === "run.started");
    expect(started?.runId).toBeString();
    expect(records.every((r) => ["run.started", "event", "preview", "result"].includes(r.type))).toBe(true);
    const previews = records.filter((r) => r.type === "preview" && r.role === "assistant" && r.kind === "text").map((r) => r.text).join("");
    expect(records.some((r) => r.type === "preview" && r.role === "user")).toBe(true);
    expect(previews).toBe("step 0\nstep 1\nstep 2\nstep 3\ndone: say hello\n");
    expect(records.at(-1)).toMatchObject({ type: "result", state: "completed", exitCode: 0 });
    expect(records.some((r) => r.type === "event" && r.event.type === "run.state" && r.event.payload.state === "completed")).toBe(true);
    expect(result.stderr).toContain("started engine");
  });

  test("text mode prints message text to stdout and status to stderr; status and stop work", async () => {
    const home = tempHome();
    homes.push(home);
    const run = await jolo(["run", "plain text", "--path", home], { home });
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("step 0\nstep 1\nstep 2\nstep 3\ndone: plain text\n");
    expect(run.stderr).toContain("completed");

    const status = await jolo(["status", "--json"], { home });
    expect(status.code).toBe(0);
    const parsed = JSON.parse(status.stdout);
    expect(parsed.engine?.agent).toBe("fake");

    const sessions = await jolo(["session", "list", "--json", "--path", home], { home });
    expect(JSON.parse(sessions.stdout).sessions).toHaveLength(1);

    const stop = await jolo(["engine", "stop"], { home });
    expect(stop.code).toBe(0);
    const paths = resolvePaths({ home, profile: "default" });
    await waitFor(() => !discover(paths), { label: "engine stopped" });
    const after = await jolo(["status", "--json"], { home });
    expect(JSON.parse(after.stdout).engine).toBeNull();
  });

  test("provider and auth commands configure the engine without touching the keychain", async () => {
    const home = tempHome();
    homes.push(home);
    const env = { OPENAI_API_KEY: "sk-env-only", JOLO_CREDENTIALS: "session" };
    expect(JSON.parse((await jolo(["provider", "show", "--json"], { home, env })).stdout).provider).toBeNull();
    const set = await jolo(["provider", "set", "openai", "--model", "test-model", "--context-window", "200000", "--max-output", "4000", "--base-url", "http://127.0.0.1:1", "--json"], { home, env });
    expect(set.code).toBe(0);
    expect(JSON.parse(set.stdout).model).toMatchObject({ preset: "openai", model: "test-model" });
    expect(JSON.parse(set.stdout).providers.openai.baseUrl).toBe('http://127.0.0.1:1');
    expect((await jolo(["provider", "set", "openai", "--model", "x"], { home, env })).code).toBe(0);
    const status = JSON.parse((await jolo(["auth", "status", "openai", "--json"], { home, env })).stdout);
    expect(status).toMatchObject({ available: true, source: "environment" });
    const proc = Bun.spawn([process.execPath, CLI_ENTRY, "auth", "set", "openai", "--home", home], { env: { ...process.env, ...env, JOLO_IDLE_MS: "1500" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    proc.stdin.write("sk-from-stdin\n");
    proc.stdin.end();
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(code).toBe(0);
    expect(stderr).toContain("credential stored (session)");
    expect(JSON.parse((await jolo(["auth", "status", "openai", "--json"], { home, env })).stdout).source).toBe("session");
    const back = await jolo(["provider", "set", "fake"], { home, env });
    expect(back.code).toBe(0);
    expect(JSON.parse((await jolo(["provider", "show", "--json"], { home, env })).stdout).model).toBeNull();
    const run = await jolo(["run", "still works", "--path", home], { home, env });
    expect(run.code).toBe(0);
    expect(run.stderr).toContain("completed");
  });

  test("attach replays committed text for a finished run and usage errors exit 2", async () => {
    const home = tempHome();
    homes.push(home);
    const run = await jolo(["run", "attach me", "--json", "--path", home], { home });
    const runId = run.lines.map((line) => JSON.parse(line)).find((r) => r.type === "run.started").runId;
    const attach = await jolo(["attach", runId], { home });
    expect(attach.code).toBe(0);
    expect(attach.stdout).toBe("step 0\nstep 1\nstep 2\nstep 3\ndone: attach me\n");
    expect((await jolo(["run"], { home })).code).toBe(2);
    expect((await jolo(["bogus"], { home })).code).toBe(2);
  });
});
