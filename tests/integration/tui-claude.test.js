// The interactive terminal client on a hosted Claude Code conversation: Claude's questions and plans are answered from the
// keyboard, as permission requests are, and the conversation's background work is shown and stopped. The "claude" of
// these profiles is the protocol fixture (tests/fixtures/fake-claude.js), so nothing reaches the real CLI.
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { ROOT, startEngine, tempHome, removeHome, waitFor } from "./helpers.js";

const { Terminal } = createRequire(new URL("../../apps/engine/package.json", import.meta.url))("@xterm/headless");
const ESC = "\x1b", ENTER = "\r", CTRL_X = "\x18";
const FAKE = path.join(ROOT, "tests", "fixtures", "fake-claude.js");
const interactiveCommand = process.env.JOLO_TEST_CLI ? [process.env.JOLO_TEST_CLI] : [process.execPath, "run", "jolo"];

/** An engine whose "claude" is the fixture, a Claude conversation in it, and the terminal client opened on that conversation. */
async function boot({ before = async () => {} } = {}) {
  const home = tempHome();
  const repo = path.join(home, "repo"); mkdirSync(repo);
  const launcher = path.join(home, "fake-claude");
  writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`); chmodSync(launcher, 0o755);
  const agents = path.join(home, "data", "t", "agents"); mkdirSync(agents, { recursive: true });
  writeFileSync(path.join(agents, "claude.json"), JSON.stringify({ id: "claude", displayName: "Claude Code", binary: launcher, transport: "claude-stream" }));
  const engine = await startEngine({ home });
  const client = await engine.connect();
  const events = [];
  const status = await client.call("engine.status", {});
  await client.subscribe({ after: status.cursor }, { onEvent: (event) => events.push(event) });
  const project = await client.call("project.open", { path: repo });
  const { session } = await client.call("session.create", { projectId: project.projectId, workspaceId: project.workspaceId, title: "hosted", agentId: "claude" });
  await before({ client, events, session });
  const screen = new Terminal({ cols: 100, rows: 30, scrollback: 5000, allowProposedApi: true });
  let output = "";
  const child = Bun.spawn([...interactiveCommand, repo, "--home", home, "--profile", "t", "--session", session.id], {
    cwd: ROOT, env: { ...process.env, CI: "0", TERM: "xterm-256color" },
    terminal: { cols: 100, rows: 30, data(_terminal, data) { output += new TextDecoder().decode(data); screen.write(data); } },
  });
  const allLines = () => Array.from({ length: screen.buffer.active.length }, (_, i) => screen.buffer.active.getLine(i)?.translateToString(true) ?? "");
  const text = () => allLines().join("\n");
  const draft = () => allLines().filter((line) => /^▎❯(?: |$)/.test(line)).at(-1) ?? "";
  const type = (value) => child.terminal.write(value);
  const seen = (value, timeoutMs = 15000) => waitFor(() => text().includes(value), { label: value, timeoutMs });
  const gone = (value) => waitFor(() => !text().includes(value), { label: `${value} gone`, timeoutMs: 15000 });
  const ready = () => waitFor(() => allLines().some((line) => line.startsWith("▎❯ ")), { label: "prompt ready", timeoutMs: 15000 });
  const prompt = async (value) => { type(value); await waitFor(() => draft().includes(value), { label: `typed ${value}` }); type(ENTER); };
  const runs = async () => (await client.call("session.page", { sessionId: session.id })).runs;
  return { home, repo, engine, client, events, session, screen, child, text, draft, type, seen, gone, ready, prompt, runs, output: () => output,
    async close() {
      if (child.exitCode === null) child.kill();
      await child.exited; child.terminal?.close(); screen.dispose();
      await client.close(); await engine.stop(); removeHome(home);
    },
  };
}

test("a question Claude asks is answered by its option's number, in the person's own words, or dismissed", async () => {
  const t = await boot();
  try {
    await t.ready();
    await t.prompt("ask-user tea or coffee?");
    await t.seen("Claude asks: tea or coffee?");
    await t.seen("[2] coffee");
    expect((await t.runs()).at(-1).state).toBe("awaiting_permission");
    t.type("2");
    await t.seen("You answered: coffee");
    expect(t.draft()).not.toContain("2"); // the key answered; it was never draft text
    await t.prompt("ask-user tea or coffee?");
    await t.seen("Question: tea or coffee?"); // the live hint names the question
    t.type("espresso"); await waitFor(() => t.draft().includes("espresso"));
    t.type(ENTER);
    await t.seen("You answered: espresso");
    expect(t.draft()).toContain("Ask Jolo anything"); // the draft was sent, not kept
    await t.prompt("ask-user tea or coffee?");
    await t.seen("Esc dismisses");
    t.type(ESC);
    await t.seen("No answer: The user dismissed the question without answering.");
    expect((await t.runs()).every((run) => run.state === "completed")).toBe(true);
  } catch (error) { console.error(t.text()); throw error; }
  finally { await t.close(); }
}, 60_000);

test("a plan Claude asks to approve is shown in full, approved with Enter, or sent back with typed feedback", async () => {
  const t = await boot();
  try {
    await t.ready();
    await t.prompt("exit-plan Ship it");
    await t.seen("Plan ready for your review");
    await t.seen("Do the thing.");
    await t.seen("Enter approves");
    t.type(ENTER);
    await t.seen("Plan approved: Ship it");
    await t.prompt("exit-plan Once more");
    await t.seen("Enter approves");
    t.type("Add tests first."); await waitFor(() => t.draft().includes("Add tests first."));
    t.type(ENTER);
    await t.seen("Plan sent back: Add tests first.");
    expect(t.draft()).toContain("Ask Jolo anything"); // the draft was sent, not kept
  } catch (error) { console.error(t.text()); throw error; }
  finally { await t.close(); }
}, 60_000);

test("a client that opens the conversation while a question waits is asked it at once", async () => {
  const t = await boot({ before: async ({ client, events, session }) => {
    const { run } = await client.call("run.start", { sessionId: session.id, requestId: "asked-before", prompt: "ask-user tea or coffee?" });
    await waitFor(() => events.some((e) => e.type === "dialog.requested" && e.runId === run.id), { label: "the question asked before the client opened", timeoutMs: 20_000 });
  } });
  try {
    await t.seen("Claude asks: tea or coffee?");
    await t.seen("[1] tea");
    t.type("1");
    await t.seen("You answered: tea");
  } catch (error) { console.error(t.text()); throw error; }
  finally { await t.close(); }
}, 60_000);

test("background work is shown above the composer while it runs, and Ctrl+X stops it", async () => {
  const t = await boot();
  try {
    await t.ready();
    await t.prompt("tasks 2 20000");
    await t.seen("Started 2 tasks.");
    await t.seen("Background work: 2 tasks · 00:0");
    await t.seen("Ctrl+X stop");
    t.type(CTRL_X);
    await t.seen("Stopped 2 background tasks.");
    await t.gone("Background work:");
    const { activity } = await t.client.call("session.activity", { sessionId: t.session.id });
    expect(activity.tasks.map((task) => task.status)).toEqual(["stopped", "stopped"]);
    // The process is kept: the next message is answered by it.
    await t.prompt("hello again");
    await t.seen("Continuing session"); // the same process answers
  } catch (error) { console.error(t.text()); throw error; }
  finally { await t.close(); }
}, 60_000);

test("tasks that ignore the stop are force-stopped by closing the process, after a confirmation", async () => {
  const t = await boot();
  try {
    await t.ready();
    await t.prompt("tasks-stubborn 2");
    await t.seen("Started 2 stubborn tasks.");
    await t.seen("Background work: 2 tasks");
    t.type(CTRL_X);
    await t.seen("Stopping background work…");
    await t.seen("2 of 2 background tasks did not stop · Ctrl+X again to force stop");
    t.type(CTRL_X);
    await t.seen("Force stop? This closes Claude's process");
    t.type("n");
    await t.gone("Force stop?");
    expect(t.text()).toContain("Background work: 2 tasks");
    t.type(CTRL_X);
    await t.seen("Force stop?");
    t.type("y");
    await t.gone("Background work:");
    await t.seen("Claude's process closed; its background work ended.");
    // The process is gone (its activity reads as none), and the last word of it had both stubborn tasks end with it.
    await waitFor(async () => (await t.client.call("session.activity", { sessionId: t.session.id })).activity === null, { label: "the process ended", timeoutMs: 15000 });
    const last = t.events.filter((event) => event.type === "session.activity" && event.sessionId === t.session.id).at(-1);
    expect(last.payload.state).toBe("idle");
    expect(last.payload.tasks.map((task) => task.status)).toEqual(["failed", "failed"]);
  } catch (error) { console.error(t.text()); throw error; }
  finally { await t.close(); }
}, 60_000);
