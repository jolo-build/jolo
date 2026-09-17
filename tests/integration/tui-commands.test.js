import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { CLI_ENTRY, ROOT, startEngine, tempHome, removeHome, waitFor } from "./helpers.js";

const { Terminal } = createRequire(new URL("../../apps/engine/package.json", import.meta.url))("@xterm/headless");
const DOWN = "\x1b[B", UP = "\x1b[A", ESC = "\x1b", ENTER = "\r";
const interactiveCommand = process.env.JOLO_TEST_CLI ? [process.env.JOLO_TEST_CLI] : [process.execPath, "run", "jolo"];
const headlessCommand = process.env.JOLO_TEST_CLI ? [process.env.JOLO_TEST_CLI] : [process.execPath, CLI_ENTRY];

async function boot({ env = {} } = {}) {
  const home = tempHome();
  const repo = path.join(home, "repo"); mkdirSync(repo);
  const agents = path.join(home, "data", "t", "agents"); mkdirSync(agents, { recursive: true });
  writeFileSync(path.join(agents, "fixture.json"), JSON.stringify({ id: "fixture", displayName: "Fixture Agent", binary: "/usr/bin/true", transport: "acp", modelArgs: ["--model", "{model}"], effortArgs: ["--effort", "{effort}"] }));
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  for (const [id, displayName, transport] of [["claude", "Claude Code", "claude-stream"], ["codex", "Codex", "codex-app-server"]]) {
    const binary = path.join(home, `fake-${id}`);
    writeFileSync(binary, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(ROOT, "tests", "fixtures", `fake-${id}.js`))} "$@"\n`, { mode: 0o755 });
    writeFileSync(path.join(agents, `${id}.json`), JSON.stringify({ id, displayName, binary, transport, modelArgs: ["--model", "{model}"], effortArgs: ["--effort", "{effort}"] }));
  }
  writeFileSync(path.join(agents, "absent.json"), JSON.stringify({ id: "absent", displayName: "Absent Agent", binary: path.join(home, "not-installed"), transport: "acp", modelArgs: ["--model", "{model}"] }));
  const engine = await startEngine({ home, fakeSteps: 1, fakeDelayMs: 10, env: { JOLO_CREDENTIALS: "session", OPENAI_API_KEY: "" } });
  const client = await engine.connect();
  const project = await client.call("project.open", { path: repo });
  const screen = new Terminal({ cols: 100, rows: 30, scrollback: 5000, allowProposedApi: true });
  let output = "";
  const child = Bun.spawn([...interactiveCommand, repo, "--home", home, "--profile", "t"], {
    cwd: ROOT, env: { ...process.env, CI: "0", TERM: "xterm-256color", ...env },
    terminal: { cols: 100, rows: 30, data(_terminal, data) { output += new TextDecoder().decode(data); screen.write(data); } },
  });
  const allLines = () => Array.from({ length: screen.buffer.active.length }, (_, i) => screen.buffer.active.getLine(i)?.translateToString(true) ?? "");
  const lines = () => allLines().slice(screen.buffer.active.baseY);
  const text = () => lines().join("\n");
  const selected = () => lines().filter((line) => /^(?:│ › |▎❯ )/.test(line)).at(-1) ?? "";
  const type = (text) => child.terminal.write(text);
  const seen = (value) => waitFor(() => text().includes(value), { label: value, timeoutMs: 15000 });
  const select = async (label) => {
    for (let n = 0; n < 32; n++) {
      if (selected().startsWith(`│ › ${label}`)) return;
      const before = selected(); type(DOWN);
      await waitFor(() => selected() !== before, { label: `move to ${label}` });
    }
    throw new Error(`field not found: ${label}`);
  };
  const edit = async (label, value, secret = false) => {
    await select(label); type(ENTER); await seen("Type to replace");
    type(value || "\x15");
    await waitFor(() => selected().includes(`${label}  ${secret ? "••••••••" : value || "agent default"}`), { label: `typed ${label}` });
    type(ENTER); await seen("Enter edit/save");
  };
  const prompt = async (value) => { type(value); await seen(`❯ ${value}`); type(ENTER); };
  const ready = () => waitFor(() => lines().some((line) => line.startsWith("▎❯ ")), { label: "prompt ready", timeoutMs: 15000 });
  return { home, repo, engine, client, project, screen, child, text, selected, type, seen, select, edit, prompt, ready, output: () => output, allLines,
    async close() {
      if (child.exitCode === null) child.kill();
      await child.exited; child.terminal?.close(); screen.dispose();
      await client.close(); await engine.stop(); removeHome(home);
    },
  };
}

test('model mentions complete without submitting and authorize a child on the selected source and effort', async () => {
  const t = await boot();
  try {
    await t.ready();
    t.type('@codex delegation-check ^fake-large~high');
    await t.seen('Fake Large');
    t.type(ENTER);
    await t.seen('^agent:codex/fake-large~high');
    expect((await t.client.call('session.list', { projectId: t.project.projectId })).sessions).toHaveLength(0);
    t.type(ENTER);
    await t.seen('Child result: Running fake-large at high.');
    const { sessions } = await t.client.call('session.list', { projectId: t.project.projectId });
    expect(sessions).toHaveLength(2);
    const parent = sessions.find(session => session.title !== 'Selected model review');
    const { delegations } = await t.client.call('delegation.list', { sessionId: parent.id });
    expect(delegations[0]).toMatchObject({ state: 'completed', execution: { agentId: 'codex', model: 'fake-large', effort: 'high' } });
  } catch (error) { console.error(t.text()); throw error; }
  finally { await t.close(); }
}, 30_000);

test("/model configures the shared provider and hosted models without sending commands or secrets as tasks", async () => {
  const t = await boot();
  try {
    await t.ready();
    await t.prompt("/model openai"); await t.seen("Models / OpenAI");
    await t.edit("Model", "test-model");
    await t.edit("Context tokens", "64000");
    await t.edit("Max output tokens", "4000");
    await t.edit("API key", "sk-terminal-secret-test", true);
    expect(t.output()).not.toContain("sk-terminal-secret-test");
    await t.select("Save"); t.type(ENTER); await t.seen("Model configuration saved");
    const settings = (await t.client.call("settings.get", {})).settings;
    expect(settings.model).toMatchObject({ model: "test-model", contextWindowTokens: 64000, maxOutputTokens: 4000 });
    expect(JSON.stringify(settings)).not.toContain("sk-terminal-secret-test");
    expect((await t.client.call("credential.status", { provider: "openai" })).source).toBe("session");
    expect((await t.client.call("session.list", { projectId: t.project.projectId })).sessions).toHaveLength(0);

    await t.prompt("/model jolo"); await t.seen("Models / Jolo provider");
    await t.edit("Model", "discard-this-model");
    t.type(ESC); await t.seen("Choose the agent for your prompts"); t.type(ESC); await t.ready();
    expect((await t.client.call("settings.get", {})).settings.model.model).toBe("test-model");
    t.type(UP); await new Promise((resolve) => setTimeout(resolve, 80));
    expect(t.selected()).not.toContain("/model");

    await t.prompt("/model fixture"); await t.seen("Models / Fixture Agent");
    await t.edit("Model", "custom-agent-model"); await t.edit("Effort", "high");
    t.screen.resize(54, 10); t.child.terminal.resize(54, 10); await t.seen("Models / Fixture Agent");
    await t.select("Save"); t.type(ENTER); await t.seen("Model configuration saved");
    expect((await t.client.call("settings.get", {})).settings.agents.fixture).toEqual({ model: "custom-agent-model", effort: "high" });
    t.screen.resize(100, 30); t.child.terminal.resize(100, 30); await t.ready();
    await t.prompt("/model jolo"); await t.seen("Models / Jolo provider");
    await t.select("Provider"); t.type("\x1b[D"); await t.seen("Provider  fake");
    await t.select("Save"); t.type(ENTER); await t.ready(); await t.seen("Demo provider");
    await t.prompt("actual task"); await t.seen("done: actual task");
    const sessions = (await t.client.call("session.list", { projectId: t.project.projectId })).sessions;
    expect(sessions).toHaveLength(1);
    expect((await t.client.call("session.page", { sessionId: sessions[0].id })).runs.map((run) => run.prompt)).toEqual(["actual task"]);
    expect(t.screen.buffer.active.type).toBe("normal");
    expect(t.screen.modes.mouseTrackingMode).toBe("none");
  } catch (error) { console.error(t.text()); throw error; }
  finally { await t.close(); }
}, 60000);

test("/model switches agents and models in place, preserving the chat and carrying context", async () => {
  const t = await boot();
  const savedSessions = async () => (await t.client.call("session.list", { projectId: t.project.projectId })).sessions;
  try {
    await t.ready();
    await t.prompt("before switching"); await t.seen("done: before switching");
    const original = (await savedSessions())[0];
    await t.client.call("settings.update", { agents: { claude: { model: "fable", effort: "high" } } });
    await t.prompt("/model"); await t.seen("Enter use");
    await t.select("Claude Code"); t.type(ENTER); await t.seen("claude · fable");
    expect(await savedSessions()).toHaveLength(1);
    expect((await savedSessions())[0]).toMatchObject({ id: original.id, agentId: "claude", title: "before switching" });
    expect(t.allLines().filter((line) => line.includes("done: before switching"))).toHaveLength(1); // No remount or transcript replay.
    t.type(UP); await t.seen("❯ before switching"); t.type(DOWN); await t.seen("Ask Jolo anything");
    await t.prompt("model?"); await t.seen("Running fable at high.");
    const claude = (await savedSessions()).find((session) => session.agentId === "claude");
    expect(claude.id).toBe(original.id);
    expect((await t.client.call("session.page", { sessionId: original.id })).runs.map((run) => run.prompt)).toEqual(["before switching", "model?"]);

    await t.prompt("/model claude"); await t.seen("Models / Claude Code");
    await t.edit("Model", "haiku"); await t.select("Save"); t.type(ENTER); await t.seen("claude · haiku");
    await t.prompt("model again"); await t.seen("Running haiku at high.");
    expect((await t.client.call("session.page", { sessionId: claude.id })).runs).toHaveLength(3);
    expect(await savedSessions()).toHaveLength(1);

    await t.prompt("/model"); await t.seen("Enter use"); await t.select("Codex"); t.type("e"); await t.seen("Models / Codex");
    await t.select("Find models"); t.type(ENTER); await t.seen("Fake Small");
    await t.select("Fake Small"); t.type(ENTER); await t.seen("Model  fake-small");
    await t.edit("Effort", "low"); await t.select("Save"); t.type(ENTER); await t.seen("codex · fake-small");
    await t.prompt("model?"); await t.seen("Running fake-small at low.");
    expect((await savedSessions())[0]).toMatchObject({ id: original.id, agentId: "codex" });
    await t.prompt("history"); await t.seen("Resumed context: history"); // Same-agent turns use the native continuation.

    await t.prompt("/model"); await t.seen("Enter use"); await t.select("Absent Agent"); t.type(ENTER); await t.seen("not installed or is unavailable");
    t.type(ESC); await t.ready(); expect(t.text()).toContain("codex · fake-small");
    await t.prompt("/model"); await t.seen("Enter use"); await t.select("Jolo provider"); t.type(ENTER); await t.ready(); await t.seen("Demo provider");
    await t.prompt("back to jolo"); await t.seen("done: back to jolo");
    expect(await savedSessions()).toHaveLength(1);
    expect((await savedSessions())[0]).toMatchObject({ id: original.id, agentId: null });
    // Returning to Claude must start its native context from the shared chat,
    // not resume a stale vendor conversation that missed the Codex/Jolo turns.
    await t.prompt("/model"); await t.seen("Enter use"); await t.select("Claude Code"); t.type(ENTER); await t.seen("claude · haiku");
    await t.prompt("history"); await t.seen("Fresh agent context:");
    await waitFor(async () => (await t.client.call("session.page", { sessionId: original.id })).runs.every((run) => run.state === "completed"));
    const page = await t.client.call("session.page", { sessionId: original.id });
    const answer = page.messages.filter((message) => message.role === "assistant" && message.kind === "text").at(-1);
    const context = (await t.client.call("artifact.read", { artifactId: answer.artifactId, offset: 0, length: answer.committedBytes })).text;
    expect(context).toContain("done: before switching");
    expect(context).toContain("Running fake-small at low.");
    expect(context).toContain("done: back to jolo");
    await t.prompt(`/session restore ${original.id}`);
    await waitFor(() => t.allLines().some((line) => line.includes("Restored: before switching")));
    await t.seen("claude · haiku");
    await t.prompt("model restored");
    await waitFor(async () => (await t.client.call("session.page", { sessionId: original.id })).runs.filter((run) => run.state === "completed").length === 8);
    expect(await savedSessions()).toHaveLength(1);
  } catch (error) { console.error(t.text()); throw error; }
  finally { await t.close(); }
}, 60000);

test("session commands list, restore archived chats with prompt history, and confirm deletion", async () => {
  const t = await boot();
  try {
    await t.ready();
    const { session } = await t.client.call("session.create", { projectId: t.project.projectId, workspaceId: t.project.workspaceId, title: "Saved conversation" });
    const { run } = await t.client.call("run.start", { sessionId: session.id, requestId: "req_saved_chat", prompt: "remember this prompt" });
    await waitFor(async () => (await t.client.call("run.snapshot", { runId: run.id })).run.state === "completed");
    const current = (await t.client.call("session.page", { sessionId: session.id })).session;
    await t.client.call("session.archive", { sessionId: session.id, expectedRevision: current.revision, archived: true });
    await t.prompt("/session list"); await t.seen("Saved conversation · archived");
    t.type(ENTER); await t.seen("Restored: Saved conversation"); await t.seen("done: remember this prompt");
    expect((await t.client.call("session.page", { sessionId: session.id })).session.state).toBe("open");
    t.type(UP); await waitFor(() => t.selected().includes("remember this prompt"));
    t.type(DOWN); await waitFor(() => !t.selected().includes("remember this prompt"));
    await t.prompt(`/session delete ${session.id}`); await t.seen("Delete “Saved conversation”?");
    t.type(ESC); await t.seen("Enter restore");
    expect((await t.client.call("session.page", { sessionId: session.id })).session.id).toBe(session.id);
    t.type("d"); await t.seen("Delete “Saved conversation”?");
    t.type(ENTER); await t.seen("New session");
    await expect(t.client.call("session.page", { sessionId: session.id })).rejects.toMatchObject({ code: "not_found" });
    await t.prompt("fresh after deletion"); await t.seen("done: fresh after deletion");
    const remaining = (await t.client.call("session.list", { projectId: t.project.projectId })).sessions;
    expect(remaining).toHaveLength(1); expect(remaining[0].id).not.toBe(session.id);
    expect((await t.client.call("session.page", { sessionId: remaining[0].id })).runs.map((run) => run.prompt)).toEqual(["fresh after deletion"]);
  } catch (error) { console.error(t.text()); throw error; }
  finally { await t.close(); }
}, 60000);

test("headless session list, restore, and delete use the same stored sessions", async () => {
  const t = await boot();
  const run = async (...args) => {
    const child = Bun.spawn([...headlessCommand, "session", ...args, "--home", t.home, "--profile", "t", "--json"], { stdout: "pipe", stderr: "pipe" });
    const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(error);
    return JSON.parse(output);
  };
  try {
    const { session } = await t.client.call("session.create", { projectId: t.project.projectId, workspaceId: t.project.workspaceId, title: "Archived" });
    await t.client.call("session.archive", { sessionId: session.id, expectedRevision: session.revision, archived: true });
    expect((await run("list")).sessions).toHaveLength(0);
    expect((await run("list", "--all")).sessions[0].id).toBe(session.id);
    expect((await run("restore", session.id)).session.state).toBe("open");
    const screen = new Terminal({ cols: 100, rows: 30, allowProposedApi: true });
    const restored = Bun.spawn([...headlessCommand, "session", "restore", session.id, "--home", t.home, "--profile", "t"], {
      cwd: ROOT, env: { ...process.env, CI: "0" },
      terminal: { cols: 100, rows: 30, data(_terminal, data) { screen.write(data); } },
    });
    try {
      await waitFor(() => Array.from({ length: screen.buffer.active.length }, (_, i) => screen.buffer.active.getLine(i)?.translateToString(true) ?? "").join("\n").includes("Restored: Archived"), { label: "shell restore opens the saved project", timeoutMs: 15000 });
      restored.terminal.write("\x03");
      await waitFor(() => restored.exitCode !== null);
      expect(await restored.exited).toBe(0);
    } finally {
      if (restored.exitCode === null) restored.kill();
      await restored.exited; restored.terminal?.close(); screen.dispose();
    }
    expect(await run("delete", session.id)).toEqual({ sessionId: session.id, deleted: true });
    expect((await run("list", "--all")).sessions).toHaveLength(0);
  } finally { await t.close(); }
}, 30000);

test("a known session ID restores even when it is older than the recent list", async () => {
  const t = await boot();
  try {
    await t.ready();
    const { session } = await t.client.call("session.create", { projectId: t.project.projectId, workspaceId: t.project.workspaceId, title: "Older conversation" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    for (let i = 0; i < 51; i++) await t.client.call("session.create", { projectId: t.project.projectId, workspaceId: t.project.workspaceId, title: `Recent ${i}` });
    expect((await t.client.call("session.list", { projectId: t.project.projectId })).sessions.some((entry) => entry.id === session.id)).toBe(false);
    await t.prompt(`/session restore ${session.id}`);
    await t.seen("Restored: Older conversation");
    await t.prompt(`/session delete ${session.id}`); await t.seen("Delete “Older conversation”?");
    t.type(ENTER); await t.seen("New session");
    await expect(t.client.call("session.page", { sessionId: session.id })).rejects.toMatchObject({ code: "not_found" });
  } catch (error) { console.error(t.text()); throw error; }
  finally { await t.close(); }
}, 30000);

test('themes switch live, discover installs, and recover from an invalid edit without creating tasks', async () => {
  const t = await boot({ env: { COLORTERM: 'truecolor', FORCE_COLOR: '3', JOLO_THEME: 'catppuccin-mocha' } });
  const directory = path.join(t.home, 'data', 't', 'themes');
  const promptCell = (column = 0) => {
    const row = t.allLines().findLastIndex((line) => line.startsWith('▎❯ '));
    return row < 0 ? null : t.screen.buffer.active.getLine(row)?.getCell(column);
  };
  const color = (hex) => waitFor(() => promptCell()?.getFgColor() === parseInt(hex, 16), { label: `prompt color ${hex}` });
  try {
    await t.ready(); await color('89b4fa');
    expect(t.output()).toContain('\x1b]11;#1e1e2e\x1b\\');
    await t.prompt('/themes'); await t.seen('Themes');
    expect(t.text()).toContain('Catppuccin Mocha · current');
    await t.select('GitHub Light'); t.type(ENTER); await t.ready();
    await color('0969da');
    expect(t.output()).toContain('\x1b]11;#ffffff\x1b\\');
    const welcomeRow = t.allLines().findLastIndex((line) => line.includes('Welcome to Jolo'));
    const welcomeLine = t.screen.buffer.active.getLine(welcomeRow);
    expect(welcomeLine.getCell(welcomeLine.translateToString().indexOf('Welcome')).getFgColor()).toBe(-1);
    expect(t.output()).toContain('\x1b]10;#1f2328\x1b\\');
    expect(promptCell(20).getBgColor()).toBe(0xf6f8fa);
    expect(JSON.parse(readFileSync(path.join(directory, '.selected.json'), 'utf8')).id).toBe('github-light');

    await t.prompt('/theme create ocean --from github-dark --set accent=#123456 --use');
    await color('123456');
    const file = path.join(directory, 'ocean.json');
    const data = JSON.parse(readFileSync(file, 'utf8'));
    data.colors.accent = '#abcdef'; writeFileSync(file, JSON.stringify(data));
    await color('abcdef');
    writeFileSync(file, JSON.stringify({ ...data, colors: { accent: 'bad' } }));
    await t.seen('Theme color accent must be #RRGGBB');
    expect(promptCell().getFgColor()).toBe(0xabcdef);
    data.colors.accent = '#654321'; writeFileSync(file, JSON.stringify(data));
    await color('654321');
    await waitFor(() => !t.text().includes('Theme color accent must be'), { label: 'theme edit recovered' });

    await t.prompt('/themes'); await t.seen('Themes');
    const imported = { version: 1, id: 'z-new', name: 'New palette', extends: 'catppuccin-latte', colors: { accent: '#aabbcc' } };
    writeFileSync(path.join(directory, 'z-new.json'), JSON.stringify(imported));
    await t.seen('New palette');
    await t.select('New palette'); t.type(ENTER); await t.ready(); await color('aabbcc');
    await t.prompt('/theme remove z-new'); await t.seen('Removed theme z-new.');
    await waitFor(() => promptCell()?.getBgColor() === -1, { label: 'terminal colors restored' });

    const source = path.join(t.home, 'theme source.json');
    writeFileSync(source, JSON.stringify({ ...imported, id: 'downloaded' }));
    t.type(`/theme install "${source}" --use`); await t.seen('source.json" --use'); t.type(ENTER); await color('aabbcc');
    // An external CLI selection reaches the running UI through the saved profile setting.
    const child = Bun.spawn([...headlessCommand, 'theme', 'use', 'github-dark', '--home', t.home, '--profile', 't'], { stdout: 'pipe', stderr: 'pipe' });
    expect(await child.exited).toBe(0); await color('2f81f7');
    expect((await t.client.call('session.list', { projectId: t.project.projectId })).sessions).toHaveLength(0);
    t.type('\x03'); await waitFor(() => t.child.exitCode !== null);
    expect(await t.child.exited).toBe(0);
    expect(t.output()).toContain('\x1b[0m');
  } catch (error) { console.error(t.text()); throw error; }
  finally { await t.close(); }
}, 30000);

test('slash command suggestions replace footer shortcuts and support filtering, navigation, and completion', async () => {
  const t = await boot();
  try {
    await t.ready();
    const promptRow = t.allLines().findLastIndex((line) => line.startsWith('▎❯ '));
    expect(t.allLines()[promptRow + 2]).not.toContain('/');
    t.type('/'); await t.seen('Choose a color theme');
    t.type(DOWN); await t.seen('› /sessions');
    t.type(DOWN); await t.seen('› /themes');
    t.type(ENTER); await t.seen('Themes');
    t.type(ESC); await t.ready();
    t.type('/th'); await t.seen('› /themes');
    t.type(ESC);
    await waitFor(() => !t.text().includes('Choose a color theme'), { label: 'suggestions dismissed' });
    expect(t.text()).toContain('❯ /th');
    t.type('\x17'); await t.seen('Ask Jolo anything');
    t.type('/'); await t.seen('Choose a color theme');
    t.type('\x17'); await t.seen('Ask Jolo anything');
    t.type('/theme c'); await t.seen('› /theme create');
    t.type('\t'); await t.seen('❯ /theme create');
    await waitFor(() => !t.text().includes('Create a custom theme'), { label: 'completion starts arguments' });
    t.type('fresh --from github-dark --use'); t.type(ENTER); await t.seen('Created fresh:');
    expect(JSON.parse(readFileSync(path.join(t.home, 'data', 't', 'themes', 'fresh.json'), 'utf8')).extends).toBe('github-dark');
    expect((await t.client.call('session.list', { projectId: t.project.projectId })).sessions).toHaveLength(0);
  } catch (error) { console.error(t.text()); throw error; }
  finally { await t.close(); }
}, 30000);

test('existing transcript backgrounds follow theme changes after chatting and resizing', async () => {
  const t = await boot({ env: { COLORTERM: 'truecolor', FORCE_COLOR: '3', JOLO_THEME: 'catppuccin-frappe' } });
  const expectUnpaintedTranscript = () => {
    const rows = t.allLines();
    const prompt = rows.findLastIndex((line) => line.startsWith('▎❯ '));
    expect(prompt).toBeGreaterThan(0);
    const first = rows.findIndex((line) => line.startsWith('Jolo '));
    const backgrounds = new Set();
    for (let y = first; y < prompt - 1; y++) {
      const line = t.screen.buffer.active.getLine(y);
      for (let x = 0; x < t.screen.cols; x++) backgrounds.add(line.getCell(x).getBgColor());
    }
    expect([...backgrounds]).toEqual([-1]);
  };
  const switchTheme = async (id, background) => {
    const from = t.output().length;
    await t.prompt(`/theme use ${id}`);
    await waitFor(() => t.output().slice(from).includes(`\x1b]11;${background}\x1b\\`), { label: `canvas ${id}` });
    await t.ready();
    await new Promise((resolve) => t.screen.write('', resolve));
  };
  try {
    await t.ready();
    await t.prompt('first message with a wider line');
    await t.seen('done: first message with a wider line'); await t.seen('Completed');
    expectUnpaintedTranscript();
    await switchTheme('catppuccin-mocha', '#1e1e2e');
    expectUnpaintedTranscript();
    await t.prompt('second message');
    await t.seen('done: second message'); await t.seen('Completed');
    expectUnpaintedTranscript();
    await switchTheme('github-light', '#ffffff');
    expectUnpaintedTranscript();
    for (const cols of [54, 120]) {
      t.screen.resize(cols, 30); t.child.terminal.resize(cols, 30);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await t.ready();
      expectUnpaintedTranscript();
    }
    await switchTheme('catppuccin-frappe', '#303446');
    expectUnpaintedTranscript();
    for (const message of ['done: first message with a wider line', 'done: second message']) {
      expect(t.allLines().filter((line) => line.includes(message))).toHaveLength(1);
    }
    const rows = t.allLines();
    const prompt = rows.findLastIndex((line) => line.startsWith('▎❯ '));
    expect(t.screen.buffer.active.getLine(prompt).getCell(20).getBgColor()).toBe(0x292c3c);
  } catch (error) { console.error(t.text()); throw error; }
  finally { await t.close(); }
}, 30000);
