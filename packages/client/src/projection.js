// Bounded run/session projection shared by desktop and CLI.
// Applies durable events and transient previews; fills gaps from committed artifacts on demand.

const DEFAULT_MAX_TEXT_BYTES = 2 * 1024 * 1024;

// Panes share one transport. Opening a saved chat must not send a whole page
// of artifact requests at once and exhaust the engine's pending-request limit.
const READ_CONCURRENCY = 4;
const reads = [];
let activeReads = 0;
function readBounded(operation) {
  return new Promise((resolve, reject) => {
    reads.push({ operation, resolve, reject });
    pumpReads();
  });
}
function pumpReads() {
  while (activeReads < READ_CONCURRENCY && reads.length) {
    const next = reads.shift();
    activeReads++;
    Promise.resolve().then(next.operation).then(next.resolve, next.reject).finally(() => {
      activeReads--;
      pumpReads();
    });
  }
}
const RETRYABLE_READ_ERRORS = new Set(["unavailable", "limit_exceeded", "ECONNRESET", "EPIPE", "ETIMEDOUT"]);

export class SessionProjection {
  /**
   * @param {{ readArtifact: (artifactId: string, offset: number, length: number) => Promise<{ text: string, bytes: number, eof: boolean }>, maxTextBytes?: number, onChange?: () => void }} options
   */
  constructor(options) {
    this.readArtifact = options.readArtifact;
    this.maxTextBytes = options.maxTextBytes ?? DEFAULT_MAX_TEXT_BYTES;
    this.onChange = options.onChange ?? (() => {});
    this.onText = options.onText ?? (() => {});
    this.onError = options.onError ?? (() => {});
    this.retainText = options.retainText ?? true;
    /** @type {Map<string, { id, runId, role, kind, artifactId, ordinal, text, renderedBytes, committedBytes, status }>} */
    this.messages = new Map();
    /** @type {Map<string, any>} */
    this.runs = new Map();
    /** @type {Map<string, { invocationId, callId, name, preview, status, durationMs, errorCode }>} */
    this.tools = new Map();
    this.textBytes = 0;
    this.pendingFills = new Map();
    this.messageSeq = new Map();
    this.runSeq = new Map();
    this.lastSeq = "0";
  }

  /** Seed from a snapshot or page; committed text is fetched lazily by the caller via fill(). */
  seed({ messages = [], runs = [], cursor }) {
    for (const message of messages) {
      if (cursor && BigInt(this.messageSeq.get(message.id) ?? "0") > BigInt(cursor)) continue;
      const existing = this.messages.get(message.id);
      this.messages.set(message.id, Object.assign(existing ?? { text: "", renderedBytes: 0 }, message));
      if (cursor) this.messageSeq.set(message.id, cursor);
    }
    // A stored run keeps its answerer under `execution`; live events carry it as `agentId`. Read as one.
    for (const run of runs) {
      if (cursor && BigInt(this.runSeq.get(run.id) ?? "0") > BigInt(cursor)) continue;
      this.runs.set(run.id, { ...run, agentId: run.agentId ?? run.execution?.agentId ?? null });
      if (cursor) this.runSeq.set(run.id, cursor);
    }
    if (cursor && BigInt(cursor) > BigInt(this.lastSeq)) this.lastSeq = cursor;
    this.onChange();
  }

  applyEvent(event) {
    if (BigInt(event.eventSeq) <= BigInt(this.lastSeq)) return;
    this.lastSeq = event.eventSeq;
    const p = event.payload;
    switch (event.type) {
      case "message.started":
        this.messages.set(p.messageId, { id: p.messageId, runId: event.runId, role: p.role, kind: p.kind ?? "text", artifactId: p.artifactId, ordinal: p.ordinal, text: "", renderedBytes: 0, committedBytes: 0, status: "streaming" });
        break;
      case "message.committed":
      case "message.finished": {
        const message = this.messages.get(p.messageId);
        if (!message) break;
        message.committedBytes = p.committedBytes;
        if (event.type === "message.finished") message.status = p.status;
        if (message.renderedBytes < p.committedBytes) void this.fill(message.id);
        break;
      }
      case "run.state": {
        const run = this.runs.get(event.runId) ?? { id: event.runId, sessionId: event.sessionId };
        // A run first seen live has no row to seed from; its own events carry the times clients show as elapsed.
        // agentId is carried on the run's first event: it says who was called in to answer this one turn (§4.3).
        this.runs.set(event.runId, { ...run, state: p.state, revision: p.revision, pauseReason: p.pauseReason ?? null, failure: p.failure ?? null, agentId: p.agentId ?? run.agentId ?? null, promptPreview: p.promptPreview ?? run.promptPreview, attachments: p.attachments ?? run.attachments ?? [], taskReferences: p.taskReferences ?? run.taskReferences ?? [], createdAt: run.createdAt ?? event.at, updatedAt: event.at });
        break;
      }
      case "run.usage": {
        const run = this.runs.get(event.runId) ?? { id: event.runId, sessionId: event.sessionId };
        this.runs.set(event.runId, { ...run, usage: p });
        break;
      }
      case "run.verification": {
        const run = this.runs.get(event.runId) ?? { id: event.runId, sessionId: event.sessionId };
        this.runs.set(event.runId, { ...run, verification: p });
        break;
      }
      case "files.changed": {
        const message = p.messageId ? this.messages.get(p.messageId) : null;
        if (message) { message.changes = [...(message.changes ?? []), ...p.changes]; message.diffArtifactId = p.diffArtifactId ?? message.diffArtifactId ?? null; }
        break;
      }
      case "tool.started":
        this.tools.set(p.invocationId, { invocationId: p.invocationId, runId: event.runId, callId: p.callId, name: p.name, preview: p.preview, status: "running" });
        break;
      case "tool.completed": {
        const tool = this.tools.get(p.invocationId) ?? { invocationId: p.invocationId, runId: event.runId, callId: p.callId, name: p.name, preview: p.name };
        this.tools.set(p.invocationId, { ...tool, status: p.status, durationMs: p.durationMs, errorCode: p.errorCode, resultArtifactId: p.resultArtifactId });
        break;
      }
      default:
        break;
    }
    if (p.messageId && this.messages.has(p.messageId)) this.messageSeq.set(p.messageId, event.eventSeq);
    if (event.type.startsWith("run.") && this.runs.has(event.runId)) this.runSeq.set(event.runId, event.eventSeq);
    this.onChange();
  }

