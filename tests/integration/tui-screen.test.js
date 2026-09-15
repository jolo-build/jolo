import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { resolvePaths, tryConnect } from "@jolo/launcher";
import { CLI_ENTRY as SOURCE_CLI_ENTRY, ROOT, tempHome, waitFor, removeHome } from "./helpers.js";

const CLI_ENTRY = process.env.JOLO_TEST_CLI_ENTRY ?? SOURCE_CLI_ENTRY;
const CLI_COMMAND = process.env.JOLO_TEST_CLI_COMMAND ? [process.env.JOLO_TEST_CLI_COMMAND] : [process.execPath, CLI_ENTRY];
const INTERACTIVE_COMMAND = process.env.JOLO_TEST_CLI_COMMAND ? CLI_COMMAND : [process.execPath, 'run', 'jolo'];

// Reuse the engine's terminal emulator: assert actual terminal cells, not stripped log output.
const { Terminal } = createRequire(new URL("../../apps/engine/package.json", import.meta.url))("@xterm/headless");
const homes = [];
afterEach(async () => {
  for (const home of homes.splice(0)) {
    const stop = Bun.spawn([...CLI_COMMAND, "engine", "stop", "--cancel", "--home", home], { stdout: "ignore", stderr: "ignore" });
    await stop.exited;
    removeHome(home);
  }
});

test("a mermaid diagram in a reply is drawn in the terminal, not printed as its source", async () => {
  const home = tempHome(); homes.push(home);
  const repo = path.join(home, "repo"); mkdirSync(repo);
  const scriptPath = path.join(home, "script.json");
  writeFileSync(scriptPath, JSON.stringify([{ text: [
    "Here is the flow:\n\n```mermaid\nflowchart LR\n  A[Read] --> B{Valid?}\n  B -->|yes| C[Save]\n  B -->|no| D[Reject]\n```\n",
  ] }]));
  const screen = new Terminal({ cols: 100, rows: 30, scrollback: 5000, allowProposedApi: true });
  let output = "";
  let replied = false;
  const child = Bun.spawn([...INTERACTIVE_COMMAND, repo, "--home", home], {
    cwd: ROOT,
    env: { ...process.env, JOLO_FAKE_SCRIPT: scriptPath, JOLO_FAKE_DELAY_MS: "10", JOLO_IDLE_MS: "2000", CI: "0", NO_COLOR: "1" },
    terminal: { cols: 100, rows: 30, data(terminal, data) {
      output += new TextDecoder().decode(data);
      screen.write(data);
      if (!replied && output.includes("\x1b[?u")) { replied = true; terminal.write("\x1b[?0u"); }
    } },
  });
  const lines = () => Array.from({ length: screen.buffer.active.length }, (_, i) => screen.buffer.active.getLine(i)?.translateToString(true) ?? "");
  const text = () => lines().join("\n");
  const draft = () => lines().filter((row) => /^▎❯(?: |$)/.test(row)).at(-1) ?? "";
  try {
    // The draft line means the client is listening; typing before it would go nowhere.
    await waitFor(() => text().includes("Welcome to Jolo") && draft(), { label: "welcome", timeoutMs: 20_000 });
    child.terminal.write("draw the flow\r");
    await waitFor(() => text().includes("│ Read │"), { label: "diagram drawn", timeoutMs: 20_000 });
    const screenText = text();
    expect(screenText).toContain("│ Read │"); // boxes, drawn by Jolo rather than left as source
    expect(screenText).toContain("│ Save │");
    expect(screenText).toContain("▶");
    expect(screenText).toContain("yes");
    expect(screenText).not.toContain("flowchart LR"); // the fence gave way to the picture
  } finally {
    child.terminal.write("\x03");
    child.kill();
    await child.exited;
  }
}, 40_000);

