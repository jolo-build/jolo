import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { startEngine, tempHome, waitFor, removeHome } from "./helpers.js";

const engines = [];
const homes = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
  for (const dir of homes.splice(0)) removeHome(dir);
});

// 1x1 transparent PNG
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** A scripted browser host speaking the same socket protocol as the Electron main process. */
async function scriptedHost(engine, workspaceId, behaviour) {
  const client = await engine.connect({ clientKind: "desktop" });
  const received = [];
  let navigationRevision = 1;
  client.onNotification("browser.execute", async (params) => {
    received.push(params);
    const reply = (body) => client.call("browser.result", { invocationId: params.invocationId, ...body });
    if (behaviour === "vanish") { await client.close(); return; }
    switch (params.operation) {
      case "navigate": navigationRevision += 1; return reply({ status: "ok", result: { url: params.arguments.url, title: "Fixture", navigationRevision }, navigationRevision });
      case "snapshot": return reply({ status: "ok", result: { snapshotId: `snap_${navigationRevision}`, navigationRevision, truncated: false, nodes: [{ ref: "e1", role: "RootWebArea", name: "Fixture" }, { ref: "e2", parentRef: "e1", role: "button", name: "Click" }] } });
      case "click": return reply({ status: params.arguments.ref === "e2" ? "ok" : "error", ...(params.arguments.ref === "e2" ? { result: { ref: "e2", x: 10, y: 10, navigationRevision } } : { error: { code: "unknown_reference", message: `unknown reference ${params.arguments.ref}` } }) });
      case "screenshot": return reply({ status: "ok", result: { url: "http://fixture/", navigationRevision }, screenshot: { base64: PNG_BASE64, width: 1, height: 1, mimeType: "image/png" } });
      case "network": return reply({ status: "ok", result: { navigationRevision, url: "http://fixture/", entries: [{ method: "GET", url: "http://fixture/", status: 200, type: "Document", size: 120 }], truncated: false } });
      default: return reply({ status: "error", error: { code: "unsupported", message: params.operation } });
    }
  });
  const { capabilityId } = await client.call("browser.register", { workspaceId, tabId: "tab_1", navigationRevision, url: "about:blank", title: "", operations: ["navigate", "snapshot", "click", "type", "screenshot", "network"] });
  return { client, received, capabilityId };
}

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
  return { client, host, events, run: snapshot.run, messages: snapshot.messages, read: async (m, encoding = "utf8") => client.call("artifact.read", { artifactId: m.artifactId, encoding }) };
}

describe("agent browser control through the engine broker", () => {
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
