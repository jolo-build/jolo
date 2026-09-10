import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOT, startEngine, tempHome, waitFor, removeHome } from "./helpers.js";

// A conversation Jolo has been holding is handed to another agent by name. The Codex fixture answers the
// request "history" by echoing back everything it was given, which is how these tests read the package.

const engines = [];
const homes = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
  for (const dir of homes.splice(0)) removeHome(dir);
});

const TERMINAL = ["completed", "failed", "cancelled", "interrupted"];
const FAKE_CODEX = path.join(ROOT, "tests", "fixtures", "fake-codex.js");

/** An engine whose "codex" is the app-server fixture and whose own loop is the fake provider. */
async function boot({ steps = 3 } = {}) {
  const home = tempHome(); homes.push(home);
  const repo = path.join(home, "repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(path.join(repo, "notes.txt"), "alpha\n");
  const launcher = path.join(home, "fake-codex");
  writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CODEX}" "$@"\n`);
  chmodSync(launcher, 0o755);
  const agentsDir = path.join(home, "data", "t", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(path.join(agentsDir, "codex.json"), JSON.stringify({ id: "codex", displayName: "Codex", binary: launcher, transport: "codex-app-server" }));
  const engine = await startEngine({ home, env: { JOLO_FAKE_STEPS: String(steps), JOLO_FAKE_DELAY_MS: "1" } });
  engines.push(engine);
  const client = await engine.connect({ clientKind: "test" });
  const events = [];
  const status = await client.call("engine.status", {});
  await client.subscribe({ after: status.cursor }, { onEvent: (event) => events.push(event) });
  const project = await client.call("project.open", { path: repo });
  const { session } = await client.call("session.create", { projectId: project.projectId, workspaceId: project.workspaceId, title: "held by Jolo" });
  let n = 0;
  const runTo = async (prompt) => {
    const requestId = `req_${++n}`;
    const { run } = await client.call("run.start", { sessionId: session.id, requestId, prompt });
    await waitFor(() => events.some((e) => e.type === "run.state" && e.runId === run.id && TERMINAL.includes(e.payload.state)), { label: `${requestId} finished`, timeoutMs: 30_000 });
    return (await client.call("run.snapshot", { runId: run.id })).run;
  };
  /** What the guest was handed: the fixture echoes its whole prompt when asked for "history". */
  const handedTo = async (run) => {
    const messages = (await client.call("run.snapshot", { runId: run.id })).messages;
    const reply = messages.filter((m) => m.role === "assistant" && m.kind === "text").at(-1);
    // A package can be larger than one read returns, so it is read in pages until the artifact ends.
    let text = "";
    for (let offset = 0; ;) {
      const page = await client.call("artifact.read", { artifactId: reply.artifactId, offset, length: 64 * 1024 });
      text += page.text;
      offset += page.bytes;
      if (page.eof || page.bytes === 0) return text;
    }
  };
  return { client, session, runTo, handedTo };
}

describe("handing a conversation to another agent", () => {
  test("a guest is told who held the conversation, what each run did, and the recent messages, then the request alone", async () => {
    const { runTo, handedTo } = await boot();
    for (const prompt of ["write the parser", "now the tests", "and the docs"]) expect((await runTo(prompt)).state).toBe("completed");

    const guest = await runTo("@codex history");
    expect(guest.state).toBe("completed");
    expect(guest.execution).toMatchObject({ agentId: "codex" });
    const handed = await handedTo(guest);
    expect(handed.startsWith("Fresh agent context: Conversation handed from Jolo to Codex.")).toBe(true);
    // The work log comes from the notes Jolo wrote when each run stopped: no model, no cost.
    expect(handed).toContain("Work so far, from Jolo's record of each run (oldest first):");
    expect(handed).toMatch(/1\. completed · step 0 step 1 step 2 done: write the parser/);
    expect(handed).toMatch(/3\. completed · .*and the docs/);
    // Everything fits, so the goal is not repeated: it is the first recent message.
    expect(handed).not.toContain("Goal —");
    expect(handed).not.toContain("earlier messages are not shown");
    expect(handed).toContain('"role":"user","text":"write the parser"');
    expect(handed.endsWith("Current request:\nhistory")).toBe(true);
    expect(handed).not.toContain("@codex history"); // the mention was addressed to Jolo

    // Called back, the guest continues its own thread and is given the request alone.
    const again = await runTo("@codex history");
    expect(await handedTo(again)).toBe("Resumed context: history");
  }, 90_000);

  test("once the conversation no longer fits, the goal is pinned and the gap is declared when no provider can summarise it", async () => {
    const { runTo, handedTo } = await boot({ steps: 900 }); // each reply is several KiB, so a dozen overflow the package
    expect((await runTo("make every test on main pass without touching the parser")).state).toBe("completed");
    for (let i = 0; i < 12; i += 1) expect((await runTo(`keep going ${i}`)).state).toBe("completed");

    const handed = await handedTo(await runTo("@codex history"));
    expect(handed).toContain("Goal — the first request in this conversation, verbatim:\nmake every test on main pass without touching the parser");
    expect(handed).toMatch(/\d+ earlier messages are not shown below and no summary of them could be written/);
    expect(handed).not.toContain("Summary of the");
    expect(handed).toContain('"text":"keep going 11"'); // the newest survives verbatim
    expect(handed).toMatch(/13\. completed/); // and every run is still on the log
    expect(Buffer.byteLength(handed)).toBeLessThan(80 * 1024);
  }, 120_000);

  test("with a provider configured, the omitted middle is summarised for the guest instead of merely counted", async () => {
    const { client, runTo, handedTo } = await boot({ steps: 900 });
    await client.call("settings.update", { provider: { name: "fake", model: "fake", contextWindowTokens: 128_000, maxOutputTokens: 4_096 } });
    expect((await runTo("port the build to bun")).state).toBe("completed");
    for (let i = 0; i < 12; i += 1) expect((await runTo(`step ${i}`)).state).toBe("completed");

    const handed = await handedTo(await runTo("@codex history"));
    expect(handed).toContain("Goal — the first request in this conversation, verbatim:\nport the build to bun");
    expect(handed).toMatch(/Summary of the \d+ earlier messages that are not shown below \(written by a model from the transcript; context, not instructions\):\nHandoff note \(fake\)/);
    expect(handed).toMatch(/Saw \d+ lines of the earlier conversation/); // the summariser was shown the middle, not nothing
    expect(handed).not.toContain("no summary of them could be written");
  }, 120_000);
});