for (const color of [false, true]) test(`native scrollback, prompt recall, progress, and clean resizing through bun run jolo (${color ? "color" : "plain"})`, async () => {
  const home = tempHome(); homes.push(home);
  const repo = path.join(home, "repo"); mkdirSync(repo);
  const scriptPath = path.join(home, "script.json");
  const paragraph = 'Earlier paragraphs must reflow when the terminal font size changes. '.repeat(12).trim();
  writeFileSync(scriptPath, JSON.stringify([{ text: [
    "Starting the task.\n\n",
    Array.from({ length: 80 }, (_, i) => `- History row ${String(i).padStart(3, "0")} with enough text to wrap in a narrow terminal.`).join("\n"),
    `\n\n${paragraph}\n\nFinished the task.\n`,
  ] }]));
  const screen = new Terminal({ cols: 100, rows: 30, scrollback: 5000, allowProposedApi: true });
  let output = "";
  let replied = false;
  // The colour case swaps entries in and out below, so this is a plain environment, not the
  // narrow shape TypeScript infers from the variables this fixture happens to set.
  /** @type {Record<string, string | undefined>} */
  const env = { ...process.env, JOLO_FAKE_SCRIPT: scriptPath, JOLO_FAKE_DELAY_MS: "500", JOLO_IDLE_MS: "2000", CI: "0" };
  if (color) { delete env.NO_COLOR; env.FORCE_COLOR = "3"; env.COLORTERM = "truecolor"; }
  else { delete env.FORCE_COLOR; env.NO_COLOR = "1"; }
  await new Promise((resolve) => screen.write("OLD_SCROLLBACK\r\n" + "old shell output\r\n".repeat(35) + "OLD_VISIBLE_OUTPUT\r\nshell prompt $ jolo\r\n", /** @type {() => void} */ (resolve)));
  const child = Bun.spawn([...INTERACTIVE_COMMAND, repo, "--home", home], {
    cwd: ROOT,
    env,
    terminal: { cols: 100, rows: 30, data(terminal, data) {
      output += new TextDecoder().decode(data);
      screen.write(data);
      if (!replied && output.includes("\x1b[?u")) { replied = true; terminal.write("\x1b[?0u"); }
    } },
  });
  const lines = () => Array.from({ length: screen.buffer.active.length }, (_, i) => screen.buffer.active.getLine(i)?.translateToString(true) ?? "");
  const text = () => lines().join("\n");
  const draft = () => lines().filter((row) => /^▎❯(?: |$)/.test(row)).at(-1) ?? "";
  const flush = () => new Promise((resolve) => screen.write("", resolve));
  const fitted = () => {
    const all = lines();
    const prompt = all.findLastIndex((row) => row.startsWith("▎❯ "));
    return all[prompt - 2]?.includes("Completed") && all[prompt - 1] === "▎" && all[prompt + 1] === "▎" && Boolean(all[prompt + 2]?.trim());
  };
  try {
    await waitFor(() => text().includes("Welcome to Jolo") && draft(), { label: "native welcome", timeoutMs: 20_000 });
    const visible = lines().slice(screen.buffer.active.baseY).join("\n");
    expect(visible).not.toContain("OLD_VISIBLE_OUTPUT");
    expect(visible).not.toContain("old shell output");
    expect(visible).not.toContain("shell prompt $ jolo");
    expect(visible.startsWith("Jolo ")).toBe(true);
    expect(text()).toContain("OLD_SCROLLBACK");
    expect(screen.buffer.active.type).toBe("normal");
    expect(screen.modes.mouseTrackingMode).toBe("none");
    expect(output).not.toContain("\x1b[?1049h");
    expect(output).not.toContain("\x1b[?1000;1006h");
    child.terminal.write("native scroll task\r");
    await waitFor(() => text().includes("Responding") && text().includes("Esc stop"), { label: "live progress" });
    await waitFor(() => text().includes("Completed") && text().includes("Finished the task."), { label: "task completes", timeoutMs: 10_000 });
    expect(text()).toContain("History row 000");
    expect(text()).toContain("History row 079");
    // No hard line endings or padding inside prose: Kitty owns these wraps.
    expect(Bun.stripANSI(output)).toContain(paragraph);
    expect(screen.buffer.active.baseY).toBeGreaterThan(0);
    // Native scrolling is handled entirely by the terminal, with no stdin mouse packet or app redraw.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const outputLength = output.length;
    screen.scrollLines(-20);
    expect(screen.buffer.active.viewportY).toBeLessThan(screen.buffer.active.baseY);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(output.length).toBe(outputLength);
    screen.scrollToBottom();
    child.terminal.write("unfinished draft");
    await waitFor(() => draft().includes("unfinished draft"), { label: "draft" });
    if (color) {
      await flush();
      const promptRow = lines().findLastIndex((row) => row.startsWith("▎❯ "));
      for (const row of [promptRow - 1, promptRow, promptRow + 1]) {
        const cell = screen.buffer.active.getLine(row).getCell(screen.cols - 3);
        // The composer inherits the terminal background in both light and dark themes.
        expect(cell.getBgColor()).toBe(-1);
        expect(cell.getChars()).toBe(""); // Background fill must not become reflowable space characters.
      }
    }
    child.terminal.write("\x1b[A");
    await waitFor(() => draft().includes("native scroll task"), { label: "Up recalls prompt" });
    child.terminal.write("\x1b[B");
    await waitFor(() => draft().includes("unfinished draft"), { label: "Down restores draft" });
    expect(lines().filter((row) => row.includes("❯ unfinished draft"))).toHaveLength(1);

    for (const [cols, rows] of [[54, 14], [120, 36], [40, 10], [100, 30], [100, 12], [100, 40], [20, 6], [80, 24]]) {
      await flush();
      screen.resize(cols, rows);
      child.terminal.resize(cols, rows);
      await waitFor(() => cols < 32 ? text().includes("Enlarge terminal") : fitted(), { label: `native resize ${cols}x${rows}`, timeoutMs: 5000 });
      if (cols >= 32) expect(lines().filter((row) => row.includes("❯ unfinished draft"))).toHaveLength(1);
    }
    for (let cycle = 0; cycle < 4; cycle++) {
      for (const [cols, rows] of [[112, 35], [56, 18], [81, 25], [80, 24]]) {
        await flush();
        screen.resize(cols, rows);
        child.terminal.resize(cols, rows);
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    }
    await waitFor(fitted, { label: "final clean prompt after rapid resize" });
    expect(draft()).toContain("unfinished draft");
    expect(text()).toContain("History row 000");
    expect(text()).toContain("History row 079");
    expect(text()).toContain("Welcome to Jolo");
    expect(lines().filter((row) => row.includes("❯ unfinished draft"))).toHaveLength(1);
    expect(lines().filter((row) => row.includes("Welcome to Jolo"))).toHaveLength(1);
    child.terminal.write("\x03");
    await waitFor(() => child.exitCode !== null, { label: "CLI exit" });
    expect(await child.exited).toBe(0);
    await flush();
    expect(screen.buffer.active.type).toBe("normal");
    expect(lines().slice(screen.buffer.active.baseY).join("").trim()).toBe("");
    expect(screen.buffer.active.cursorX).toBe(0);
    expect(screen.buffer.active.cursorY).toBe(0);
    expect(screen.buffer.active.getLine(screen.buffer.active.baseY).getCell(0).isBgDefault()).toBe(true);
    expect(output).toContain("\x1b[<u");
    expect(output).toContain("\x1b[?25h\x1b[2J\x1b[H");
  } catch (error) {
    console.error(`Native terminal ${screen.cols}x${screen.rows}:\n${lines().slice(-45).join("\n")}\nRaw tail: ${JSON.stringify(output.slice(-500))}`);
    throw error;
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
    child.terminal?.close();
    screen.dispose();
  }
}, 60_000);

for (const [signal, code] of /** @type {[NodeJS.Signals, number][]} */ ([["SIGTERM", 143], ["SIGINT", 130]])) test(`${signal} clears the CLI and an open model menu before returning to the shell`, async () => {
  const home = tempHome(); homes.push(home);
  const screen = new Terminal({ cols: 100, rows: 30, allowProposedApi: true });
  let output = "";
  const child = Bun.spawn([...CLI_COMMAND, home, "--home", home, "--theme", "github-dark"], {
    env: { ...process.env, JOLO_IDLE_MS: "2000", CI: "0", FORCE_COLOR: '3' },
    terminal: { cols: 100, rows: 30, data(_terminal, data) { output += new TextDecoder().decode(data); screen.write(data); } },
  });
  const visible = () => Array.from({ length: screen.rows }, (_, i) => screen.buffer.active.getLine(screen.buffer.active.baseY + i)?.translateToString(true) ?? "").join("\n");
  try {
    await waitFor(() => visible().includes("Ask Jolo anything"), { timeoutMs: 20000 });
    child.terminal.write("/model\r");
    await waitFor(() => visible().includes("Choose the agent for your prompts"));
    child.kill(signal);
    await waitFor(() => child.exitCode !== null);
    expect(await child.exited).toBe(code);
    await new Promise((resolve) => screen.write("", /** @type {() => void} */ (resolve)));
    expect(visible().trim()).toBe("");
    expect(screen.buffer.active.cursorX).toBe(0);
    expect(screen.buffer.active.cursorY).toBe(0);
    expect(output.split("\x1b[2J\x1b[H")).toHaveLength(3); // One startup clear and one idempotent cleanup.
    expect(output).toContain('\x1b]11;#0d1117\x1b\\');
    expect(output).toContain('\x1b]110\x1b\\\x1b]111\x1b\\');
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited; child.terminal?.close(); screen.dispose();
  }
}, 30000);

test("startup stays fresh until a saved session is explicitly restored", async () => {
  const home = tempHome(); homes.push(home);
  const repo = path.join(home, "repo"); mkdirSync(repo);
  const env = { ...process.env, JOLO_FAKE_STEPS: "1", JOLO_FAKE_DELAY_MS: "10", JOLO_IDLE_MS: "10000", CI: "0" };
  const previous = Bun.spawn([...CLI_COMMAND, "run", "previous task", "--path", repo, "--home", home], { env, stdout: "ignore", stderr: "ignore" });
  expect(await previous.exited).toBe(0);
  const client = await tryConnect(resolvePaths({ home }), { clientKind: "test", build: "test" });
  const saved = (await client.call("session.list", {})).sessions[0];
  const screen = new Terminal({ cols: 100, rows: 30, allowProposedApi: true });
  const child = Bun.spawn([process.execPath, "run", "jolo", repo, "--home", home], {
    cwd: ROOT, env, terminal: { cols: 100, rows: 30, data(_terminal, data) { screen.write(data); } },
  });
  const text = () => Array.from({ length: screen.buffer.active.length }, (_, i) => screen.buffer.active.getLine(i)?.translateToString(true) ?? "").join("\n");
  try {
    await waitFor(() => text().includes("Ask Jolo anything") && text().includes("Welcome to Jolo"), { label: "fresh welcome despite saved history", timeoutMs: 20_000 });
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(text()).not.toContain("done: previous task");
    expect(text()).not.toContain("Enter view chat");
    child.terminal.write("\x1b[A");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(text()).not.toContain("❯ previous task");
    expect(text()).toContain("Welcome to Jolo");
    child.terminal.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 100));
    child.terminal.write("/model");
    await waitFor(() => text().includes("❯ /model"));
    child.terminal.write("\r");
    await waitFor(() => text().includes("Choose the agent for your prompts"));
    child.terminal.write("\x1b");
    await waitFor(() => !text().includes("Choose the agent for your prompts"));
    expect((await client.call("session.list", {})).sessions.map((session) => session.id)).toEqual([saved.id]);
    expect((await client.call("session.page", { sessionId: saved.id })).runs).toHaveLength(1);

    child.terminal.write("fresh task\r");
    await waitFor(() => text().includes("done: fresh task"), { label: "new prompt gets a separate session" });
    const sessions = (await client.call("session.list", {})).sessions;
    expect(sessions).toHaveLength(2);
    const fresh = sessions.find((session) => session.id !== saved.id);
    expect((await client.call("session.page", { sessionId: fresh.id })).runs.map((run) => run.prompt)).toEqual(["fresh task"]);
    expect((await client.call("session.page", { sessionId: saved.id })).runs.map((run) => run.prompt)).toEqual(["previous task"]);

    child.terminal.write(`/session restore ${saved.id}\r`);
    await waitFor(() => text().includes("Restored: previous task") && text().includes("done: previous task"), { label: "explicit restore opens saved conversation" });
    child.terminal.write("\x1b[A");
    await waitFor(() => text().split("\n").filter((row) => row.startsWith("▎❯ ")).at(-1)?.includes("previous task"), { label: "restored chat recalls its prompts" });
    child.terminal.write("\x03");
    await waitFor(() => child.exitCode !== null, { label: "CLI exit" });
    expect(await child.exited).toBe(0);
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
    child.terminal?.close();
    screen.dispose();
    await client.close();
  }
}, 30_000);

