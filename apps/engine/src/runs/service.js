// Run state machine, scheduler, and executor context.
import { EventEmitter } from "node:events";
import { statSync } from "node:fs";
import { createHash } from "node:crypto";
import { ProtocolError, TERMINAL_RUN_STATES, LIMITS } from "@jolo/protocol";
import { buildRunNote } from "./note.js";
import { validateAttachments } from '../attachments.js';

const COMMIT_INTERVAL_MS = 250;
const COMMIT_BYTES = 32 * 1024;

export class RunService {
  /**
   * @param {{ storage: import("../storage/index.js").Storage, executor: { name: string, execute: (ctx: any) => Promise<{ outcome: string }> }, lifetime: any, log: any, maxActive?: number }} options
   */
  constructor(options) {
    this.storage = options.storage;
    this.executor = options.executor;
    this.captureProvider = options.captureProvider;
    this.lifetime = options.lifetime;
    this.log = options.log;
    this.maxActive = options.maxActive ?? 2;
    this.maxQueued = options.maxQueued ?? 100;
    this.shutdownMs = options.shutdownMs ?? 5000;
    this.workspaceBusy = options.workspaceBusy ?? (() => false);
    this.previews = new EventEmitter();
    /** Runs that have just stopped, for services that started them: emits the durable run record. */
    this.settled = new EventEmitter();
    this.settled.setMaxListeners(20);
    /** @type {Map<string, { controller: AbortController, promise: Promise<void> }>} */
    this.active = new Map();
    /** @type {string[]} */
    this.queue = [];
    this.stopping = false;
  }

  /** Record the "where was I" note next to the run; a failure here is logged, never fatal. */
  writeNote(run, state, details = {}) {
    try {
      this.storage.setRunNote(run.id, buildRunNote({ storage: this.storage, run, state, ...details }));
    } catch (error) {
      this.log.warn("run note not written", { runId: run.id, error: String(error?.message ?? error) });
    }
  }

  /** Mark work left over from a previous boot as interrupted; never resume it silently. */
  reconcile() {
    const nonTerminal = this.storage.listRunsByState(["queued", "preparing", "model", "tools", "awaiting_permission", "cancelling"]);
    for (const run of nonTerminal) {
      this.storage.transaction(() => {
        const updated = this.storage.updateRunState(run.id, "interrupted", { failure: "engine restarted before completion" });
        this.storage.expirePendingPermissions(run.id);
        this.storage.expireRunGrants(run.id);
        this.writeNote(updated, "interrupted", { failure: updated.failure });
        this.storage.appendEvent({ sessionId: run.sessionId, runId: run.id, type: "run.state", payload: { state: updated.state, revision: updated.revision, failure: updated.failure } });
      });
    }
    for (const message of this.storage.listStreamingMessages()) {
      this.storage.transaction(() => {
        this.storage.finishMessage(message.id, "interrupted", message.committedBytes);
        this.storage.appendEvent({ sessionId: message.sessionId, runId: message.runId, type: "message.finished", payload: { messageId: message.id, committedBytes: message.committedBytes, status: "interrupted" } });
      });
    }
    return nonTerminal.length;
  }

  start({ sessionId, requestId, prompt, expectedSessionRevision, execution = null, attachments = [], taskReferences = [] }) {
    const result = this.storage.transaction(() => {
      const session = this.storage.getSession(sessionId);
      if (!session) throw new ProtocolError("not_found", `unknown session ${sessionId}`);
      if (session.state === "archived") throw new ProtocolError("conflict", "restore this task before starting a run");
      this.checkWorkspace(session);
      const existing = this.storage.findRunByRequest(sessionId, requestId);
      if (existing) return { run: existing, deduplicated: true };
      this.checkAdmission();
      if (expectedSessionRevision !== undefined && expectedSessionRevision !== session.revision) {
        throw new ProtocolError("conflict", `session revision is ${session.revision}, expected ${expectedSessionRevision}`, { revision: session.revision });
      }
      const images = validateAttachments(this.storage, sessionId, attachments);
      const run = this.storage.insertRun({ sessionId, requestId, prompt, execution: execution ?? null, attachments: images, taskReferences });
      const providerConfig = this.captureProvider?.(session, execution);
      if (providerConfig) this.storage.setRunProviderConfig(run.id, providerConfig);
      this.storage.bumpSessionRevision(sessionId);
      this.storage.appendEvent({ sessionId, runId: run.id, type: "run.state", payload: { state: run.state, revision: run.revision, agentId: run.execution?.agentId ?? null, promptPreview: prompt.slice(0, 500), ...(images.length ? { attachments: images } : {}), ...(run.taskReferences?.length ? { taskReferences: run.taskReferences } : {}) } });
      return { run, deduplicated: false };
    });
    if (!result.deduplicated) {
      this.storage.afterCommit(() => this.enqueue(result.run.id));
    }
    return result;
  }

