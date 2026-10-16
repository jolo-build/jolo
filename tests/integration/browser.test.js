import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { startEngine, tempHome, waitFor, removeHome } from "./helpers.js";
import { scriptedHost, PNG_BASE64 } from "../fixtures/scripted-browser-host.js";

const engines = [];
const homes = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
  for (const dir of homes.splice(0)) removeHome(dir);
});

async function setup({ script, behaviour = "ok", withHost = true }) {
  const home = tempHome(); homes.push(home);
  const repo = path.join(home, "repo"); mkdirSync(repo, { recursive: true }); writeFileSync(path.join(repo, "README.md"), "# fixture\n");
  const scriptPath = path.join(home, "script.json"); writeFileSync(scriptPath, JSON.stringify(script));
  const engine = await startEngine({ home, env: { JOLO_FAKE_SCRIPT: scriptPath } }); engines.push(engine);
  const client = await engine.connect();
  const project = await client.call("project.open", { path: repo });
  const host = withHost ? await scriptedHost(engine, project.workspaceId, behaviour) : null;
  const { session, cursor } = await client.call("session.create", { projectId: project.projectId, workspaceId: project.workspaceId, title: "browser" });
  const events = [];
  await client.subscribe({ after: cursor, sessionId: session.id }, { onEvent: (e) => events.push(e) });
  const { run } = await client.call("run.start", { sessionId: session.id, requestId: "req_b", prompt: "open the page and click" });
  await waitFor(() => events.some((e) => e.type === "run.state" && ["completed", "failed", "paused", "cancelled"].includes(e.payload.state)), { label: "run finished", timeoutMs: 20_000 });
  const snapshot = await client.call("run.snapshot", { runId: run.id });
  return { client, engine, session, host, events, run: snapshot.run, messages: snapshot.messages, read: async (m, encoding = "utf8") => client.call("artifact.read", { artifactId: m.artifactId, encoding }) };
}