test('model selection survives CLI restarts and explicit session restores keep their own agent', async () => {
  const home = tempHome(); homes.push(home);
  const repo = path.join(home, 'repo'); mkdirSync(repo);
  const agentsDir = path.join(home, 'data', 'default', 'agents'); mkdirSync(agentsDir, { recursive: true });
  const binary = path.join(home, 'fake-codex');
  writeFileSync(binary, `#!/bin/sh\nexec "${process.execPath}" "${path.join(ROOT, 'tests/fixtures/fake-codex.js')}" "$@"\n`, { mode: 0o755 });
  writeFileSync(path.join(agentsDir, 'codex.json'), JSON.stringify({ id: 'codex', displayName: 'Codex', binary, transport: 'codex-app-server' }));
  const env = { ...process.env, JOLO_IDLE_MS: '10000', CI: '0', NO_COLOR: '1' };
  /** @type {Bun.Subprocess | undefined} */
  let child;
  const screen = new Terminal({ cols: 100, rows: 30, allowProposedApi: true });
  let client;
  const visible = () => Array.from({ length: screen.rows }, (_, i) => screen.buffer.active.getLine(screen.buffer.active.baseY + i)?.translateToString(true) ?? '').join('\n');
  const launch = async (args = []) => {
    screen.reset();
    child = Bun.spawn([...CLI_COMMAND, repo, '--home', home, ...args], {
      env, terminal: { cols: 100, rows: 30, data(_terminal, data) { screen.write(data); } },
    });
    await waitFor(() => visible().includes('Ask Jolo anything') && !visible().includes('Loading model'), { label: 'model ready after launch', timeoutMs: 20000 });
  };
  const quit = async () => {
    child.terminal.write('\x03');
    await waitFor(() => child.exitCode !== null, { label: 'quit model fixture' });
    expect(await child.exited).toBe(0);
    child.terminal.close();
  };
  const keys = async (input, expected) => {
    child.terminal.write(input);
    await waitFor(() => visible().includes(expected), { label: expected });
  };
  try {
    await launch();
    await keys('/model codex\r', 'Blank values use the agent');
    await keys('\r', 'Type to replace');
    await keys('fake-large\r', 'Model  fake-large');
    await keys('\x1b[B', '› Effort');
    await keys('\r', 'Type to replace');
    await keys('high\r', 'Effort  high');
    await keys('\x1b[B', '› Find models');
    await keys('\x1b[B', '› Save and use');
    await keys('\r', 'Model configuration saved');
    expect(visible()).toContain('codex · fake-large');
    await quit();

    await launch();
    expect(visible()).toContain('codex · fake-large');
    client = await tryConnect(resolvePaths({ home }), { clientKind: 'test', build: 'test' });
    expect((await client.call('settings.get', {})).settings.agents.codex).toMatchObject({ model: 'fake-large', effort: 'high' });
    expect((await client.call('session.list', {})).sessions).toHaveLength(0);
    await keys('model\r', 'Completed');
    const saved = (await client.call('session.list', {})).sessions[0];
    expect(saved.agentId).toBe('codex');
    // Switching the fresh default does not require modifying the existing chat.
    await quit();
    await launch();
    await keys('/model jolo\r', 'Profile default');
    await keys('\x1b[B', '› Save and use');
    await keys('\r', 'Model configuration saved');
    await quit();
    await launch();
    expect(visible()).toContain('Demo provider');
    expect(visible()).not.toContain('codex ·');
    await quit();
    await launch(['--session', saved.id]);
    expect(visible()).toContain('codex · fake-large');
    await quit();
  } finally {
    if (child && child.exitCode === null) { child.kill(); await child.exited; child.terminal?.close(); }
    screen?.dispose();
    await client?.close();
  }
}, 45000);

