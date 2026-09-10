import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CLI_ENTRY, tempHome, waitFor, removeHome } from "./helpers.js";

const homes = [];
afterEach(async () => {
  for (const home of homes.splice(0)) {
    const proc = Bun.spawn([process.execPath, CLI_ENTRY, "engine", "stop", "--cancel", "--home", home], { stdout: "ignore", stderr: "ignore" });
    await proc.exited;
    removeHome(home);
  }
});

// eslint-disable-next-line no-control-regex
const strip = (text) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");

describe("ink interactive client", () => {
  test("negotiates Kitty keys, deletes words, and accepts a prompt starting with q", async () => {
    const home = tempHome(); homes.push(home);
    const repo = path.join(home, "repo");
    mkdirSync(repo, { recursive: true });
    let output = "";
    let replied = false;
    const child = Bun.spawn([process.execPath, CLI_ENTRY, repo, "--home", home], {
      env: { ...process.env, JOLO_IDLE_MS: "2000", JOLO_FAKE_STEPS: "1", JOLO_FAKE_DELAY_MS: "10", CI: "0" },
      terminal: { rows: 30, cols: 100, data(terminal, data) {
        output += new TextDecoder().decode(data);
        if (!replied && output.includes("\x1b[?u")) { replied = true; terminal.write("\x1b[?0u"); }
      } },
    });
    const draft = () => strip(output).split("\n").filter((row) => row.startsWith("▎❯ ")).at(-1)?.slice(3).trimEnd();
    const typeDraft = async (keys, expected) => {
      child.terminal.write(keys);
      await waitFor(() => draft() === expected, { label: `draft ${JSON.stringify(expected)}`, timeoutMs: 5000 });
    };
    try {
      await waitFor(() => output.includes("\x1b[>1u") && strip(output).includes("Jolo"), { label: "Kitty protocol enabled", timeoutMs: 20_000 });
      await typeDraft("q", "q");
      expect(child.exitCode).toBeNull();
      await typeDraft("uery discard  ", "query discard");
      await typeDraft("\x1b[127;5u", "query"); // Kitty Ctrl+Backspace
      await typeDraft("second", "query second");
      await typeDraft("\x1b[8;5u", "query"); // CSI-u BS codepoint variant
      await typeDraft("third", "query third");
      await typeDraft("\x1b\x7f", "query"); // Alt+Backspace
      await typeDraft("fourth", "query fourth");
      await typeDraft("\x17", "query"); // Ctrl+W
      await typeDraft("doneX", "query doneX");
      await typeDraft("\x7f", "query done"); // ordinary Backspace still deletes one character
      child.terminal.write("\r");
      await waitFor(() => strip(output).includes("done: query done") && strip(output).includes("verification: not_run"), { label: "edited prompt completed", timeoutMs: 20_000 });
      child.terminal.write("\x03");
      expect(await Promise.race([child.exited, new Promise((resolve) => setTimeout(() => resolve("timeout"), 10_000))])).toBe(0);
      expect(output).toContain("\x1b[<u"); // restore the terminal's previous keyboard mode
    } catch (error) {
      console.error("TUI keyboard output (stripped, tail):\n" + strip(output).slice(-2500));
      throw error;
    } finally {
      if (child.exitCode === null) child.kill();
      await child.exited;
      child.terminal?.close();
    }
  }, 60_000);

  test("runs a task, approves a command from the keyboard, shows output, and exits cleanly", async () => {
    const home = tempHome(); homes.push(home);
    const repo = path.join(home, "repo");
    mkdirSync(repo, { recursive: true });
    writeFileSync(path.join(repo, "README.md"), "# fixture\n");
    const script = [
      { text: ["Hello from **the TUI**.\n"] },
      { toolCalls: [{ name: "run_command", arguments: { argv: ["echo", "tui-cmd-ok"] } }] },
      { text: ["Command done.\n"] },
    ];
    const scriptPath = path.join(home, "script.json");
    writeFileSync(scriptPath, JSON.stringify(script));
    let output = "";
    const child = Bun.spawn([process.execPath, CLI_ENTRY, repo, "--home", home], {
      env: { ...process.env, JOLO_FAKE_SCRIPT: scriptPath, JOLO_IDLE_MS: "2000", CI: "0" },
      terminal: { rows: 30, cols: 100, data(_terminal, data) { output += new TextDecoder().decode(data); } },
    });
    const seen = (needle) => strip(output).includes(needle);
    const type = (text) => child.terminal.write(text);
    try {
      await waitFor(() => seen("Jolo"), { label: "tui header", timeoutMs: 20_000 });
      type("first task");
      type("\r");
      await waitFor(() => seen("Hello from the TUI.") && seen("› first task"), { label: "prompt and assistant text", timeoutMs: 20_000 });
      expect(seen("› first task")).toBe(true);
      await waitFor(() => seen("verification: not_run"), { label: "first run finished", timeoutMs: 20_000 });
      type("second task");
      type("\r");
      await waitFor(() => seen("Allow the agent to run: echo tui-cmd-ok"), { label: "permission prompt", timeoutMs: 20_000 });
      type("3");
      await waitFor(() => seen("Command done."), { label: "command run completed", timeoutMs: 20_000 });
      type("\t"); // reveal tool output
      await waitFor(() => seen('"exitCode":0'), { label: "tool output expanded", timeoutMs: 10_000 });
      await waitFor(() => seen("verification: passed"), { label: "second run finished", timeoutMs: 20_000 });
      type("\u0003");
      const code = await Promise.race([child.exited, new Promise((resolve) => setTimeout(() => resolve("timeout"), 10_000))]);
      expect(code).toBe(0);
    } catch (error) {
      console.error("TUI output (stripped, tail):\n" + strip(output).slice(-2500));
      throw error;
    } finally {
      if (child.exitCode === null) child.kill();
      await child.exited;
      child.terminal?.close();
    }
  }, 90_000);
});
