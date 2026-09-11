import { expect, test } from "bun:test";
import { SessionProjection } from "@jolo/client/projection";
import { deleteSession, getSession, listSessions, parseSessionCommand, restoreSession } from "../src/sessions.js";
import { sessionLoader } from "../src/tui/session-loader.js";

test("session commands are local and reject ambiguous deletion arguments", () => {
  expect(parseSessionCommand(" /sessions ")).toEqual({ action: "list", sessionId: null });
  expect(parseSessionCommand("/session restore ses_saved")).toEqual({ action: "restore", sessionId: "ses_saved" });
  expect(parseSessionCommand("/session delete")).toEqual({ action: "delete", sessionId: null });
  for (const text of ["/session list extra", "/session delete one two", "/session unknown"]) expect(parseSessionCommand(text).error).toBeTruthy();
  for (const text of ["explain /session", "/session.js"]) expect(parseSessionCommand(text)).toBeNull();
});

test("listing combines recent open and archived sessions in activity order", async () => {
  const calls = [];
  const client = { call: async (method, params) => {
    calls.push([method, params]);
    return { sessions: [{ id: params.state === "archived" ? "old" : "new", updatedAt: params.state === "archived" ? "2026-09-01" : "2026-09-08" }] };
  } };
  expect((await listSessions(client, "project")).map((session) => session.id)).toEqual(["new", "old"]);
  expect(calls).toEqual([["session.list", { projectId: "project" }], ["session.list", { projectId: "project", state: "archived" }]]);
  calls.length = 0;
  expect(await listSessions(client, undefined, false)).toHaveLength(1);
  expect(calls).toEqual([["session.list", {}]]);
});

test("restore unarchives by revision; cross-project selections fail before mutation", async () => {
  const saved = { id: "saved", projectId: "project", state: "archived", revision: 4 };
  const calls = [];
  const client = { call: async (method, params) => {
    calls.push([method, params]);
    return { session: method === "session.archive" ? { ...saved, state: "open", revision: 5 } : saved };
  } };
  expect((await getSession(client, "saved", "project")).id).toBe("saved");
  expect((await restoreSession(client, "saved", "project")).state).toBe("open");
  expect(calls.at(-1)).toEqual(["session.archive", { sessionId: "saved", expectedRevision: 4, archived: false }]);
  calls.length = 0;
  await expect(restoreSession(client, "saved", "another-project")).rejects.toThrow("another project");
  expect(calls).toEqual([["session.page", { sessionId: "saved" }]]);
  await deleteSession(client, saved);
  expect(calls.at(-1)).toEqual(["session.delete", { sessionId: "saved", expectedRevision: 4 }]);
});

const stateEvent = (seq, state) => ({ eventSeq: String(seq), type: "run.state", runId: "run", sessionId: "saved", at: "2026-09-08", payload: { state, revision: seq } });
const page = (seq, state = "running") => ({ cursor: String(seq), messages: [], runs: [{ id: "run", state, revision: seq }] });

test("restoring an active session cannot rewind live events with an older snapshot", async () => {
  /** @type {(page: any) => void} */
  let resolve;
  // These pages carry no messages, so nothing is ever filled and the reader is never called.
  const projection = new SessionProjection({ readArtifact: async () => /** @type {{ text: string, bytes: number, eof: boolean }} */ ({ bytes: 0 }) });
  const loader = sessionLoader({ client: { call: () => new Promise((done) => { resolve = done; }) }, sessionId: "saved", projection, onPage: () => {}, onError: (error) => { throw error; } });
  const loaded = loader.load();
  loader.event(stateEvent(9, "queued")); // Already covered by the snapshot cursor.
  loader.event(stateEvent(11, "completed"));
  resolve(page(10)); await loaded;
  expect(projection.runs.get("run").state).toBe("completed");
  loader.event(stateEvent(12, "cancelled"));
  expect(projection.runs.get("run").state).toBe("cancelled");
  loader.dispose(); loader.event(stateEvent(13, "running"));
  expect(projection.runs.get("run").state).toBe("cancelled");
});

test("restoration refreshes on event-buffer overflow and ignores a late response after closing", async () => {
  const resolves = [];
  const pages = [];
  const projection = new SessionProjection({ readArtifact: async () => /** @type {{ text: string, bytes: number, eof: boolean }} */ ({ bytes: 0 }) });
  const loader = sessionLoader({ client: { call: () => new Promise((done) => { resolves.push(done); }) }, sessionId: "saved", projection, maxPending: 1, onPage: (value) => pages.push(value), onError: (error) => { throw error; } });
  const loaded = loader.load();
  loader.event(stateEvent(11, "running")); loader.event(stateEvent(12, "completed"));
  resolves[0](page(10)); await Promise.resolve();
  expect(resolves).toHaveLength(2);
  resolves[1](page(12, "completed")); await loaded;
  expect(pages).toHaveLength(1);
  expect(projection.runs.get("run").state).toBe("completed");
  const again = loader.load(); loader.dispose(); resolves[2](page(13, "running")); await again;
  expect(pages).toHaveLength(1);
});
