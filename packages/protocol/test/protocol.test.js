import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { encodeFrame, createFrameDecoder, FRAME_MAX_BYTES, parseEnvelope, parseParams, parseEvent, compareSeq, toRpcError, ProtocolError, EventPayloadSchemas, GATED_EVENT_TYPES, ActivitySchema, TaskRecordSchema, TASK_HISTORY_LIMIT, TASK_TEXT_MAX, TASK_ID_MAX, WORKFLOW_PHASES_MAX, DialogSchema, DIALOG_INPUT_EVENT_MAX, activityPayload, NotificationSchema, parseActivity } from "../src/index.js";

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
  test("a task record's text and counts are bounded", () => {
    const task = { taskId: 't1', runId: 'r', toolUseId: 'u', description: 'x', subagentType: 'Explore', phase: 'p', backgrounded: true, status: 'running', startedAt: new Date().toISOString(), endedAt: null, usage: { totalTokens: 1, toolUses: 0, durationMs: 5 } };
    const valid = (patch) => TaskRecordSchema.safeParse({ ...task, ...patch }).success;
    expect(valid({ description: 'd'.repeat(TASK_TEXT_MAX), phase: 'p'.repeat(TASK_TEXT_MAX), taskId: 't'.repeat(TASK_ID_MAX), runId: 'r'.repeat(TASK_ID_MAX), toolUseId: 'u'.repeat(TASK_ID_MAX), subagentType: 's'.repeat(TASK_ID_MAX) })).toBe(true);
    for (const patch of [{ description: 'd'.repeat(TASK_TEXT_MAX + 1) }, { phase: 'p'.repeat(TASK_TEXT_MAX + 1) }, { taskId: 't'.repeat(TASK_ID_MAX + 1) }, { taskId: '' },
      { runId: 'r'.repeat(TASK_ID_MAX + 1) }, { toolUseId: 'u'.repeat(TASK_ID_MAX + 1) }, { subagentType: 's'.repeat(TASK_ID_MAX + 1) }, { description: 42 }]) expect(valid(patch)).toBe(false);
    for (const count of [-1, 1.5, Number.MAX_SAFE_INTEGER + 2]) expect(valid({ usage: { ...task.usage, totalTokens: count } })).toBe(false);
  });
  test("a task record carries Claude's task type and a workflow's name, which an older payload lacks", () => {
    const task = { taskId: 'wf-1', runId: 'wf-1-run', toolUseId: null, description: 'Workflow review', subagentType: null, phase: null, backgrounded: true, status: 'running', startedAt: new Date().toISOString(), endedAt: null, usage: { totalTokens: null, toolUses: null, durationMs: null } };
    expect(TaskRecordSchema.parse({ ...task, taskType: 'local_workflow', workflowName: 'review' })).toMatchObject({ taskType: 'local_workflow', workflowName: 'review' });
    expect(TaskRecordSchema.parse({ ...task, taskType: null, workflowName: null })).toMatchObject({ taskType: null, workflowName: null });
    expect(TaskRecordSchema.safeParse(task).success).toBe(true); // an engine from before them
    expect(TaskRecordSchema.safeParse({ ...task, taskType: 't'.repeat(TASK_ID_MAX + 1) }).success).toBe(false);
    expect(TaskRecordSchema.safeParse({ ...task, workflowName: 'w'.repeat(TASK_TEXT_MAX + 1) }).success).toBe(false);
    expect(TaskRecordSchema.safeParse({ ...task, taskType: 7 }).success).toBe(false);
  });
  test("a task record may carry a workflow's bounded summary of its phases and agents, which an older payload lacks", () => {
    const task = { taskId: 'wf-1', runId: 'wf-1-run', toolUseId: null, description: 'two trivial agents', subagentType: null, taskType: 'local_workflow', workflowName: 'probe-two', phase: null, backgrounded: true, status: 'running', startedAt: new Date().toISOString(), endedAt: null, usage: { totalTokens: 20388, toolUses: 0, durationMs: 42 } };
    const phase = { title: 'Say', agents: 2, done: 1, running: 1, failed: 0 };
    const workflow = { phases: [phase], agents: { total: 2, running: 1, done: 1, failed: 0 }, current: 'Say: say:1' };
    expect(TaskRecordSchema.parse({ ...task, workflow }).workflow).toEqual(workflow);
    expect(TaskRecordSchema.parse({ ...task, workflow: null }).workflow).toBeNull();
    expect(TaskRecordSchema.safeParse(task).success).toBe(true); // an engine from before it
    const valid = (patch) => TaskRecordSchema.safeParse({ ...task, workflow: { ...workflow, ...patch } }).success;
    expect(valid({ current: null, phases: Array.from({ length: WORKFLOW_PHASES_MAX }, () => ({ ...phase, title: 't'.repeat(TASK_TEXT_MAX) })) })).toBe(true);
    expect(valid({ phases: [], agents: { total: 0, running: 0, done: 0, failed: 0 } })).toBe(true);
    for (const patch of [{ phases: Array.from({ length: WORKFLOW_PHASES_MAX + 1 }, () => phase) }, { phases: [{ ...phase, title: 't'.repeat(TASK_TEXT_MAX + 1) }] },
      { phases: [{ ...phase, running: null }] }, { phases: [{ ...phase, failed: -1 }] }, { agents: { ...workflow.agents, total: 1.5 } }, { agents: { ...workflow.agents, done: null } },
      { current: 'c'.repeat(TASK_TEXT_MAX + 1) }, { current: 7 }, { current: undefined }]) expect(valid(patch)).toBe(false);
  });
  test("a dialog's tool and the input its event carries are bounded; the record keeps any input", () => {
    const at = new Date().toISOString();
    const dialog = { id: 'dlg_1', sessionId: 's1', runId: 'r1', requestId: 'req-1', tool: 'AskUserQuestion', toolUseId: null, input: { big: 'x'.repeat(DIALOG_INPUT_EVENT_MAX) }, response: null, state: 'requested', createdAt: at, resolvedAt: null };
    expect(DialogSchema.safeParse(dialog).success).toBe(true);
    expect(DialogSchema.safeParse({ ...dialog, tool: 't'.repeat(129) }).success).toBe(false);
    const requested = (input, tool = 'AskUserQuestion') => EventPayloadSchemas["dialog.requested"].safeParse({ dialogId: 'dlg_1', runId: 'r1', tool, input, toolUseId: null }).success;
    expect(requested({ big: 'x'.repeat(DIALOG_INPUT_EVENT_MAX - 20) })).toBe(true);
    expect(requested({ big: 'x'.repeat(DIALOG_INPUT_EVENT_MAX) })).toBe(false);
    expect(requested({ truncated: true, preview: '{"big":"xxx' })).toBe(true);
    expect(requested({}, 't'.repeat(129))).toBe(false);
  });
  test("a process's progress travels as a transient activity notification", () => {
    const activity = ActivitySchema.parse({ state: 'background', tasks: [], truncated: false, updatedAt: new Date().toISOString() });
    expect(NotificationSchema.safeParse({ jsonrpc: "2.0", method: "activity", params: { sessionId: 's1', activity } }).success).toBe(true);
    expect(parseEnvelope({ jsonrpc: "2.0", method: "activity", params: { sessionId: 's1', activity } }).ok).toBe(true);
    expect(parseActivity({ sessionId: 's1', activity })).toEqual({ ok: true, value: { sessionId: 's1', activity } });
    expect(parseActivity({ activity }).ok).toBe(false);
    expect(parseActivity({ sessionId: 's1', activity: { ...activity, state: 'busy' } }).ok).toBe(false);
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