  cancel({ runId, expectedRevision }) {
    const outcome = this.storage.transaction(() => {
      const run = this.storage.getRun(runId);
      if (!run) throw new ProtocolError("not_found", `unknown run ${runId}`);
      if (expectedRevision !== undefined && expectedRevision !== run.revision) throw new ProtocolError("conflict", `run revision is ${run.revision}, expected ${expectedRevision}`, { revision: run.revision });
      if (TERMINAL_RUN_STATES.includes(run.state)) throw new ProtocolError("conflict", `run is already ${run.state}`, { state: run.state });
      if (run.state === "cancelling") return { run, already: true };
      if (run.state === "queued" || run.state === "paused") {
        const updated = this.storage.updateRunState(runId, "cancelled");
        this.storage.expirePendingPermissions(runId);
        this.storage.expireRunGrants(runId);
        this.writeNote(updated, "cancelled");
        this.storage.appendEvent({ sessionId: run.sessionId, runId, type: "run.state", payload: { state: updated.state, revision: updated.revision } });
        return { run: updated, queued: run.state === "queued", direct: true };
      }
      const updated = this.storage.updateRunState(runId, "cancelling");
      this.storage.appendEvent({ sessionId: run.sessionId, runId, type: "run.state", payload: { state: updated.state, revision: updated.revision } });
      return { run: updated };
    });
    if (outcome.queued) {
      this.queue = this.queue.filter((id) => id !== runId);
      this.lifetime.workFinished();
    } else if (outcome.direct) {
      /* paused: no executor to unwind */
    } else if (!outcome.already) {
      this.active.get(runId)?.controller.abort();
    }
    if (outcome.direct) this.notifySettled(outcome.run);
    return outcome.run;
  }

  checkAdmission() {
    if (this.stopping) throw new ProtocolError("unavailable", "engine is stopping");
    if (this.queue.length >= this.maxQueued) throw new ProtocolError("limit_exceeded", "run queue is full; wait for a task to finish");
  }

  /** Send a queued follow-up next, interrupting only this conversation's active turn. */
  sendNow({ runId }) {
    const run = this.storage.getRun(runId);
    if (!run) throw new ProtocolError("not_found", "unknown queued message");
    // A fast turn may have started or completed between two Enter presses.
    if (run.state !== "queued") return run;
    const index = this.queue.indexOf(runId);
    if (index < 0 || this.stopping) throw new ProtocolError("unavailable", "queued message is not available");
    this.queue.splice(index, 1);
    this.queue.unshift(runId);
    for (const activeId of this.active.keys()) {
      const active = this.storage.getRun(activeId);
      if (active?.sessionId === run.sessionId && !TERMINAL_RUN_STATES.includes(active.state)) this.cancel({ runId: activeId });
    }
    this.pump();
    return this.storage.getRun(runId);
  }

  checkWorkspace(session) {
    if (this.workspaceBusy(session.workspaceId)) throw new ProtocolError("conflict", "workspace removal is in progress");
    const workspace = this.storage.getWorkspace(session.workspaceId);
    let available = false;
    try { available = workspace && !workspace.removedAt && statSync(workspace.path).isDirectory(); } catch { /* report unavailable below */ }
    if (!available) throw new ProtocolError("conflict", "this task's workspace is unavailable; restore its directory or choose another workspace");
  }

  enqueue(runId) {
    this.queue.push(runId);
    this.lifetime.workStarted();
    queueMicrotask(() => this.pump());
  }

  notifySettled(run) {
    for (const listener of this.settled.rawListeners("run")) {
      try { listener.call(this.settled, run); }
      catch (error) { this.log.error("run completion listener failed", { runId: run.id, error: String(error) }); }
    }
  }