for (const waiting of [false, true]) test(`Enter queues a follow-up and double Enter steers ${waiting ? 'an existing queued message' : 'a new message'} without duplicates`, async () => {
  const home = tempHome(); homes.push(home);
  const screen = new Terminal({ cols: 100, rows: 30, allowProposedApi: true });
  let output = '', replied = false, client;
  const child = Bun.spawn([...CLI_COMMAND, home, '--home', home], {
    env: { ...process.env, JOLO_FAKE_STEPS: '100', JOLO_FAKE_DELAY_MS: '30', JOLO_IDLE_MS: '10000', CI: '0', NO_COLOR: '1' },
    terminal: { cols: 100, rows: 30, data(terminal, data) {
      output += new TextDecoder().decode(data); screen.write(data);
      if (!replied && output.includes('\x1b[?u')) { replied = true; terminal.write('\x1b[?0u'); }
    } },
  });
  const visible = () => Array.from({ length: screen.rows }, (_, i) => screen.buffer.active.getLine(screen.buffer.active.baseY + i)?.translateToString(true) ?? '').join('\n');
  const type = async text => {
    child.terminal.write(text);
    await waitFor(() => visible().includes(`❯ ${text}`), { label: `draft ${text}` });
  };
  try {
    await waitFor(() => visible().includes('Ask Jolo anything'), { timeoutMs: 20000 });
    client = await tryConnect(resolvePaths({ home }), { clientKind: 'test', build: 'test' });
    await type('first task'); child.terminal.write('\r\r'); // Idle double Enter still starts only one run.
    await waitFor(() => visible().includes('Enter twice to send now'));
    const session = (await client.call('session.list', {})).sessions[0];
    const page = () => client.call('session.page', { sessionId: session.id });
    await waitFor(async () => (await page()).runs[0]?.state === 'model');
    await type('queued follow-up'); child.terminal.write('\r');
    await waitFor(() => visible().includes('Queued · 1 › queued follow-up'));
    child.terminal.write('\x1b[13;1:2u'); // Kitty repeat must not turn a held Enter into steering.
    await new Promise(resolve => setTimeout(resolve, 550));
    child.terminal.write('\r'); // A later empty Enter arms the waiting queue without interrupting yet.
    await new Promise(resolve => setTimeout(resolve, 30)); // Separate it from the next typed text packet.
    let current = await page();
    expect(current.runs.map(run => run.state)).toEqual(['model', 'queued']);
    if (waiting) {
      // Let even the first empty Enter expire, then steer the existing message
      // with two distinct keypresses (the other case covers a batched pair).
      await new Promise(resolve => setTimeout(resolve, 550));
      child.terminal.write('\r');
      await new Promise(resolve => setTimeout(resolve, 50));
      expect((await page()).runs.map(run => run.state)).toEqual(['model', 'queued']);
      child.terminal.write('\r');
    } else {
      await type('send immediately'); child.terminal.write('\r\r');
    }
    await waitFor(async () => (await page()).runs.find(run => run.prompt === 'first task')?.state === 'cancelled', { label: 'double Enter interrupts' });
    await waitFor(() => visible().includes('Responding'), { label: 'progress follows the promoted turn' });
    await waitFor(async () => {
      const current = await page();
      return current.runs.length === (waiting ? 2 : 3) && current.runs.filter(run => run.state === 'completed').length === (waiting ? 1 : 2);
    }, { label: 'promoted message and queue finish', timeoutMs: 12000 });
    current = await page();
    expect(current.runs).toHaveLength(waiting ? 2 : 3);
    expect(current.messages.filter(message => message.role === 'user').map(message => current.runs.find(run => run.id === message.runId).prompt)).toEqual(waiting ? ['first task', 'queued follow-up'] : ['first task', 'send immediately', 'queued follow-up']);
    await waitFor(() => !visible().includes('Queued · 1 ›'));
    child.terminal.write('\x03');
    await waitFor(() => child.exitCode !== null);
    expect(await child.exited).toBe(0);
  } catch (error) {
    console.error(visible());
    throw error;
  } finally {
    if (child.exitCode === null) { child.kill(); await child.exited; }
    child.terminal?.close(); screen.dispose(); await client?.close();
  }
}, 30000);


