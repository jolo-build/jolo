// jolo run following a hosted Claude Code conversation: Claude's questions and plans reach the terminal as plain text with
// the command that answers them, and background work left running when the run ends is named with the command that stops
// it. From a terminal, jolo run is an interactive client, so the run waits for the answer; piped or --json it is headless,
// and a question with nobody to answer it pauses the run, which is said with how to resume it. The "claude" of these
// profiles is the protocol fixture, so nothing reaches the real CLI.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { discover, resolvePaths } from "@jolo/launcher";
import { connect } from "@jolo/client";
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

/** A CLI command followed while it runs through pipes (headless): what it has printed so far, and its exit code once done. */
function follow(args, home) {
  const proc = Bun.spawn([process.execPath, CLI_ENTRY, ...args, "--home", home], { env: { ...process.env, ...ENV }, stdout: "pipe", stderr: "pipe" });
  const collected = { stdout: "", stderr: "" };
  const decoder = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  const tail = async (stream, key) => { for await (const chunk of stream) collected[key] += decoder[key].decode(chunk, { stream: true }); };
  const done = Promise.all([tail(proc.stdout, "stdout"), tail(proc.stderr, "stderr"), proc.exited]).then(() => proc.exitCode);
  return { proc, stdout: () => collected.stdout, stderr: () => collected.stderr, done };
}

/** A CLI command followed at a terminal (a pseudo-terminal: stdin, stdout and stderr one screen), as a person runs it. */
function followAtTerminal(args, home) {
  let output = "";
  const proc = Bun.spawn([process.execPath, CLI_ENTRY, ...args, "--home", home], {
    env: { ...process.env, ...ENV, NO_COLOR: "1" },
    terminal: { cols: 160, rows: 40, data(_terminal, data) { output += new TextDecoder().decode(data); } },
  });
  const done = proc.exited.then(() => { proc.terminal?.close(); return proc.exitCode; });
  return { proc, output: () => output.replaceAll("\r", ""), done };
}

const records = (stdout) => stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));