  snapshot(runId) {
    return this.storage.transaction(() => {
      const run = this.storage.getRun(runId);
      if (!run) throw new ProtocolError("not_found", `unknown run ${runId}`);
      return { run, messages: this.storage.listMessagesForRun(runId), cursor: this.storage.maxSeq() };
    });
  }

  get isStopping() { return this.stopping; }

  get activeCount() {
    return this.active.size;
  }

  get queuedCount() {
    return this.queue.length;
  }

  pump() {
    while (!this.stopping && this.active.size < this.maxActive && this.queue.length > 0) {
      const workspacePath = runId => {
        const run = this.storage.getRun(runId);
        const session = run && this.storage.getSession(run.sessionId);
        return session && this.storage.getWorkspace(session.workspaceId)?.path;
      };
      const occupied = [...this.active.keys()].map(workspacePath).filter(Boolean);
      const index = this.queue.findIndex(id => {
        const candidate = workspacePath(id);
        return !candidate || !occupied.some(root => candidate === root || candidate.startsWith(root + "/") || root.startsWith(candidate + "/"));
      });
      if (index < 0) break;
      const [runId] = this.queue.splice(index, 1);
      const controller = new AbortController();
      const promise = Promise.resolve().then(() => this.execute(runId, controller.signal)).catch((error) => {
        this.log.error("run executor crashed", { runId, error: String(error?.message ?? error) });
        try { this.finish(runId, "failed", { failure: String(error?.message ?? error).slice(0, 500) }); }
        catch (failure) { this.log.error("could not persist failed run", { runId, error: String(failure) }); }
      }).finally(() => {
        this.active.delete(runId);
        this.lifetime.workFinished();
        this.pump();
      });
      this.active.set(runId, { controller, promise });
    }
  }

  async execute(runId, signal) {
    let run = this.storage.transaction(() => {
      const current = this.storage.getRun(runId);
      if (!current || current.state !== "queued") return null;
      const updated = this.storage.updateRunState(runId, "preparing");
      this.storage.appendEvent({ sessionId: updated.sessionId, runId, type: "run.state", payload: { state: updated.state, revision: updated.revision } });
      return updated;
    });
    if (!run) return;
    const ctx = this.createContext(run, signal);
    const entry = this.active.get(runId);
    if (entry) entry.context = ctx;
    try {
      const outcome = await Promise.race([Promise.resolve().then(() => this.executor.execute(ctx)), ctx.failed]);
      ctx.flushAll();
      if (!signal.aborted && outcome?.outcome === "paused") {
        this.finish(runId, "paused", { pauseReason: outcome.pauseReason ?? "user", failure: outcome.detail ?? null, permissionId: outcome.permissionId ?? null });
        return;
      }
      const state = signal.aborted || outcome?.outcome === "cancelled" ? "cancelled" : outcome?.outcome === "failed" ? "failed" : "completed";
      this.finish(runId, state, { failure: outcome?.failure ?? null });
    } catch (error) {
      const cancelled = signal.aborted && !ctx.error;
      this.active.get(runId)?.controller.abort();
      this.finish(runId, cancelled ? "cancelled" : "failed", { failure: String(error?.message ?? error).slice(0, 500) });
    } finally { ctx.dispose(); }
  }

  finish(runId, state, { failure = null, pauseReason = null, permissionId = null } = {}) {
    const settled = this.storage.transaction(() => {
      const run = this.storage.getRun(runId);
      if (!run || TERMINAL_RUN_STATES.includes(run.state)) return null;
      const updated = this.storage.updateRunState(runId, state, { failure, pauseReason });
      if (TERMINAL_RUN_STATES.includes(state)) {
        this.storage.expirePendingPermissions(runId);
        this.storage.expireRunGrants(runId);
      }
      this.writeNote(updated, state, { failure, pauseReason, permissionId });
      this.storage.appendEvent({ sessionId: run.sessionId, runId, type: "run.state", payload: { state: updated.state, revision: updated.revision, pauseReason: updated.pauseReason, failure: updated.failure, permissionId } });
      return this.storage.getRun(runId); // read back, so a listener sees the note and usage written above
    });
    // Whoever started this run may have something to do now it has stopped. Told after the record is durable,
    // so a listener that reads the run back sees the state it is being told about.
    if (settled) this.storage.afterCommit(() => this.notifySettled(settled));
    return settled;
  }