describe("agent browser control through the engine broker", () => {
  test('a chat tool opens a closed pane before navigation and inspection', async () => {
    const { host, run, events } = await setup({ behaviour: 'closed', script: [
      { toolCalls: [{ name: 'browser_open', arguments: {} }] },
      { toolCalls: [{ name: 'browser_navigate', arguments: { url: 'https://www.google.com/search?q=iphone+13+pro+max' } }] },
      { toolCalls: [{ name: 'browser_snapshot', arguments: {} }] },
      { text: ['Opened the search in the inline browser.'] },
    ] });
    expect(run.state).toBe('completed');
    expect(host.received.map(call => call.operation)).toEqual(['open', 'navigate', 'snapshot']);
    expect(events.filter(event => event.type === 'tool.completed').map(event => event.payload.status)).toEqual(['ok', 'ok', 'ok']);
    await host.client.close();
  });
  test("dispatches admitted operations to the registered host and stores results and screenshots", async () => {
    const script = [
      { toolCalls: [{ name: "browser_navigate", arguments: { url: "http://fixture/" } }, { name: "browser_snapshot", arguments: {} }] },
      { toolCalls: [{ name: "browser_click", arguments: { ref: "e2", snapshotId: "snap_2" } }, { name: "browser_screenshot", arguments: {} }, { name: "browser_network", arguments: { filter: "fixture" } }] },
      { text: ["Clicked.\n"] },
    ];
    const { client, host, events, run, messages, read } = await setup({ script });
    expect(run.state).toBe("completed");
    expect(host.received.map((r) => r.operation)).toEqual(["navigate", "snapshot", "click", "screenshot", "network"]);
    expect(host.received[0]).toMatchObject({ capabilityId: host.capabilityId, arguments: { url: "http://fixture/" }, navigationRevision: 1 });
    expect(host.received[0].argumentDigest).toStartWith("sha256:");
    expect(host.received[2].navigationRevision).toBe(2); // the engine tracked the host's navigation
    const completed = events.filter((e) => e.type === "tool.completed").map((e) => e.payload);
    expect(completed.map((r) => r.status)).toEqual(["ok", "ok", "ok", "ok", "ok"]);
    const tools = messages.filter((m) => m.kind === "tool");
    const texts = await Promise.all(tools.map(async (m) => (await read(m)).text));
    const shot = texts.find((t) => t.startsWith("browser_screenshot"));
    expect(shot).toBeDefined();
    expect(texts.find((t) => t.startsWith("browser_network"))).toContain('"status":200');
    const artifactId = JSON.parse(shot.split("\n")[1]).artifactId;
    const image = await client.call("artifact.read", { artifactId, encoding: "base64" });
    expect(image.kind).toBe("screenshot");
    expect(image.text).toBe(PNG_BASE64);
    expect(events.some((e) => e.type === "tool.started" && e.payload.name === "browser_click")).toBe(true);
    await host.client.close();
  });

  test("computer-use operations reach the host with their coordinates, and screenshots are recorded on the transcript without base64", async () => {
    const script = [
      { toolCalls: [{ name: "browser_screenshot", arguments: {} }] },
      { toolCalls: [{ name: "browser_pointer", arguments: { action: "double_click", x: 40, y: 50, modifiers: ["Shift"] } }, { name: "browser_type", arguments: { text: "hello" } }, { name: "browser_press", arguments: { key: "Enter", repeat: 2 } }] },
      { toolCalls: [{ name: "browser_zoom", arguments: { x0: 0, y0: 0, x1: 80, y1: 60 } }, { name: "browser_wait", arguments: { ms: 100 } }, { name: "browser_scroll", arguments: { x: 5, y: 6, deltaY: 200 } }] },
      { toolCalls: [{ name: "browser_pointer", arguments: { action: "drag", x: 1, y: 2 } }] },
      { text: ["Done.\n"] },
    ];
    const { engine, session, host, events, run } = await setup({ script });
    expect(run.state).toBe("completed");
    expect(host.received.map((r) => r.operation)).toEqual(["screenshot", "pointer", "type", "press", "zoom", "wait", "scroll"]);
    expect(host.received[1].arguments).toEqual({ action: "double_click", x: 40, y: 50, modifiers: ["Shift"] });
    expect(host.received[2].arguments).toEqual({ text: "hello", submit: false });
    expect(host.received[3].arguments).toMatchObject({ key: "Enter", repeat: 2, modifiers: [] });
    expect(host.received[6].arguments).toMatchObject({ x: 5, y: 6, deltaY: 200 });
    const completed = events.filter((e) => e.type === "tool.completed").map((e) => e.payload);
    expect(completed.map((r) => `${r.name}:${r.status}`)).toEqual(["browser_screenshot:ok", "browser_pointer:ok", "browser_type:ok", "browser_press:ok", "browser_zoom:ok", "browser_wait:ok", "browser_scroll:ok", "browser_pointer:error"]);
    expect(completed.at(-1).errorCode).toBe("invalid_params"); // a drag without a destination never reaches the host
    expect(JSON.stringify(events)).not.toContain(PNG_BASE64);
    await host.client.close();
    await engine.stop();
    const db = new Database(engine.paths.databasePath, { readonly: true });
    try {
      const results = db.query("SELECT payload FROM conversation_items WHERE session_id = ?1 AND kind = 'tool_result' ORDER BY ordinal").all(session.id).map((row) => JSON.parse(row.payload));
      expect(results[0].images).toEqual([{ artifactId: expect.stringMatching(/^art/), mimeType: "image/png", width: 1, height: 1, bytes: 70 }]);
      expect(results[4].images).toHaveLength(1); // zoom
      expect(results[1].images).toBeUndefined();
      expect(JSON.stringify(results)).not.toContain(PNG_BASE64);
    } finally { db.close(); }
  });

  test("without an attached host, browser tools are not declared and calls are denied", async () => {
    const script = [{ toolCalls: [{ name: "browser_snapshot", arguments: {} }] }, { text: ["no browser\n"] }];
    const { events, run } = await setup({ script, withHost: false });
    expect(run.state).toBe("completed");
    const result = events.find((e) => e.type === "tool.completed").payload;
    expect(result.status).toBe("denied");
    expect(result.errorCode).toBe("permission_denied");
  });

  test("losing the host mid-operation pauses the run with browser_host_unavailable", async () => {
    const script = [{ toolCalls: [{ name: "browser_snapshot", arguments: {} }] }, { text: ["unreachable\n"] }];
    const { events, run } = await setup({ script, behaviour: "vanish" });
    expect(run.state).toBe("paused");
    expect(run.pauseReason).toBe("browser_host_unavailable");
    const result = events.find((e) => e.type === "tool.completed").payload;
    expect(result.errorCode).toBe("browser_host_unavailable");
    expect(events.some((e) => e.type === "run.state" && e.payload.state === "paused")).toBe(true);
  });

  test("stale references and unknown references become structured errors, not crashes", async () => {
    const script = [{ toolCalls: [{ name: "browser_snapshot", arguments: {} }, { name: "browser_click", arguments: { ref: "e9" } }] }, { text: ["handled\n"] }];
    const { run, events } = await setup({ script });
    expect(run.state).toBe("completed");
    const click = events.filter((e) => e.type === "tool.completed").map((e) => e.payload).find((r) => r.name === "browser_click");
    expect(click.status).toBe("error");
    expect(click.errorCode).toBe("unavailable");
  });
});
