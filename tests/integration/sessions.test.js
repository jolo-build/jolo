import { expect, test } from "bun:test";
import { openSession, removeHome, startEngine, tempHome, waitFor, TERMINAL } from "./helpers.js";

test("task names, archives, and history removal persist across engine restarts", async () => {
  const home = tempHome();
  let engine;
  let client;
  try {
    engine = await startEngine({ home });
    client = await engine.connect();
    const { project, session, cursor } = await openSession(client, home);
    const events = [];
    await client.subscribe({ after: cursor }, { onEvent: (event) => events.push(event) });
    let current = (await client.call("session.rename", { sessionId: session.id, expectedRevision: session.revision, title: "  Repository review  " })).session;
    expect(current.title).toBe("Repository review");
    await expect(client.call("session.rename", { sessionId: session.id, expectedRevision: session.revision, title: "stale" })).rejects.toMatchObject({ code: "conflict" });
    await expect(client.call("session.rename", { sessionId: session.id, expectedRevision: current.revision, title: "   " })).rejects.toMatchObject({ code: "invalid_params" });
    current = (await client.call("session.archive", { sessionId: session.id, expectedRevision: current.revision, archived: true })).session;
    expect((await client.call("session.list", { projectId: project.projectId })).sessions).toHaveLength(0);
    expect((await client.call("session.page", { sessionId: session.id })).session.state).toBe("archived");
    await expect(client.call("run.start", { sessionId: session.id, requestId: "req_archived", prompt: "hello" })).rejects.toMatchObject({ code: "conflict" });
    await waitFor(() => events.some((event) => event.type === "session.updated" && event.payload.session.state === "archived"));
    await client.close();
    await engine.stop();
    engine = await startEngine({ home });
    client = await engine.connect();
    const archived = (await client.call("session.list", { projectId: project.projectId, state: "archived" })).sessions;
    expect(archived).toHaveLength(1);
    expect(archived[0].title).toBe("Repository review");
    current = (await client.call("session.archive", { sessionId: session.id, expectedRevision: archived[0].revision, archived: false })).session;
    expect((await client.call("session.list", { projectId: project.projectId })).sessions[0].id).toBe(session.id);
    await client.call("session.delete", { sessionId: session.id, expectedRevision: current.revision });
    await expect(client.call("session.page", { sessionId: session.id })).rejects.toMatchObject({ code: "not_found" });
    await expect(client.call("run.start", { sessionId: session.id, requestId: "req_deleted", prompt: "hello" })).rejects.toMatchObject({ code: "not_found" });
    await client.close();
    await engine.stop();
    engine = await startEngine({ home });
    client = await engine.connect();
    expect((await client.call("session.list", { projectId: project.projectId })).sessions).toHaveLength(0);
    expect((await client.call("session.list", { projectId: project.projectId, state: "archived" })).sessions).toHaveLength(0);
  } finally {
    await client?.close().catch(() => {});
    await engine?.stop();
    removeHome(home);
  }
}, 15_000);

test("archive and delete reject unfinished runs while rename remains available", async () => {
  const home = tempHome();
  const engine = await startEngine({ home, fakeSteps: 100, fakeDelayMs: 50 });
  const client = await engine.connect();
  try {
    const { session } = await openSession(client, home);
    const { run } = await client.call("run.start", { sessionId: session.id, requestId: "req_busy", prompt: "long task" });
    let current = (await client.call("session.page", { sessionId: session.id })).session;
    for (const action of ["archive", "delete"]) {
      await expect(client.call(`session.${action}`, { sessionId: session.id, expectedRevision: current.revision, ...(action === "archive" ? { archived: true } : {}) })).rejects.toMatchObject({ code: "conflict" });
    }
    current = (await client.call("session.rename", { sessionId: session.id, expectedRevision: current.revision, title: "Running task" })).session;
    expect(current.title).toBe("Running task");
    await client.call("run.cancel", { runId: run.id });
    await waitFor(async () => TERMINAL.includes((await client.call("run.snapshot", { runId: run.id })).run.state));
    current = (await client.call("session.page", { sessionId: session.id })).session;
    await client.call("session.delete", { sessionId: session.id, expectedRevision: current.revision });
    await expect(client.call("run.resume", { runId: run.id })).rejects.toMatchObject({ code: "conflict" });
  } finally {
    await client.close();
    await engine.stop();
    removeHome(home);
  }
}, 10_000);