  /** Continue a paused or interrupted run as a new attempt from its durable transcript (§6.2). */
  resume({ runId, expectedRevision }) {
    const run = this.storage.transaction(() => {
      const current = this.storage.getRun(runId);
      if (!current) throw new ProtocolError("not_found", `unknown run ${runId}`);
      const session = this.storage.getSession(current.sessionId);
      if (!session || session.state === "archived") throw new ProtocolError("conflict", "task is deleted or archived");
      if (expectedRevision !== undefined && expectedRevision !== current.revision) throw new ProtocolError("conflict", `run revision is ${current.revision}, expected ${expectedRevision}`, { revision: current.revision });
      if (!["paused", "interrupted"].includes(current.state)) throw new ProtocolError("conflict", `run is ${current.state}; only paused or interrupted runs resume`, { state: current.state });
      this.checkWorkspace(session);
      this.checkAdmission();
      const pending = this.storage.pendingPermissionForRun(runId);
      if (pending) throw new ProtocolError("conflict", "a permission request is still pending; resolve it first", { permissionId: pending.id });
      // A continuation is a new attempt on the record, not a second life for the one that stopped (§6.2).
      const updated = this.storage.updateRunState(runId, "queued", { newAttempt: true });
      this.storage.appendEvent({ sessionId: current.sessionId, runId, type: "run.state", payload: { state: updated.state, revision: updated.revision, attempt: updated.attempt } });
      return updated;
    });
    this.storage.afterCommit(() => this.enqueue(run.id));
    return run;
  }