test('Shift+Enter edits a multiline draft without submitting and Enter sends the whole prompt', async () => {
  const home = tempHome(); homes.push(home);
  const screen = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  let output = '', replied = false, client;
  const child = Bun.spawn([...CLI_COMMAND, home, '--home', home], {
    env: { ...process.env, JOLO_FAKE_STEPS: '1', JOLO_FAKE_DELAY_MS: '10', JOLO_IDLE_MS: '10000', CI: '0', NO_COLOR: '1' },
    terminal: { cols: 80, rows: 24, data(terminal, data) {
      output += new TextDecoder().decode(data); screen.write(data);
      if (!replied && output.includes('\x1b[?u')) { replied = true; terminal.write('\x1b[?0u'); }
    } },
  });
  const visible = () => Array.from({ length: screen.rows }, (_, i) => screen.buffer.active.getLine(screen.buffer.active.baseY + i)?.translateToString(true) ?? '').join('\n');
  const keys = async (input, expected) => {
    child.terminal.write(input);
    await waitFor(() => visible().includes(expected), { label: expected });
  };
  try {
    await waitFor(() => visible().includes('Ask Jolo anything'), { timeoutMs: 20000 });
    client = await tryConnect(resolvePaths({ home }), { clientKind: 'test', build: 'test' });
    await keys('first line', '❯ first line');
    await keys('\x1b[13;2u', '▎·');
    await keys('second line', '· second line');
    expect(visible()).toContain('❯ first line');
    expect((await client.call('session.list', {})).sessions).toHaveLength(0);
    // Move back into the first line and insert at the cursor, then restore it.
    child.terminal.write('\x1b[A');
    await keys('!', '❯ first line!');
    child.terminal.write('\x7f');
    await waitFor(() => !visible().includes('first line!'));
    child.terminal.write('\x1b[F');
    child.terminal.write('\n');
    await waitFor(() => visible().split('\n').filter(line => line.startsWith('▎·')).length === 2); // Ctrl+J is a fallback newline on terminals without modified Enter.
    await keys('third line', '· third line');
    expect((await client.call('session.list', {})).sessions).toHaveLength(0);
    child.terminal.write('\r');
    await waitFor(() => visible().includes('Completed'));
    const session = (await client.call('session.list', {})).sessions[0];
    const page = await client.call('session.page', { sessionId: session.id });
    expect(page.runs).toHaveLength(1);
    expect(page.runs[0].prompt).toBe('first line\nsecond line\nthird line');
    await keys('\x1b[A', '· third line');
    expect(visible()).toContain('❯ first line');
    expect(visible()).toContain('· second line');
    child.terminal.write('\x03');
    await waitFor(() => child.exitCode !== null);
    expect(await child.exited).toBe(0);
  } catch (error) {
    console.error(visible());
    throw error;
  } finally {
    if (child.exitCode === null) { child.kill(); await child.exited; }
    child.terminal?.close(); screen.dispose(); await client?.close();
  }
}, 30000);


