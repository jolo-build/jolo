import { describe, expect, test } from "bun:test";
import { SessionProjection } from "@jolo/client/projection";

const ev = (seq, type, payload, extra = {}) => ({ engineBootId: "b", eventSeq: String(seq), sessionId: "s", runId: "r", type, payload, at: "2026-09-07T00:00:00.000Z", ...extra });

describe("session projection", () => {
  const saved = (id, ordinal = 0, committedBytes = 4) => ({ id, runId: "r", role: "assistant", kind: "text", artifactId: id, ordinal, committedBytes, status: "complete" });

  test("a final commit arriving during an artifact read loads the remaining reply immediately", async () => {
    /** @type {(chunk: { text: string, bytes: number, eof: boolean }) => void} */
    let release;
    const p = new SessionProjection({ readArtifact: (_id, offset) => offset === 0
      ? new Promise(resolve => { release = resolve; })
      : Promise.resolve({ text: " world", bytes: 6, eof: true }) });
    p.applyEvent(ev(1, "message.started", { messageId: "m", role: "assistant", artifactId: "a", ordinal: 0 }));
    p.applyEvent(ev(2, "message.committed", { messageId: "m", committedBytes: 5 }));
    await Bun.sleep(1);
    p.applyEvent(ev(3, "message.finished", { messageId: "m", committedBytes: 11, status: "complete" }));
    release({ text: "hello", bytes: 5, eof: true }); // EOF when this read began, before the final commit
    await p.pendingFills.get("m");
    expect(p.messages.get("m")).toMatchObject({ text: "hello world", status: "complete", renderedBytes: 11 });
    expect(p.messages.get("m").loadError).toBeFalsy();
  });

  test("opening a snapshot cannot overwrite a completion received while it was loading", () => {
    const p = new SessionProjection({ readArtifact: async () => ({ text: "", bytes: 0, eof: true }) });
    p.applyEvent(ev(1, "message.started", { messageId: "m", role: "assistant", artifactId: "a", ordinal: 0 }));
    p.applyPreview({ messageId: "m", byteOffset: 0, text: "result" });
    p.applyEvent(ev(3, "message.finished", { messageId: "m", committedBytes: 6, status: "complete" }));
    p.applyEvent(ev(4, "run.state", { state: "completed", revision: 5 }));
    p.seed({ messages: [{ ...saved("m", 0, 0), status: "streaming" }], runs: [{ id: "r", state: "model", revision: 4 }], cursor: "2" });
    expect(p.messages.get("m")).toMatchObject({ text: "result", status: "complete", committedBytes: 6 });
    expect(p.runs.get("r").state).toBe("completed");
    expect(p.lastSeq).toBe("4");
  });

  test("opening multiple saved chats bounds shared reads and loads every message", async () => {
    let active = 0, peak = 0;
    const readArtifact = async () => {
      active++;
      peak = Math.max(peak, active);
      try {
        if (active > 32) throw Object.assign(new Error("too many pending requests"), { code: "limit_exceeded" });
        await Bun.sleep(1);
        return { text: "body", bytes: 4, eof: true };
      } finally { active--; }
    };
    const panes = Array.from({ length: 3 }, () => new SessionProjection({ readArtifact }));
    for (const p of panes) p.seed({ messages: Array.from({ length: 100 }, (_, i) => saved(`m${i}`, i)) });
    await Promise.all(panes.flatMap(p => p.ordered().map(m => p.fill(m.id))));
    expect(peak).toBeLessThanOrEqual(4);
    expect(panes.every(p => p.ordered().every(m => m.text === "body" && !m.loadError))).toBe(true);
    expect(panes.every(p => p.pendingFills.size === 0)).toBe(true);
  });

  test("temporary read failures recover automatically without duplicating a shared fill", async () => {
    let calls = 0;
    const p = new SessionProjection({ readArtifact: async () => {
      if (++calls === 1) throw Object.assign(new Error("too many pending requests"), { code: "limit_exceeded" });
      return { text: "body", bytes: 4, eof: true };
    } });
    p.seed({ messages: [saved("m")] });
    const first = p.fill("m");
    expect(p.fill("m")).toBe(first);
    await first;
    expect(calls).toBe(2);
    expect(p.messages.get("m")).toMatchObject({ text: "body", renderedBytes: 4 });
    expect(p.messages.get("m").loadError).toBeFalsy();
  });

  test("a failed saved message exposes an error and can be retried", async () => {
    let fail = true;
    const errors = [];
    const p = new SessionProjection({ onError: error => errors.push(error), readArtifact: async () => {
      if (fail) throw Object.assign(new Error("artifact temporarily unreadable"), { code: "internal" });
      return { text: "body", bytes: 4, eof: true };
    } });
    p.seed({ messages: [saved("m")] });
    await expect(p.fill("m")).rejects.toThrow("artifact temporarily unreadable");
    expect(p.messages.get("m").loadError).toBe("artifact temporarily unreadable");
    expect(errors).toHaveLength(1);
    expect(p.pendingFills.size).toBe(0);
    fail = false;
    await p.fill("m");
    expect(p.messages.get("m")).toMatchObject({ text: "body", loadError: null });
  });

  test("an empty artifact response becomes a recoverable error instead of loading forever", async () => {
    let calls = 0;
    const p = new SessionProjection({ readArtifact: async () => { calls++; return { text: "", bytes: 0, eof: true }; } });
    p.seed({ messages: [saved("m")] });
    await expect(p.fill("m")).rejects.toThrow("saved message text is not available yet");
    expect(calls).toBe(3);
    expect(p.messages.get("m").loadError).toBeTruthy();
  });

  test("a preview arriving during a read does not duplicate saved text", async () => {
    /** @type {(chunk: { text: string, bytes: number, eof: boolean }) => void} */
    let release;
    const p = new SessionProjection({ readArtifact: () => new Promise(resolve => { release = resolve; }) });
    p.seed({ messages: [saved("m")] });
    const fill = p.fill("m");
    await Bun.sleep(1);
    p.applyPreview({ messageId: "m", byteOffset: 0, text: "body" });
    release({ text: "body", bytes: 4, eof: true });
    await fill;
    expect(p.messages.get("m").text).toBe("body");
    expect(p.textBytes).toBe(4);
  });

  test("evicting a large saved message stops reading instead of restarting the first chunk", async () => {
    let calls = 0;
    const p = new SessionProjection({ maxTextBytes: 3, readArtifact: async () => {
      if (++calls > 2) throw new Error("repeated the evicted chunk");
      return { text: "body", bytes: 4, eof: false };
    } });
    p.seed({ messages: [saved("m", 0, 8)] });
    await p.fill("m");
    expect(calls).toBe(1);
    expect(p.messages.get("m").evicted).toBe(true);
    expect(p.textBytes).toBeLessThanOrEqual(3);
  });

  test("renders previews in order and fills gaps from committed artifacts", async () => {
    const reads = [];
    const artifact = "hello world";
    const projection = new SessionProjection({ readArtifact: async (id, offset, length) => { reads.push([id, offset, length]); const text = artifact.slice(offset, offset + length); return { text, bytes: text.length, eof: offset + text.length >= artifact.length }; } });
    projection.applyEvent(ev(1, "message.started", { messageId: "m1", role: "assistant", kind: "text", artifactId: "a1", ordinal: 0 }));
    projection.applyPreview({ sessionId: "s", runId: "r", messageId: "m1", byteOffset: 0, text: "hello" });
    projection.applyPreview({ sessionId: "s", runId: "r", messageId: "m1", byteOffset: 6, text: "world" }); // gap: dropped
    expect(projection.messages.get("m1").text).toBe("hello");
    projection.applyEvent(ev(2, "message.committed", { messageId: "m1", committedBytes: 11 }));
    await projection.pendingFills.get("m1");
    expect(projection.messages.get("m1").text).toBe("hello world");
    expect(reads).toEqual([["a1", 5, 6]]);
    projection.applyEvent(ev(2, "message.finished", { messageId: "m1", committedBytes: 11, status: "complete" })); // duplicate seq ignored
    expect(projection.messages.get("m1").status).toBe("streaming");
    projection.applyEvent(ev(3, "message.finished", { messageId: "m1", committedBytes: 11, status: "complete" }));
    expect(projection.messages.get("m1").status).toBe("complete");
  });

  test("evicts text of the oldest finished messages beyond the byte budget", () => {
    const projection = new SessionProjection({ readArtifact: async () => ({ text: "", bytes: 0, eof: true }), maxTextBytes: 20 });
    for (let i = 0; i < 3; i += 1) {
      projection.applyEvent(ev(i * 2 + 1, "message.started", { messageId: `m${i}`, role: "assistant", kind: "text", artifactId: `a${i}`, ordinal: i }));
      projection.applyPreview({ sessionId: "s", runId: "r", messageId: `m${i}`, byteOffset: 0, text: "0123456789" });
      projection.applyEvent(ev(i * 2 + 2, "message.finished", { messageId: `m${i}`, committedBytes: 10, status: "complete" }));
    }
    expect(projection.messages.get("m0").evicted).toBe(true);
    expect(projection.messages.get("m2").text).toBe("0123456789");
    expect(projection.textBytes).toBeLessThanOrEqual(20);
  });

  test("tracks runs and tools from events", () => {
    const projection = new SessionProjection({ readArtifact: async () => ({ text: "", bytes: 0, eof: true }) });
    projection.applyEvent(ev(1, "run.state", { state: "model", revision: 2 }));
    projection.applyEvent(ev(2, "tool.started", { invocationId: "i1", callId: "c1", name: "read_file", argumentDigest: "sha256:x", preview: "read_file {}" }));
    projection.applyEvent(ev(3, "tool.completed", { invocationId: "i1", callId: "c1", name: "read_file", status: "ok", durationMs: 5, resultBytes: 10, truncated: false }));
    expect(projection.runs.get("r").state).toBe("model");
    expect(projection.toolsFor("r")[0].status).toBe("ok");
  });

  test("a run first seen live carries the times clients show as elapsed, and a seeded run keeps its own", () => {
    const projection = new SessionProjection({ readArtifact: async () => ({ text: "", bytes: 0, eof: true }) });
    projection.applyEvent(ev(1, "run.state", { state: "queued", revision: 1 }, { at: "2026-09-07T00:00:01.000Z" }));
    projection.applyEvent(ev(2, "run.state", { state: "model", revision: 2 }, { at: "2026-09-07T00:00:09.000Z" }));
    expect(projection.runs.get("r")).toMatchObject({ createdAt: "2026-09-07T00:00:01.000Z", updatedAt: "2026-09-07T00:00:09.000Z" });
    const seeded = new SessionProjection({ readArtifact: async () => ({ text: "", bytes: 0, eof: true }) });
    seeded.seed({ runs: [{ id: "r", sessionId: "s", state: "queued", createdAt: "2026-09-06T10:00:00.000Z", updatedAt: "2026-09-06T10:00:00.000Z" }] });
    seeded.applyEvent(ev(1, "run.state", { state: "completed", revision: 4 }, { at: "2026-09-07T00:00:20.000Z" }));
    expect(seeded.runs.get("r")).toMatchObject({ createdAt: "2026-09-06T10:00:00.000Z", updatedAt: "2026-09-07T00:00:20.000Z" });
  });

  test("keeps verification attached through completion and replaces stale results", () => {
    const projection = new SessionProjection({ readArtifact: async () => ({ text: "", bytes: 0, eof: true }) });
    const checks = [{ invocationId: "i1", argv: ["bun", "test"], exitCode: 0, signal: null, at: "2026-09-07T00:00:00.000Z" }];
    projection.applyEvent(ev(1, "run.state", { state: "tools", revision: 2 }));
    projection.applyEvent(ev(2, "run.verification", { status: "passed", checks }));
    projection.applyEvent(ev(3, "run.state", { state: "completed", revision: 3 }));
    expect(projection.runs.get("r").verification).toEqual({ status: "passed", checks });
    projection.applyEvent(ev(4, "run.verification", { status: "stale", checks }));
    expect(projection.runs.get("r").verification.status).toBe("stale");
    expect(projection.runs.get("r").state).toBe("completed");
  });
});

test('task summaries survive live run transitions and reconnect snapshots',()=>{
  const references=[{key:'JOLO-1',title:'Fix it',revision:2}];
  const p=new SessionProjection({readArtifact:async()=>({text:'',bytes:0,eof:true})});
  p.applyEvent(ev(1,'run.state',{state:'queued',revision:1,taskReferences:references}));
  p.applyEvent(ev(2,'run.state',{state:'completed',revision:2}));
  expect(p.runs.get('r').taskReferences).toEqual(references);
  const reconnected=new SessionProjection({readArtifact:async()=>({text:'',bytes:0,eof:true})});
  reconnected.seed({messages:[],runs:[p.runs.get('r')],cursor:'2'});
  expect(reconnected.runs.get('r').taskReferences).toEqual(references);
});
