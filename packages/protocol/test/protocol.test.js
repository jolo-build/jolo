import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { encodeFrame, createFrameDecoder, FRAME_MAX_BYTES, parseEnvelope, parseParams, parseEvent, compareSeq, toRpcError, ProtocolError, EventPayloadSchemas, GATED_EVENT_TYPES, ActivitySchema, TaskRecordSchema, TASK_HISTORY_LIMIT, activityPayload } from "../src/index.js";

const fixtures = JSON.parse(readFileSync(new URL("../fixtures/wire.json", import.meta.url), "utf8"));

describe("framing", () => {
  test("round-trips split and coalesced reads", () => {
    const messages = [{ a: 1 }, { b: "two" }, { c: [3] }];
    const frames = Buffer.concat(messages.map((m) => encodeFrame(m)));
    const seen = [];
    const decode = createFrameDecoder({ onMessage: (m) => seen.push(m), onError: (e) => { throw e; } });
    for (let i = 0; i < frames.length; i += 3) decode(frames.subarray(i, Math.min(i + 3, frames.length)));
    expect(seen).toEqual(messages);
    const seen2 = [];
    const decode2 = createFrameDecoder({ onMessage: (m) => seen2.push(m), onError: (e) => { throw e; } });
    decode2(frames);
    expect(seen2).toEqual(messages);
  });

  test("rejects oversized frames before allocating them", () => {
    const errors = [];
    const decode = createFrameDecoder({ onMessage: () => { throw new Error("must not deliver"); }, onError: (e) => errors.push(e) });
    const header = Buffer.alloc(4);
    header.writeUInt32BE(FRAME_MAX_BYTES + 1, 0);
    decode(header);
    expect(errors[0]?.code).toBe("limit_exceeded");
    expect(() => encodeFrame({ text: "x".repeat(FRAME_MAX_BYTES) })).toThrow(/exceeds/);
  });

  test("rejects zero-length and malformed frames", () => {
    const errors = [];
    const decode = createFrameDecoder({ onMessage: () => {}, onError: (e) => errors.push(e) });
    decode(Buffer.from([0, 0, 0, 0]));
    expect(errors[0]?.code).toBe("invalid_frame");
    const bad = Buffer.from("{not json");
    const frame = Buffer.concat([Buffer.from([0, 0, 0, bad.length]), bad]);
    const errors2 = [];
    createFrameDecoder({ onMessage: () => {}, onError: (e) => errors2.push(e) })(frame);
    expect(errors2[0]?.code).toBe("invalid_frame");
  });

  test("bounds aggregate buffered bytes", () => {
    const errors = [];
    const decode = createFrameDecoder({ maxBuffered: 64, onMessage: () => {}, onError: (e) => errors.push(e) });
    decode(Buffer.concat([Buffer.from([0, 0, 1, 0]), Buffer.alloc(100, 0x20)]));
    expect(errors[0]?.code).toBe("limit_exceeded");
  });
});

describe("schemas", () => {
  test("envelope fixtures", () => {
    for (const f of fixtures.envelopes) expect(parseEnvelope(f.value).ok, f.name).toBe(f.valid);
  });
  test("param fixtures", () => {
    for (const f of fixtures.params) expect(parseParams(f.method, f.value).ok, `${f.method} ${JSON.stringify(f.value)}`).toBe(f.valid);
  });
  test("event fixtures", () => {
    for (const f of fixtures.events) expect(parseEvent(f.value).ok).toBe(f.valid);
  });
  test("defaults are applied", () => {
    const parsed = parseParams("events.subscribe", {});
    expect(parsed.ok && parsed.value.after).toBe("0");
  });
  test("sequence comparison avoids precision loss", () => {
    expect(compareSeq("9007199254740993", "9007199254740992")).toBe(1);
  });
  test("session.activity carries a process's state and tasks, and only to subscribers that declare it", () => {
    const task = { taskId: 't1', runId: null, toolUseId: null, description: 'x', subagentType: null, phase: null, backgrounded: true, status: 'running', startedAt: new Date().toISOString(), endedAt: null, usage: { totalTokens: null, toolUses: null, durationMs: null } };
    const activity = { state: 'background', tasks: [task], truncated: false, updatedAt: new Date().toISOString() };
    expect(EventPayloadSchemas["session.activity"].safeParse(activity).success).toBe(true);
    expect(EventPayloadSchemas["session.activity"].safeParse({ ...activity, state: 'busy' }).success).toBe(false);
    expect(ActivitySchema.safeParse(activity).success).toBe(true);
    expect(TaskRecordSchema.safeParse({ ...task, status: 'paused' }).success).toBe(false);
    expect(GATED_EVENT_TYPES).toContain("session.activity");
  });
  describe("an activity with more tasks than a payload carries", () => {
    const updatedAt = new Date().toISOString();
    const task = (taskId, status = 'completed') => ({ taskId, runId: null, toolUseId: null, description: '', subagentType: null, phase: null, backgrounded: true, status, startedAt: updatedAt, endedAt: status === 'running' ? null : updatedAt, usage: { totalTokens: null, toolUses: null, durationMs: null } });
    const finished = (count) => Array.from({ length: count }, (_, i) => task(`done-${i}`));
    test("keeps an old running task and the newest finished ones, and says finished ones were left out", () => {
      const payload = activityPayload({ state: 'background', tasks: [task('old-running', 'running'), ...finished(TASK_HISTORY_LIMIT + 1)], updatedAt });
      expect(payload.tasks.map(t => t.taskId)).toContain('old-running');
      expect(payload.truncated).toBe(true);
      expect(payload.tasks.map(t => t.taskId)).toEqual(['old-running', ...Array.from({ length: TASK_HISTORY_LIMIT - 1 }, (_, i) => `done-${i + 2}`)]);
      expect(ActivitySchema.safeParse(payload).success).toBe(true);
    });
    test("never drops a running task, even past the limit, and is truncated only when finished ones go", () => {
      const running = Array.from({ length: TASK_HISTORY_LIMIT + 1 }, (_, i) => task(`running-${i}`, 'running'));
      const crowded = activityPayload({ state: 'background', tasks: [...finished(1), ...running], updatedAt });
      expect(crowded.tasks).toEqual(running);
      expect(crowded.truncated).toBe(true);
      expect(ActivitySchema.safeParse(crowded).success).toBe(true);
      const onlyRunning = activityPayload({ state: 'background', tasks: running, updatedAt });
      expect(onlyRunning).toEqual({ state: 'background', tasks: running, truncated: false, updatedAt });
      expect(ActivitySchema.safeParse(onlyRunning).success).toBe(true);
    });
    test("passes a small activity through whole, and the schema still bounds finished tasks", () => {
      expect(activityPayload({ state: 'idle', tasks: finished(1), updatedAt })).toEqual({ state: 'idle', tasks: finished(1), truncated: false, updatedAt });
      expect(ActivitySchema.safeParse({ state: 'idle', tasks: finished(TASK_HISTORY_LIMIT + 1), truncated: false, updatedAt }).success).toBe(false);
      expect(ActivitySchema.safeParse({ state: 'background', tasks: [task('r', 'running'), ...finished(TASK_HISTORY_LIMIT)], truncated: false, updatedAt }).success).toBe(false);
    });
  });
  test("rpc errors never leak internal messages", () => {
    const e = toRpcError(new Error("stack trace with secrets"));
    expect(e.data.code).toBe("internal");
    expect(e.message).toBe("internal error");
    expect(toRpcError(new ProtocolError("conflict", "revision moved")).message).toBe("revision moved");
  });
});