test('a bracketed multi-line paste lands in the draft and Enter sends it as one prompt', async () => {
  const home = tempHome(); homes.push(home);
  const screen = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  let output = '', replied = false, client;
  const child = Bun.spawn([...CLI_COMMAND, home, '--home', home], {
    env: { ...process.env, JOLO_FAKE_STEPS: '1', JOLO_FAKE_DELAY_MS: '10', JOLO_IDLE_MS: '10000', CI: '0', NO_COLOR: '1' },
    terminal: { cols: 80, rows: 24, data(terminal, data) {
      output += new TextDecoder().decode(data); screen.write(data);
      if (!replied && output.includes('\x1b[?u')) { replied = true; terminal.write('\x1b[?0u'); }
    } },
  });
  const visible = () => Array.from({ length: screen.rows }, (_, i) => screen.buffer.active.getLine(screen.buffer.active.baseY + i)?.translateToString(true) ?? '').join('\n');
  try {
    await waitFor(() => visible().includes('Ask Jolo anything'), { timeoutMs: 20000 });
    client = await tryConnect(resolvePaths({ home }), { clientKind: 'test', build: 'test' });
    expect(output).toContain('\x1b[?2004h'); // bracketed paste is requested from the terminal
    // Terminals deliver a paste wrapped in \x1b[200~ … \x1b[201~ with \r\n line breaks.
    // A trailing line break is pasted text, not Enter: nothing submits and the next
    // keystrokes continue on the new line instead of joining the previous one.
    child.terminal.write('\x1b[200~first line\r\nsecond line\r\n\x1b[201~');
    await waitFor(() => visible().includes('first line') && visible().includes('second line'), { label: 'both pasted lines in the draft' });
    expect((await client.call('session.list', {})).sessions).toHaveLength(0); // the paste alone submits nothing
    child.terminal.write('third');
    await waitFor(() => visible().includes('third'), { label: 'typing continues after the pasted break' });
    expect((await client.call('session.list', {})).sessions).toHaveLength(0);
    child.terminal.write('\r');
    await waitFor(() => visible().includes('Completed'), { label: 'run completes', timeoutMs: 20000 });
    const session = (await client.call('session.list', {})).sessions[0];
    const page = await client.call('session.page', { sessionId: session.id });
    expect(page.runs).toHaveLength(1);
    expect(page.runs[0].prompt).toBe('first line\nsecond line\nthird');
    child.terminal.write('\x03');
    await waitFor(() => child.exitCode !== null);
    expect(await child.exited).toBe(0);
  } catch (error) {
    console.error(visible());
    throw error;
  } finally {
    if (child.exitCode === null) { child.kill(); await child.exited; }
    child.terminal?.close(); screen.dispose(); await client?.close();
  }
}, 30000);
