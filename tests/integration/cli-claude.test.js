// The headless CLI following a hosted Claude Code conversation: Claude's questions and plans reach the terminal as plain
// text with the command that answers them, and background work left running when the run ends is named with the
// command that stops it. The "claude" of these profiles is the protocol fixture, so nothing reaches the real CLI.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { discover, resolvePaths } from "@jolo/launcher";
import { CLI_ENTRY, ROOT, tempHome, waitFor, removeHome } from "./helpers.js";

const FAKE = path.join(ROOT, "tests", "fixtures", "fake-claude.js");
const ENV = { JOLO_IDLE_MS: "5000" };
const homes = [];
afterEach(async () => {
  for (const home of homes.splice(0)) {
    const proc = Bun.spawn([process.execPath, CLI_ENTRY, "engine", "stop", "--cancel", "--home", home], { stdout: "ignore", stderr: "ignore", env: { ...process.env, ...ENV } });
    await proc.exited;
    await waitFor(() => !discover(resolvePaths({ home, profile: "default" })), { label: "engine stopped", timeoutMs: 10_000 }).catch(() => {});
    removeHome(home);
  }
});

function boot() {
  const home = tempHome(); homes.push(home);
  const repo = path.join(home, "repo"); mkdirSync(repo, { recursive: true });
  const launcher = path.join(home, "fake-claude");
  writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`); chmodSync(launcher, 0o755);
  const agentsDir = path.join(home, "data", "default", "agents"); mkdirSync(agentsDir, { recursive: true });
  writeFileSync(path.join(agentsDir, "claude.json"), JSON.stringify({ id: "claude", displayName: "Claude Code", binary: launcher, transport: "claude-stream" }));
  return { home, repo };
}

/** A CLI command run to completion. */
async function jolo(args, home) {
  const proc = Bun.spawn([process.execPath, CLI_ENTRY, ...args, "--home", home], { env: { ...process.env, ...ENV }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

/** A CLI command followed while it runs: what it has printed so far, and its exit code once it is done. */
function follow(args, home) {
  const proc = Bun.spawn([process.execPath, CLI_ENTRY, ...args, "--home", home], { env: { ...process.env, ...ENV }, stdout: "pipe", stderr: "pipe" });
  const collected = { stdout: "", stderr: "" };
  const decoder = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  const tail = async (stream, key) => { for await (const chunk of stream) collected[key] += decoder[key].decode(chunk, { stream: true }); };
  const done = Promise.all([tail(proc.stdout, "stdout"), tail(proc.stderr, "stderr"), proc.exited]).then(() => proc.exitCode);
  return { proc, stdout: () => collected.stdout, stderr: () => collected.stderr, done };
}

const records = (stdout) => stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));

describe("the headless CLI with a hosted Claude", () => {
  test("a question Claude asks is announced with how to answer it, and jolo dialog answer sends the chosen option back", async () => {
    const { home, repo } = boot();
    const run = follow(["run", "ask-user tea or coffee?", "--agent", "claude", "--path", repo, "--json"], home);
    try {
      await waitFor(() => run.stdout().includes('"type":"dialog_required"'), { label: "the question announced", timeoutMs: 20_000 });
      const asked = records(run.stdout()).find((record) => record.type === "dialog_required");
      expect(asked).toMatchObject({ tool: "AskUserQuestion", kind: "question", answerArgv: ["jolo", "dialog", "answer", asked.runId], dismissArgv: ["jolo", "dialog", "dismiss", asked.runId] });
      expect(records(run.stdout()).some((record) => record.type === "event" && record.event.type === "dialog.requested" && record.event.payload.dialogId === asked.dialogId)).toBe(true);
      const answered = await jolo(["dialog", "answer", asked.runId, "2"], home);
      expect(answered.stderr).toBe("");
      expect(answered.stdout).toBe(`answered for run ${asked.runId}\n`);
      expect(answered.code).toBe(0);
      expect(await run.done).toBe(0);
      const said = records(run.stdout()).filter((record) => record.type === "preview" && record.role === "assistant" && record.kind === "text").map((record) => record.text).join("");
      expect(said).toContain("You answered: coffee");
      // Nothing left to answer: the command says so instead of guessing.
      const nothing = await jolo(["dialog", "answer", asked.runId, "1"], home);
      expect(nothing.code).toBe(1);
      expect(nothing.stderr).toContain("no open question");
    } catch (error) { console.error(run.stderr()); throw error; }
    finally { run.proc.kill(); await run.done; }
  }, 60_000);

  test("a plan is printed with how to approve it or send it back, and jolo dialog approve or dismiss does so", async () => {
    const { home, repo } = boot();
    const run = follow(["run", "exit-plan Ship it", "--agent", "claude", "--path", repo], home);
    try {
      await waitFor(() => run.stderr().includes("approve with: jolo dialog approve "), { label: "the plan announced", timeoutMs: 20_000 });
      const stderr = run.stderr();
      expect(stderr).toContain("Plan ready for your review\n# Ship it\n\n1. Do the thing.\n");
      const runId = /approve with: jolo dialog approve (\S+)/.exec(stderr)[1];
      expect(stderr).toContain(`send back with: jolo dialog dismiss ${runId} "<what should change>"`);
      const approved = await jolo(["dialog", "approve", runId], home);
      expect(approved.stdout).toBe(`approved for run ${runId}\n`);
      expect(approved.code).toBe(0);
      expect(await run.done).toBe(0);
      expect(run.stdout()).toContain("Plan approved: Ship it");
    } catch (error) { console.error(run.stderr()); throw error; }
    finally { run.proc.kill(); await run.done; }
    const again = follow(["run", "exit-plan Once more", "--agent", "claude", "--path", repo], home);
    try {
      await waitFor(() => again.stderr().includes("approve with: jolo dialog approve "), { label: "the second plan announced", timeoutMs: 20_000 });
      const runId = /approve with: jolo dialog approve (\S+)/.exec(again.stderr())[1];
      const sentBack = await jolo(["dialog", "dismiss", runId, "Add tests first."], home);
      expect(sentBack.stdout).toBe(`dismissed for run ${runId}\n`);
      expect(await again.done).toBe(0);
      expect(again.stdout()).toContain("Plan sent back: Add tests first.");
    } catch (error) { console.error(again.stderr()); throw error; }
    finally { again.proc.kill(); await again.done; }
  }, 60_000);

  test("a run that ends with background work running names it and how to stop it; jolo background stop stops it, and --force closes a process whose tasks ignore the stop", async () => {
    const { home, repo } = boot();
    const run = follow(["run", "tasks 2 20000", "--agent", "claude", "--path", repo], home);
    expect(await run.done).toBe(0);
    expect(run.stdout()).toContain("Started 2 tasks.");
    const named = /Background work: 2 tasks · \d\d:\d\d · stop with: jolo background stop (\S+)/.exec(run.stderr());
    if (!named) console.error(run.stderr());
    expect(named).not.toBeNull();
    const stopped = await jolo(["background", "stop", named[1]], home);
    expect(stopped.stdout).toBe("stopped 2 of 2 background tasks\n");
    expect(stopped.code).toBe(0);
    const stubborn = follow(["run", "tasks-stubborn 2", "--agent", "claude", "--path", repo], home);
    expect(await stubborn.done).toBe(0);
    const sessionId = /stop with: jolo background stop (\S+)/.exec(stubborn.stderr())?.[1];
    expect(sessionId).toBeString();
    const partial = await jolo(["background", "stop", sessionId], home);
    expect(partial.stdout).toBe("stopped 0 of 2 background tasks\n");
    expect(partial.stderr).toContain(`2 tasks did not stop; close the process with: jolo background stop ${sessionId} --force`);
    expect(partial.code).toBe(0);
    const forced = await jolo(["background", "stop", sessionId, "--force"], home);
    expect(forced.stdout).toBe("closing the conversation's Claude process; its background work ends with it\n");
    expect(forced.code).toBe(0);
    const nothing = await jolo(["background", "stop", sessionId, "--force"], home);
    expect(nothing.stdout).toBe("the conversation has no Claude process\n");
  }, 60_000);
});