  /** Bounded executor context: durable transitions, batched artifact commits, transient previews. */
  createContext(run, signal) {
    const storage = this.storage;
    const previews = this.previews;
    /** @type {Map<string, { writer: any, artifact: any, pending: Buffer[], pendingBytes: number, offset: number, timer: any, hash: import("node:crypto").Hash }>} */
    const streams = new Map();
    let disposed = false;
    let streamError = null;
    let rejectFailure;
    const failed = new Promise((_, reject) => { rejectFailure = reject; });
    failed.catch(() => {}); // may fail before execute starts racing it
    const assertOpen = () => { if (streamError) throw streamError; if (disposed) throw new Error("run context is closed"); };

    const flush = (messageId) => {
      assertOpen();
      const stream = streams.get(messageId);
      if (!stream || stream.pendingBytes === 0) return;
      const chunk = Buffer.concat(stream.pending, stream.pendingBytes);
      stream.pending = [];
      stream.pendingBytes = 0;
      if (stream.timer) { clearTimeout(stream.timer); stream.timer = null; }
      const committed = stream.writer.append(chunk);
      stream.writer.flush();
      stream.hash.update(chunk);
      storage.transaction(() => {
        storage.commitArtifactBytes(stream.artifact.id, committed);
        storage.commitMessageBytes(messageId, committed);
        storage.appendEvent({ sessionId: run.sessionId, runId: run.id, type: "message.committed", payload: { messageId, committedBytes: committed } });
      });
    };

    return {
      run: { ...run, taskReferences: storage.getRunTaskReferences?.(run.id) ?? [] },
      signal,
      failed,
      get error() { return streamError; },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        for (const [messageId, stream] of streams) {
          clearTimeout(stream.timer);
          try { stream.writer.close(); } catch (error) { this.log.warn("artifact writer close failed", { error: String(error) }); }
          try {
            const message = storage.getMessage(messageId);
            storage.transaction(() => {
              storage.finishMessage(messageId, "interrupted", message.committedBytes);
              storage.appendEvent({ sessionId: run.sessionId, runId: run.id, type: "message.finished", payload: { messageId, committedBytes: message.committedBytes, status: "interrupted" } });
            });
          } catch (error) { this.log.error("message recovery failed", { messageId, error: String(error) }); }
        }
        streams.clear();
      },
      transition: (state) => {
        assertOpen();
        const updated = storage.transaction(() => {
          const current = storage.getRun(run.id);
          if (!current || current.state === "cancelling" || TERMINAL_RUN_STATES.includes(current.state)) return current;
          const next = storage.updateRunState(run.id, state);
          storage.appendEvent({ sessionId: run.sessionId, runId: run.id, type: "run.state", payload: { state: next.state, revision: next.revision } });
          return next;
        });
        return updated;
      },
      startMessage: (role, kind = "text") => {
        assertOpen();
        let writer;
        let message;
        try { message = storage.transaction(() => {
          const artifact = storage.createArtifact({ sessionId: run.sessionId, kind: "message" });
          writer = storage.openArtifactWriter(artifact);
          const created = storage.insertMessage({ sessionId: run.sessionId, runId: run.id, role, kind, artifactId: artifact.id, ordinal: storage.nextMessageOrdinal(run.sessionId) });
          storage.appendEvent({ sessionId: run.sessionId, runId: run.id, type: "message.started", payload: { messageId: created.id, role, kind, artifactId: artifact.id, ordinal: created.ordinal } });
          return { message: created, artifact };
        }); } catch (error) { try { writer?.close(); } catch {} throw error; }
        streams.set(message.message.id, { writer, artifact: message.artifact, pending: [], pendingBytes: 0, offset: 0, timer: null, hash: createHash("sha256") });
        return message.message.id;
      },
      appendText: (messageId, text) => {
        assertOpen();
        const stream = streams.get(messageId);
        if (!stream) throw new Error(`unknown message stream ${messageId}`);
        const bytes = Buffer.from(text, "utf8");
        if (bytes.length > LIMITS.previewChunkBytes) throw new ProtocolError("limit_exceeded", "preview chunk exceeds limit");
        previews.emit("preview", { sessionId: run.sessionId, runId: run.id, messageId, byteOffset: stream.offset, text });
        stream.offset += bytes.length;
        stream.pending.push(bytes);
        stream.pendingBytes += bytes.length;
        if (stream.pendingBytes >= COMMIT_BYTES) flush(messageId);
        else if (!stream.timer) stream.timer = setTimeout(() => {
          try { flush(messageId); } catch (error) { streamError = error; rejectFailure(error); }
        }, COMMIT_INTERVAL_MS);
      },
      finishMessage: (messageId, status) => {
        flush(messageId);
        const stream = streams.get(messageId);
        if (!stream) return;
        const committed = stream.writer.close();
        storage.transaction(() => {
          storage.finalizeArtifact(stream.artifact.id, committed, stream.hash.digest("hex"));
          storage.finishMessage(messageId, status, committed);
          storage.appendEvent({ sessionId: run.sessionId, runId: run.id, type: "message.finished", payload: { messageId, committedBytes: committed, status } });
        });
        streams.delete(messageId);
      },
      flushAll: () => {
        for (const messageId of [...streams.keys()]) {
          flush(messageId);
          const stream = streams.get(messageId);
          const committed = stream.writer.close();
          storage.transaction(() => {
            storage.finishMessage(messageId, "interrupted", committed);
            storage.appendEvent({ sessionId: run.sessionId, runId: run.id, type: "message.finished", payload: { messageId, committedBytes: committed, status: "interrupted" } });
          });
          streams.delete(messageId);
        }
      },
    };
  }

  /** Cancel everything for shutdown and wait for executors to unwind. */
  async stopAll() {
    this.stopping = true;
    for (const runId of this.queue.splice(0)) {
      try { this.finish(runId, "interrupted", { failure: "engine stopped" }); }
      catch (error) { this.log.error("queued run shutdown failed", { runId, error: String(error) }); }
      finally { this.lifetime.workFinished(); }
    }
    const active = [...this.active.entries()];
    for (const [, entry] of active) entry.controller.abort();
    let timer;
    try {
      await Promise.race([
        Promise.allSettled(active.map(([, entry]) => entry.promise)),
        new Promise(resolve => { timer = setTimeout(resolve, this.shutdownMs); }),
      ]);
    } finally { clearTimeout(timer); }
    for (const [runId, entry] of active) {
      if (!this.active.has(runId)) continue;
      entry.context?.dispose();
      try { this.finish(runId, "interrupted", { failure: "executor did not stop before shutdown deadline" }); }
      catch (error) { this.log.error("active run shutdown failed", { runId, error: String(error) }); }
    }
  }
}
