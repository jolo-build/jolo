import { afterEach, describe, expect, test } from "bun:test";
import net from "node:net";
import { existsSync } from "node:fs";
import { compareSeq, encodeFrame, PROTOCOL_VERSION } from "@jolo/protocol";
import { connect } from "@jolo/client";
import { startEngine, tempHome, waitFor, sleep, exitWithin, openSession, TERMINAL, ENGINE_ENTRY, removeHome } from "./helpers.js";

const engines = [];
const homes = [];
const newHome = () => { const dir = tempHome(); homes.push(dir); return dir; };
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
  for (const dir of homes.splice(0)) removeHome(dir);
});

describe("engine lifecycle", () => {
  test("automatic reload preserves active work and terminals, then exits when idle", async () => {
    const home = newHome();
    const engine = await startEngine({ home, fakeSteps: 10, fakeDelayMs: 30 });
    engines.push(engine);
    const client = await engine.connect({ clientKind: 'desktop' });
    const { session } = await openSession(client, home);
    const { run } = await client.call('run.start', { sessionId: session.id, requestId: 'reload', prompt: 'finish first' });
    await expect(client.call('engine.reload', {})).rejects.toMatchObject({ code: 'conflict' });
    await waitFor(async () => (await client.call('run.snapshot', { runId: run.id })).run.state === 'completed');
    const { terminal } = await client.call('terminal.open', { workspaceId: session.workspaceId });
    await expect(client.call('engine.reload', {})).rejects.toMatchObject({ code: 'conflict' });
    await client.call('terminal.close', { terminalId: terminal.terminalId });
    expect(await client.call('engine.reload', {})).toEqual({ stopping: true });
    expect(await exitWithin(engine.child, 5000)).toBe(0);
  });

  test("accepted work survives client disconnects, replays from a cursor, and the engine exits idle", async () => {
    const home = newHome();
    const engine = await startEngine({ home, idleMs: 700, fakeSteps: 15, fakeDelayMs: 40 });
    engines.push(engine);
    const a = await engine.connect();
    const b = await engine.connect();
    expect(a.hello.protocol.major).toBe(PROTOCOL_VERSION.major);

    const { session, cursor } = await openSession(a, home);
    const seenA = [];
    await a.subscribe({ after: cursor, sessionId: session.id }, { onEvent: (event) => seenA.push(event) });
    const { run, deduplicated } = await a.call("run.start", { sessionId: session.id, requestId: "req_1", prompt: "hello", expectedSessionRevision: session.revision });
    expect(deduplicated).toBe(false);
    expect(run.state).toBe("queued");

    const again = await b.call("run.start", { sessionId: session.id, requestId: "req_1", prompt: "hello" });
    expect(again.deduplicated).toBe(true);
    expect(again.run.id).toBe(run.id);

    await expect(b.call("run.start", { sessionId: session.id, requestId: "req_2", prompt: "stale", expectedSessionRevision: 0 })).rejects.toMatchObject({ code: "conflict" });

    await waitFor(() => seenA.some((e) => e.type === "message.started"), { label: "message started" });
    const cursorBeforeDisconnect = a.lastSeq;
    await a.close();
    await b.close();
    await sleep(150); // no clients attached; the run must continue

    const c = await engine.connect();
    const during = await c.call("run.snapshot", { runId: run.id });
    expect(TERMINAL).not.toContain(during.run.state);
    const replayed = [];
    const subscription = await c.subscribe({ after: cursorBeforeDisconnect, sessionId: session.id }, { onEvent: (event) => replayed.push(event) });
    expect(compareSeq(subscription.cursor, cursorBeforeDisconnect) >= 0).toBe(true);
    await waitFor(() => replayed.some((e) => e.type === "run.state" && e.payload.state === "completed"), { label: "run completed" });
    expect(replayed.every((e) => compareSeq(e.eventSeq, cursorBeforeDisconnect) > 0)).toBe(true);
    const seqs = replayed.map((e) => BigInt(e.eventSeq));
    expect(seqs.every((seq, i) => i === 0 || seq > seqs[i - 1])).toBe(true);

    const final = await c.call("run.snapshot", { runId: run.id });
    expect(final.run.state).toBe("completed");
    // How full the window was is worked out to decide when to compact, and kept so a client can show it (§7.2).
    expect(final.run.usage.contextWindow).toBeGreaterThan(0);
    expect(final.run.usage.contextUsed).toBeGreaterThan(0);
    expect(final.run.usage.contextUsed).toBeLessThan(final.run.usage.contextWindow);
    expect(final.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    const message = final.messages.find((m) => m.role === "assistant");
    expect(message.status).toBe("complete");
    expect(message.kind).toBe("text");
    const text = await c.call("artifact.read", { artifactId: message.artifactId });
    expect(text.text.startsWith("step 0\n")).toBe(true);
    expect(text.text).toContain("done: hello");
    expect(text.committedBytes).toBe(message.committedBytes);
    expect(text.eof).toBe(true);
    await c.close();

    expect(await exitWithin(engine.child, 5000)).toBe(0);
    expect(existsSync(engine.paths.socketPath)).toBe(false);
    expect(existsSync(engine.paths.metadataPath)).toBe(false);
    expect(existsSync(engine.paths.tokenPath)).toBe(false);
  });

  test("cancellation interrupts a streaming run and finalizes its message", async () => {
    const home = newHome();
    const engine = await startEngine({ home, fakeSteps: 200, fakeDelayMs: 20 });
    engines.push(engine);
    const client = await engine.connect();
    const { session, cursor } = await openSession(client, home);
    const events = [];
    await client.subscribe({ after: cursor, sessionId: session.id }, { onEvent: (e) => events.push(e) });
    const { run } = await client.call("run.start", { sessionId: session.id, requestId: "req_c", prompt: "long" });
    await waitFor(() => events.some((e) => e.type === "message.committed"), { label: "first commit" });
    const cancelling = await client.call("run.cancel", { runId: run.id });
    expect(cancelling.run.state).toBe("cancelling");
    await waitFor(() => events.some((e) => e.type === "run.state" && e.payload.state === "cancelled"), { label: "cancelled" });
    const snapshot = await client.call("run.snapshot", { runId: run.id });
    const assistant = snapshot.messages.find((m) => m.role === "assistant");
    expect(assistant.status).toBe("interrupted");
    expect(assistant.committedBytes).toBeGreaterThan(0);
    await expect(client.call("run.cancel", { runId: run.id })).rejects.toMatchObject({ code: "conflict" });
    await client.close();
  });

  test("engine.stop refuses while work is active unless cancelActive is set", async () => {
    const home = newHome();
    const engine = await startEngine({ home, fakeSteps: 100, fakeDelayMs: 20 });
    engines.push(engine);
    const client = await engine.connect();
    const { session } = await openSession(client, home);
    await client.call("run.start", { sessionId: session.id, requestId: "req_s", prompt: "x" });
    await expect(client.call("engine.stop", {})).rejects.toMatchObject({ code: "conflict" });
    const status = await client.call("engine.status", {});
    expect(status.activeRuns + status.queuedRuns).toBeGreaterThan(0);
    expect(await client.call("engine.stop", { cancelActive: true })).toEqual({ stopping: true });
    expect(await exitWithin(engine.child, 5000)).toBe(0);
  });
});

describe("authentication and framing", () => {
  test("wrong token, unauthenticated calls, and oversized frames are rejected", async () => {
    const home = newHome();
    const engine = await startEngine({ home });
    engines.push(engine);
    await expect(connect({ socketPath: engine.paths.socketPath, token: "0".repeat(64), clientKind: "test" })).rejects.toMatchObject({ code: "unauthenticated" });

    const raw = net.createConnection(engine.paths.socketPath);
    await new Promise((resolve) => raw.once("connect", resolve));
    const reply = new Promise((resolve) => raw.once("data", (chunk) => resolve(JSON.parse(chunk.subarray(4).toString()))));
    raw.write(encodeFrame({ jsonrpc: "2.0", id: "x:1", method: "engine.status", params: {} }));
    expect((await reply).error.data.code).toBe("unauthenticated");
    const closed = new Promise((resolve) => raw.once("close", resolve));
    const header = Buffer.alloc(4);
    header.writeUInt32BE(300 * 1024, 0);
    raw.write(header);
    await closed;

    const ok = await engine.connect();
    expect((await ok.call("engine.status", {})).clients).toBe(1);
    await ok.close();
  });

  test("client limit is enforced without dropping accepted clients", async () => {
    const home = newHome();
    const engine = await startEngine({ home });
    engines.push(engine);
    const clients = [];
    for (let i = 0; i < 4; i += 1) clients.push(await engine.connect());
    await expect(engine.connect()).rejects.toMatchObject({ code: "limit_exceeded" });
    const control = await engine.connect({ clientKind: "control" });
    expect((await control.call("engine.status", {})).clients).toBe(5);
    for (const client of [...clients, control]) await client.close();
  });
});

describe("ownership and recovery", () => {
  test("a second engine for the same profile exits with the ownership code", async () => {
    const home = newHome();
    const engine = await startEngine({ home });
    engines.push(engine);
    const contender = Bun.spawn([process.execPath, ENGINE_ENTRY, "serve", "--home", home, "--profile", "t"], { stdout: "ignore", stderr: "pipe" });
    expect(await contender.exited).toBe(75);
    const client = await engine.connect();
    expect((await client.call("engine.status", {})).engineBootId).toBe(engine.endpoint().metadata.engineBootId);
    await client.close();
  });

  test("runs interrupted by a crash are reconciled on the next boot", async () => {
    const home = newHome();
    const first = await startEngine({ home, fakeSteps: 300, fakeDelayMs: 20 });
    const client = await first.connect();
    const { session, cursor } = await openSession(client, home);
    const events = [];
    await client.subscribe({ after: cursor, sessionId: session.id }, { onEvent: (e) => events.push(e) });
    const { run } = await client.call("run.start", { sessionId: session.id, requestId: "req_k", prompt: "crash" });
    const assistantIds = () => new Set(events.filter((e) => e.type === "message.started" && e.payload.role === "assistant").map((e) => e.payload.messageId));
    await waitFor(() => events.some((e) => e.type === "message.committed" && assistantIds().has(e.payload.messageId)), { label: "assistant commit before crash" });
    first.child.kill("SIGKILL");
    await first.child.exited;
    await sleep(50);

    const second = await startEngine({ home, fakeSteps: 5, fakeDelayMs: 5 });
    engines.push(second);
    const c2 = await second.connect();
    const snapshot = await c2.call("run.snapshot", { runId: run.id });
    expect(snapshot.run.state).toBe("interrupted");
    const assistant = snapshot.messages.find((m) => m.role === "assistant");
    expect(assistant.status).toBe("interrupted");
    expect(assistant.committedBytes).toBeGreaterThan(0);
    const replay = [];
    await c2.subscribe({ after: cursor, sessionId: session.id }, { onEvent: (e) => replay.push(e) });
    expect(replay.some((e) => e.type === "run.state" && e.payload.state === "interrupted")).toBe(true);
    const text = await c2.call("artifact.read", { artifactId: assistant.artifactId });
    expect(text.committedBytes).toBe(assistant.committedBytes);
    await c2.close();
  });
});