  applyPreview(preview) {
    const message = this.messages.get(preview.messageId);
    if (!message) return;
    if (preview.byteOffset !== message.renderedBytes) return; // gap or duplicate; commits fill gaps
    this.append(message, preview.text);
    this.onChange();
  }

  append(message, text) {
    const bytes = byteLength(text);
    this.onText({ message, byteOffset: message.renderedBytes, text });
    if (this.retainText) { message.text += text; this.textBytes += bytes; }
    message.renderedBytes += bytes;
    this.evict();
  }

  /** Fetch committed bytes the projection has not rendered yet, in order, once per message at a time. */
  fill(messageId) {
    if (this.pendingFills.has(messageId)) return this.pendingFills.get(messageId);
    const task = (async () => {
      const initial = this.messages.get(messageId);
      if (initial?.loadError) { initial.loadError = null; this.onChange(); }
      for (;;) {
        const message = this.messages.get(messageId);
        if (!message || message.renderedBytes >= message.committedBytes) return;
        const offset = message.renderedBytes;
        const length = Math.min(64 * 1024, message.committedBytes - offset);
        let chunk;
        for (let attempt = 0; ; attempt++) {
          try {
            chunk = await readBounded(() => this.readArtifact(message.artifactId, offset, length));
            if (!chunk || chunk.bytes === 0) throw Object.assign(new Error("saved message text is not available yet"), { code: "unavailable" });
            break;
          } catch (error) {
            if (attempt >= 2 || !RETRYABLE_READ_ERRORS.has(error?.code)) throw error;
            await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt));
          }
        }
        // A live preview can arrive while a committed range is being read.
        // Re-evaluate the remaining gap instead of appending duplicate text.
        if (this.messages.get(messageId) !== message || message.renderedBytes !== offset) continue;
        message.evicted = false;
        this.append(message, chunk.text);
        this.onChange();
        // An old, large message may itself be evicted. Do not repeatedly read
        // the same first chunk after eviction resets its rendered byte offset.
        if (message.evicted) return;
        // EOF belongs to the artifact at the time of the read. Another commit
        // may have arrived while it was in flight, including the final reply.
        // Loop against the latest committed length instead of stopping early.
      }
    })().catch(error => {
      const message = this.messages.get(messageId);
      if (message) { message.loadError = String(error?.message ?? error); this.onChange(); }
      this.onError(error);
      throw error;
    }).finally(() => this.pendingFills.delete(messageId));
    this.pendingFills.set(messageId, task);
    // Event-driven callers deliberately do not await fills. Keep the rejection
    // observable to explicit callers without an unhandled background rejection.
    task.catch(() => {});
    return task;
  }

  /** Keep total retained text bounded: drop text of the oldest finished messages first (§13.3). */
  evict() {
    if (this.textBytes <= this.maxTextBytes) return;
    const ordered = [...this.messages.values()].filter((m) => m.status !== "streaming").sort((a, b) => a.ordinal - b.ordinal);
    for (const message of ordered) {
      if (this.textBytes <= this.maxTextBytes) break;
      this.textBytes -= message.renderedBytes;
      message.text = "";
      message.renderedBytes = 0;
      message.evicted = true;
    }
  }

  messagesFor(runId) {
    return [...this.messages.values()].filter((m) => !runId || m.runId === runId).sort((a, b) => a.ordinal - b.ordinal);
  }

  ordered() {
    return [...this.messages.values()].sort((a, b) => a.ordinal - b.ordinal);
  }

  toolsFor(runId) {
    return [...this.tools.values()].filter((t) => t.runId === runId);
  }
}

function byteLength(text) {
  if (typeof Buffer !== "undefined") return Buffer.byteLength(text, "utf8");
  return new TextEncoder().encode(text).length;
}
