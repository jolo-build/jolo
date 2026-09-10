import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { startEngine, tempHome, waitFor, removeHome, sleep } from "./helpers.js";

const engines = [];
const homes = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
  for (const dir of homes.splice(0)) removeHome(dir);
});

const decode = (chunks) => Buffer.concat(chunks.map((c) => Buffer.from(c.data, "base64"))).toString("utf8");

describe("engine-owned terminals", () => {
  test("opens a shell, streams output, snapshots for a second client, enforces the input lease, and closes with its owner", async () => {
    const home = tempHome(); homes.push(home);
    const repo = path.join(home, "repo"); mkdirSync(repo, { recursive: true });
    const engine = await startEngine({ home, env: { JOLO_SHELL: "/bin/sh", OPENAI_API_KEY: "sk-secret" } }); engines.push(engine);
    const owner = await engine.connect({ clientKind: "desktop" });
    const project = await owner.call("project.open", { path: repo });
    const outputs = [];
    owner.onNotification("terminal.output", (params) => outputs.push(params));
    const states = [];
    owner.onNotification("terminal.state", (params) => states.push(params));
    const opened = await owner.call("terminal.open", { workspaceId: project.workspaceId, cols: 80, rows: 24 });
    expect(opened.inputLease).toBe(true);
    expect(opened.terminal.state).toBe("running");
    await owner.call("terminal.input", { terminalId: opened.terminal.terminalId, data: "echo term-ok; echo KEY=$OPENAI_API_KEY\n" });
    await waitFor(() => decode(outputs).includes("term-ok") && decode(outputs).includes("KEY="), { label: "shell output" });
    expect(decode(outputs)).not.toContain("sk-secret");
    expect(outputs.map((o) => BigInt(o.seq)).every((seq, i, all) => i === 0 || seq > all[i - 1])).toBe(true);

    const observer = await engine.connect({ clientKind: "tui" });
    const attached = await observer.call("terminal.attach", { terminalId: opened.terminal.terminalId });
    expect(attached.inputLease).toBe(false);
    expect(attached.snapshot).toContain("term-ok");
    await expect(observer.call("terminal.input", { terminalId: opened.terminal.terminalId, data: "ls\n" })).rejects.toMatchObject({ code: "permission_denied" });
    await expect(observer.call("terminal.lease", { terminalId: opened.terminal.terminalId })).rejects.toMatchObject({ code: "conflict" });
    const observerOutputs = [];
    observer.onNotification("terminal.output", (params) => observerOutputs.push(params));
    await owner.call("terminal.resize", { terminalId: opened.terminal.terminalId, cols: 100, rows: 30 });
    await owner.call("terminal.input", { terminalId: opened.terminal.terminalId, data: "stty size\n" });
    await waitFor(() => decode(observerOutputs).includes("30 100"), { label: "resize visible to observer" });
    expect((await owner.call("terminal.list", { workspaceId: project.workspaceId })).terminals).toHaveLength(1);

    const observerStates = [];
    observer.onNotification("terminal.state", (params) => observerStates.push(params));
    await owner.close(); // controlling client gone: the default shell closes (§14.2)
    await waitFor(() => observerStates.some((s) => s.state === "exited"), { label: "terminal closed with its owner" });
    expect((await observer.call("terminal.list", {})).terminals).toHaveLength(0);
    await observer.close();
  }, 30_000);

  test("keep-alive terminals survive their owner and hold the engine open until closed", async () => {
    const home = tempHome(); homes.push(home);
    const repo = path.join(home, "repo"); mkdirSync(repo, { recursive: true });
    const engine = await startEngine({ home, idleMs: 700, env: { JOLO_SHELL: "/bin/sh" } }); engines.push(engine);
    const owner = await engine.connect({ clientKind: "desktop" });
    const project = await owner.call("project.open", { path: repo });
    const opened = await owner.call("terminal.open", { workspaceId: project.workspaceId, keepAlive: true });
    await owner.close();
    await sleep(1_500); // longer than the idle grace: the retained shell keeps the engine alive
    expect(engine.child.exitCode).toBeNull();
    const next = await engine.connect({ clientKind: "desktop" });
    const attached = await next.call("terminal.attach", { terminalId: opened.terminal.terminalId });
    expect(attached.terminal.state).toBe("running");
    expect(attached.inputLease).toBe(false);
    expect((await next.call("terminal.lease", { terminalId: opened.terminal.terminalId })).inputLease).toBe(true);
    await next.call("terminal.close", { terminalId: opened.terminal.terminalId });
    await next.close();
    const code = await Promise.race([engine.child.exited, sleep(5_000).then(() => "timeout")]);
    if (code === "timeout") {
      const { readFileSync } = await import("node:fs");
      console.error("engine log tail:\n" + readFileSync(path.join(home, "logs", "t", "engine.log"), "utf8").split("\n").slice(-12).join("\n"));
    }
    expect(code).toBe(0);
  }, 30_000);
});