describe("the headless CLI with a hosted Claude", () => {
  test("a conversation jolo run starts is untitled, so Claude names it", async () => {
    const { home, repo } = boot();
    const { stdout, code } = await jolo(["run", "summarise the release notes for me", "--agent", "claude", "--path", repo, "--json"], home);
    expect(code).toBe(0);
    const started = records(stdout).find((record) => record.type === "run.started");
    const paths = resolvePaths({ home, profile: "default" });
    const client = await connect({ socketPath: paths.socketPath, token: readFileSync(paths.tokenPath, "utf8").trim(), clientKind: "test", build: "test" });
    try {
      const title = async () => (await client.call("session.page", { sessionId: started.sessionId })).session.title;
      await waitFor(async () => (await title()).startsWith("Fixture title:"), { label: "the title Claude gave", timeoutMs: 15_000 });
      expect(await title()).toBe("Fixture title: summarise the release");
    } finally { await client.close(); }
  }, 30_000);

  test("a tool Claude calls is named by its head line alone, never the command or input shown below it", async () => {
    const { home, repo } = boot();
    const run = follow(["run", "run echo cli-head-ok", "--agent", "claude", "--path", repo], home);
    expect(await run.done).toBe(3); // paused: nobody is there to allow the command
    expect(run.stderr()).toContain("→ Bash: echo cli-head-ok\n");
    expect(run.stderr()).not.toContain("$ echo cli-head-ok");
  }, 60_000);

  test("at a terminal, a question Claude asks is printed with how to answer it and the run waits; jolo dialog answer sends the chosen option back", async () => {
    const { home, repo } = boot();
    const run = followAtTerminal(["run", "ask-user tea or coffee?", "--agent", "claude", "--path", repo], home);
    try {
      await waitFor(() => run.output().includes("answer with: jolo dialog answer "), { label: "the question announced", timeoutMs: 20_000 });
      const output = run.output();
      expect(output).toContain("Claude asks: tea or coffee?\n  [1] tea\n  [2] coffee\n  or type your own answer\n");
      const runId = /answer with: jolo dialog answer (\S+) <choice>/.exec(output)[1];
      expect(output).toContain(`dismiss with: jolo dialog dismiss ${runId}`);
      // A person at a terminal is an interactive client: the run waits for the answer rather than pausing with nobody to ask.
      await new Promise((resolve) => setTimeout(resolve, 700)); // past the engine's pause tick
      expect(run.output()).not.toContain("paused");
      const answered = await jolo(["dialog", "answer", runId, "2"], home);
      expect(answered.stderr).toBe("");
      expect(answered.stdout).toBe(`answered for run ${runId}\n`);
      expect(answered.code).toBe(0);
      expect(await run.done).toBe(0);
      expect(run.output()).toContain("You answered: coffee");
      // Nothing left to answer: the command says so instead of guessing.
      const nothing = await jolo(["dialog", "answer", runId, "1"], home);
      expect(nothing.code).toBe(1);
      expect(nothing.stderr).toContain("no open question");
    } catch (error) { console.error(run.output()); throw error; }
    finally { run.proc.kill(); await run.done; }
  }, 60_000);

  test("jolo attach to a run already waiting on a question prints it, with how to answer it, once", async () => {
    const { home, repo } = boot();
    const run = followAtTerminal(["run", "ask-user tea or coffee?", "--agent", "claude", "--path", repo], home);
    const attached = { output: () => "", proc: null, done: Promise.resolve(0) };
    try {
      await waitFor(() => run.output().includes("answer with: jolo dialog answer "), { label: "the question announced", timeoutMs: 20_000 });
      const runId = /answer with: jolo dialog answer (\S+) <choice>/.exec(run.output())[1];
      Object.assign(attached, followAtTerminal(["attach", runId], home));
      await waitFor(() => attached.output().includes(`answer with: jolo dialog answer ${runId}`), { label: "the question shown on attach", timeoutMs: 20_000 });
      expect(attached.output()).toContain("Claude asks: tea or coffee?\n  [1] tea\n  [2] coffee\n");
      expect((await jolo(["dialog", "answer", runId, "1"], home)).code).toBe(0);
      expect(await attached.done).toBe(0);
      expect(attached.output()).toContain("You answered: tea");
      expect(attached.output().split("Claude asks: tea or coffee?").length).toBe(2); // told once, not again by a replayed event
    } catch (error) { console.error(run.output(), attached.output()); throw error; }
    finally { run.proc.kill(); attached.proc?.kill(); await run.done; await attached.done; }
  }, 60_000);

  test("piped or --json, jolo run is headless: a question with nobody to answer it pauses the run, which is reported with how to resume it", async () => {
    const { home, repo } = boot();
    const run = follow(["run", "ask-user tea or coffee?", "--agent", "claude", "--path", repo, "--json"], home);
    expect(await run.done).toBe(3); // paused, as for a permission nobody could answer
    const all = records(run.stdout());
    const asked = all.find((record) => record.type === "dialog_required");
    expect(asked).toMatchObject({ tool: "AskUserQuestion", kind: "question", answerArgv: ["jolo", "dialog", "answer", asked.runId], dismissArgv: ["jolo", "dialog", "dismiss", asked.runId] });
    expect(all.some((record) => record.type === "event" && record.event.type === "dialog.requested" && record.event.payload.dialogId === asked.dialogId)).toBe(true);
    // The pause closed the question (Claude was told the run was stopped), so resuming the run, not answering, is the way on.
    expect(all.some((record) => record.type === "event" && record.event.type === "dialog.resolved" && record.event.payload.state === "cancelled")).toBe(true);
    expect(all.at(-1)).toEqual({ type: "run.paused", runId: asked.runId, runRevision: expect.any(Number), reason: "permission", resumeArgv: ["jolo", "resume", asked.runId] });
    expect(all.some((record) => record.type === "permission_required")).toBe(false);
    const text = follow(["run", "ask-user tea or coffee?", "--agent", "claude", "--path", repo], home);
    expect(await text.done).toBe(3);
    expect(text.stderr()).toContain("Claude asks: tea or coffee?");
    expect(text.stderr()).toMatch(/run paused on Claude's question with nobody to answer it; resume from a terminal with: jolo resume \S+\n/);
    expect(text.stderr()).not.toContain("allow null");
  }, 60_000);

  test("at a terminal, a plan is printed with how to approve it or send it back, and jolo dialog approve or dismiss does so", async () => {
    const { home, repo } = boot();
    const run = followAtTerminal(["run", "exit-plan Ship it", "--agent", "claude", "--path", repo], home);
    try {
      await waitFor(() => run.output().includes("approve with: jolo dialog approve "), { label: "the plan announced", timeoutMs: 20_000 });
      const output = run.output();
      expect(output).toContain("Plan ready for your review\n# Ship it\n\n1. Do the thing.\n");
      const runId = /approve with: jolo dialog approve (\S+)/.exec(output)[1];
      expect(output).toContain(`send back with: jolo dialog dismiss ${runId} "<what should change>"`);
      const approved = await jolo(["dialog", "approve", runId], home);
      expect(approved.stdout).toBe(`approved for run ${runId}\n`);
      expect(approved.code).toBe(0);
      expect(await run.done).toBe(0);
      expect(run.output()).toContain("Plan approved: Ship it");
    } catch (error) { console.error(run.output()); throw error; }
    finally { run.proc.kill(); await run.done; }
    const again = followAtTerminal(["run", "exit-plan Once more", "--agent", "claude", "--path", repo], home);
    try {
      await waitFor(() => again.output().includes("approve with: jolo dialog approve "), { label: "the second plan announced", timeoutMs: 20_000 });
      const runId = /approve with: jolo dialog approve (\S+)/.exec(again.output())[1];
      const sentBack = await jolo(["dialog", "dismiss", runId, "Add tests first."], home);
      expect(sentBack.stdout).toBe(`dismissed for run ${runId}\n`);
      expect(await again.done).toBe(0);
      expect(again.output()).toContain("Plan sent back: Add tests first.");
    } catch (error) { console.error(again.output()); throw error; }
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
