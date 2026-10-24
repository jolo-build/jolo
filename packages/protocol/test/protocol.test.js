import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { encodeFrame, createFrameDecoder, FRAME_MAX_BYTES, parseEnvelope, parseParams, parseEvent, compareSeq, toRpcError, ProtocolError, EventPayloadSchemas, GATED_EVENT_TYPES, ActivitySchema, TaskRecordSchema, TASK_HISTORY_LIMIT, TASK_TEXT_MAX, TASK_ID_MAX, TASK_PATH_MAX, WORKFLOW_PHASES_MAX, WORKFLOW_AGENTS_MAX, WORKFLOW_TITLE_MAX, WORKFLOW_LABEL_MAX, WORKFLOW_MODEL_MAX, WORKFLOW_PREVIEW_MAX, ACTIVITY_PAYLOAD_MAX_BYTES, DialogSchema, MessageSchema, DIALOG_INPUT_EVENT_MAX, activityPayload, NotificationSchema, parseActivity } from "../src/index.js";

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
  test("a message and its message.started event may carry when it was created, which an older engine leaves out", () => {
    const createdAt = "2026-10-24T11:42:00.000Z";
    const message = { id: "msg_1", sessionId: "ses_1", runId: "run_1", ordinal: 3, role: "assistant", kind: "text", artifactId: "art_1", committedBytes: 12, status: "complete" };
    expect(MessageSchema.parse({ ...message, createdAt })).toMatchObject({ createdAt });
    expect(MessageSchema.safeParse(message).success).toBe(true);
    expect(MessageSchema.safeParse({ ...message, createdAt: "yesterday" }).success).toBe(false);
    const started = { messageId: "msg_1", role: "assistant", kind: "text", artifactId: "art_1", ordinal: 3 };
    expect(EventPayloadSchemas["message.started"].parse({ ...started, createdAt })).toMatchObject({ createdAt });
    expect(EventPayloadSchemas["message.started"].safeParse(started).success).toBe(true);
    expect(EventPayloadSchemas["message.started"].safeParse({ ...started, createdAt: 42 }).success).toBe(false);
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
  test("a task record may carry the model its agent answers with, bounded, which an older payload lacks", () => {
    const task = { taskId: 'agent-1', runId: null, toolUseId: 'toolu_a', description: 'Explore the repo', subagentType: 'Explore', phase: null, backgrounded: true, status: 'running', startedAt: new Date().toISOString(), endedAt: null, usage: { totalTokens: null, toolUses: null, durationMs: null } };
    expect(TaskRecordSchema.parse({ ...task, model: 'claude-opus-5-5' }).model).toBe('claude-opus-5-5');
    expect(TaskRecordSchema.parse({ ...task, model: null }).model).toBeNull();
    expect(TaskRecordSchema.safeParse(task).success).toBe(true); // an engine from before it
    expect(TaskRecordSchema.safeParse({ ...task, model: 'm'.repeat(WORKFLOW_MODEL_MAX) }).success).toBe(true);
    expect(TaskRecordSchema.safeParse({ ...task, model: 'm'.repeat(WORKFLOW_MODEL_MAX + 1) }).success).toBe(false);
    expect(TaskRecordSchema.safeParse({ ...task, model: 7 }).success).toBe(false);
    expect(activityPayload({ state: 'background', tasks: [{ ...task, model: 'claude-opus-5-5' }], updatedAt: task.startedAt }).tasks[0].model).toBe('claude-opus-5-5');
  });
  test("a task record may carry a workflow's bounded summary of its phases and agents, which an older payload lacks", () => {
    const task = { taskId: 'wf-1', runId: 'wf-1-run', toolUseId: null, description: 'two trivial agents', subagentType: null, taskType: 'local_workflow', workflowName: 'probe-two', phase: null, backgrounded: true, status: 'running', startedAt: new Date().toISOString(), endedAt: null, usage: { totalTokens: 20388, toolUses: 0, durationMs: 42 } };
    const phase = { title: 'Say', agents: 2, done: 1, running: 1, failed: 0 };
    const workflow = { phases: [phase], agents: { total: 2, running: 1, done: 1, failed: 0 }, current: 'Say: say:1' };
    expect(TaskRecordSchema.parse({ ...task, workflow }).workflow).toEqual(workflow);
    expect(TaskRecordSchema.parse({ ...task, workflow: null }).workflow).toBeNull();
    expect(TaskRecordSchema.safeParse(task).success).toBe(true); // an engine from before it
    const valid = (patch) => TaskRecordSchema.safeParse({ ...task, workflow: { ...workflow, ...patch } }).success;
    // The engine cuts a phase's title to WORKFLOW_TITLE_MAX, as its agents' phase (the renderer matches them by it when an
    // agent names no phase index); the schema still takes the TASK_TEXT_MAX a payload from before that cut could carry. Its
    // index, which an older payload lacks, is a count.
    expect(WORKFLOW_TITLE_MAX).toBe(80);
    expect(valid({ current: null, phases: Array.from({ length: WORKFLOW_PHASES_MAX }, (_, i) => ({ ...phase, index: i + 1, title: 't'.repeat(WORKFLOW_TITLE_MAX) })) })).toBe(true);
    expect(valid({ phases: [{ ...phase, title: 't'.repeat(TASK_TEXT_MAX) }] })).toBe(true);
    expect(valid({ phases: [], agents: { total: 0, running: 0, done: 0, failed: 0 } })).toBe(true);
    for (const patch of [{ phases: Array.from({ length: WORKFLOW_PHASES_MAX + 1 }, () => phase) }, { phases: [{ ...phase, title: 't'.repeat(TASK_TEXT_MAX + 1) }] },
      { phases: [{ ...phase, index: -1 }] }, { phases: [{ ...phase, index: null }] },
      { phases: [{ ...phase, running: null }] }, { phases: [{ ...phase, failed: -1 }] }, { agents: { ...workflow.agents, total: 1.5 } }, { agents: { ...workflow.agents, done: null } },
      { current: 'c'.repeat(TASK_TEXT_MAX + 1) }, { current: 7 }, { current: undefined }]) expect(valid(patch)).toBe(false);
  });
  test("a task record may carry where it sits, what it does now and how it ended, which an older payload lacks", () => {
    const task = { taskId: 'cmd-1', runId: 'cmd-1-run', toolUseId: null, description: 'Sleep 75 seconds then print ok', subagentType: null, taskType: 'local_bash', phase: null, backgrounded: false, status: 'stopped', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), usage: { totalTokens: null, toolUses: null, durationMs: null } };
    const detail = { parentTaskId: 'a47340cffe7ba1185', spawnDepth: 1, lastTool: 'Bash', progress: 'Running Sleep 75 seconds then print ok', summary: 'Sleep 75 seconds then print ok', outputFile: '/private/tmp/tasks/cmd-1.output' };
    expect(TaskRecordSchema.parse({ ...task, ...detail })).toMatchObject(detail);
    const none = { parentTaskId: null, spawnDepth: null, lastTool: null, progress: null, summary: null, outputFile: null };
    expect(TaskRecordSchema.parse({ ...task, ...none })).toMatchObject(none);
    expect(TaskRecordSchema.safeParse(task).success).toBe(true); // an engine from before them
    const valid = (patch) => TaskRecordSchema.safeParse({ ...task, ...detail, ...patch }).success;
    expect(valid({ parentTaskId: 'p'.repeat(TASK_ID_MAX), lastTool: 'b'.repeat(TASK_ID_MAX), progress: 'd'.repeat(TASK_TEXT_MAX), summary: 's'.repeat(TASK_TEXT_MAX), outputFile: 'f'.repeat(TASK_PATH_MAX) })).toBe(true);
    expect(TASK_PATH_MAX).toBe(1024);
    for (const patch of [{ parentTaskId: 'p'.repeat(TASK_ID_MAX + 1) }, { lastTool: 'b'.repeat(TASK_ID_MAX + 1) }, { progress: 'd'.repeat(TASK_TEXT_MAX + 1) }, { summary: 's'.repeat(TASK_TEXT_MAX + 1) },
      { outputFile: 'f'.repeat(TASK_PATH_MAX + 1) }, { spawnDepth: -1 }, { spawnDepth: 1.5 }, { summary: 7 }, { parentTaskId: 7 }]) expect(valid(patch)).toBe(false);
  });
  test("a workflow's summary may carry a bounded list of its agents, which an older payload lacks", () => {
    const task = { taskId: 'wf-1', runId: 'wf-1-run', toolUseId: null, description: 'two trivial agents', subagentType: null, taskType: 'local_workflow', workflowName: 'probe-two', phase: null, backgrounded: true, status: 'running', startedAt: new Date().toISOString(), endedAt: null, usage: { totalTokens: 20388, toolUses: 0, durationMs: 42 } };
    const done = { label: 'say:1', phase: 'Say', phaseIndex: 1, state: /** @type {const} */ ('done'), model: 'claude-fable-5-1', tokens: 20388, toolCalls: 0, durationMs: 3428, resultPreview: 'agent 1 ok' };
    const started = { label: 'say:2', phase: 'Say', phaseIndex: 1, state: /** @type {const} */ ('running'), model: 'claude-fable-5-1', tokens: null, toolCalls: null, durationMs: null, resultPreview: null };
    const workflow = (list) => ({ phases: [{ index: 1, title: 'Say', agents: 2, done: 1, running: 1, failed: 0 }], agents: { total: 2, running: 1, done: 1, failed: 0, ...(list && { list }) }, current: 'Say: say:2' });
    expect(TaskRecordSchema.parse({ ...task, workflow: workflow([done, started]) }).workflow.agents.list).toEqual([done, started]);
    expect(TaskRecordSchema.safeParse({ ...task, workflow: workflow(null) }).success).toBe(true); // an engine from before it
    const valid = (list) => TaskRecordSchema.safeParse({ ...task, workflow: workflow(list) }).success;
    expect([WORKFLOW_AGENTS_MAX, WORKFLOW_LABEL_MAX, WORKFLOW_MODEL_MAX, WORKFLOW_PREVIEW_MAX]).toEqual([200, 120, 64, 160]);
    expect(valid(Array.from({ length: WORKFLOW_AGENTS_MAX }, () => ({ ...done, label: 'l'.repeat(WORKFLOW_LABEL_MAX), phase: 'p'.repeat(WORKFLOW_TITLE_MAX), model: 'm'.repeat(WORKFLOW_MODEL_MAX), resultPreview: 'r'.repeat(WORKFLOW_PREVIEW_MAX) })))).toBe(true);
    expect(valid([{ ...started, state: 'failed', phase: null, phaseIndex: null }])).toBe(true);
    for (const list of [Array.from({ length: WORKFLOW_AGENTS_MAX + 1 }, () => done), [{ ...done, label: 'l'.repeat(WORKFLOW_LABEL_MAX + 1) }], [{ ...done, resultPreview: 'r'.repeat(WORKFLOW_PREVIEW_MAX + 1) }],
      [{ ...done, model: 'm'.repeat(WORKFLOW_MODEL_MAX + 1) }], [{ ...done, phase: 'p'.repeat(WORKFLOW_TITLE_MAX + 1) }], [{ ...done, phaseIndex: -1 }], [{ ...done, phaseIndex: undefined }],
      [{ ...done, state: 'start' }], [{ ...done, tokens: -1 }], [{ ...done, durationMs: 1.5 }], [{ ...done, label: null }], [{ ...done, toolCalls: undefined }]]) expect(valid(list)).toBe(false);
  });
  describe("an activity payload fits in a frame", () => {
    const at = new Date().toISOString();
    const bytes = (/** @type {unknown} */ value) => Buffer.byteLength(JSON.stringify(value));
    let serial = 0;
    /** A task as the engine keeps it; `fill` writes each string at its cap (a three-byte character is the most one costs). */
    const taskOf = (/** @type {string} */ status, workflow = null, fill = '') => {
      const text = (/** @type {number} */ max) => (fill ? fill.repeat(max) : 'x');
      return {
        taskId: fill ? String(++serial).padStart(TASK_ID_MAX, 'i') : `t${++serial}`, runId: text(TASK_ID_MAX), toolUseId: text(TASK_ID_MAX), description: text(TASK_TEXT_MAX),
        subagentType: text(TASK_ID_MAX), taskType: workflow ? 'local_workflow' : text(TASK_ID_MAX), workflowName: text(TASK_TEXT_MAX), phase: text(TASK_TEXT_MAX),
        backgrounded: true, status, startedAt: at, endedAt: status === 'running' ? null : at,
        usage: { totalTokens: Number.MAX_SAFE_INTEGER, toolUses: Number.MAX_SAFE_INTEGER, durationMs: Number.MAX_SAFE_INTEGER }, workflow,
        parentTaskId: text(TASK_ID_MAX), spawnDepth: Number.MAX_SAFE_INTEGER, lastTool: text(TASK_ID_MAX), progress: text(TASK_TEXT_MAX), summary: text(TASK_TEXT_MAX), outputFile: text(TASK_PATH_MAX),
      };
    };
    /** A workflow's summary listing `agents` agents and `phases` phases, every string of them at its cap. */
    const flowOf = (/** @type {number} */ agents, fill = 'a', phases = 1) => ({
      phases: Array.from({ length: phases }, (_, i) => ({ index: i + 1, title: fill.repeat(WORKFLOW_TITLE_MAX), agents, done: 0, running: agents, failed: 0 })),
      agents: { total: agents, running: agents, done: 0, failed: 0, list: Array.from({ length: agents }, () => ({
        label: fill.repeat(WORKFLOW_LABEL_MAX), phase: fill.repeat(WORKFLOW_TITLE_MAX), phaseIndex: 1, state: /** @type {const} */ ('running'), model: fill.repeat(WORKFLOW_MODEL_MAX),
        tokens: Number.MAX_SAFE_INTEGER, toolCalls: Number.MAX_SAFE_INTEGER, durationMs: Number.MAX_SAFE_INTEGER, resultPreview: fill.repeat(WORKFLOW_PREVIEW_MAX),
      })) },
      current: fill.repeat(TASK_TEXT_MAX),
    });
    const listed = (/** @type {any} */ task) => task.workflow?.agents.list !== undefined;
    const activityOf = (/** @type {any[]} */ tasks) => ({ state: /** @type {const} */ ('background'), tasks, updatedAt: at });

    test("what fits is kept whole", () => {
      const tasks = [taskOf('completed'), taskOf('running', flowOf(WORKFLOW_AGENTS_MAX)), taskOf('running')];
      expect(ACTIVITY_PAYLOAD_MAX_BYTES).toBe(FRAME_MAX_BYTES - 16 * 1024);
      expect(activityPayload(activityOf(tasks))).toEqual({ ...activityOf(tasks), truncated: false });
    });

    test("past the room, the finished workflows' agent lists go first, the oldest first", () => {
      // Three lists of 150 agents (about 89 KB each) and a small one: dropping the oldest finished list is enough.
      const tasks = [taskOf('completed', flowOf(150)), taskOf('running', flowOf(150)), taskOf('stopped', flowOf(150)), taskOf('completed', flowOf(10))];
      const payload = activityPayload(activityOf(tasks));
      expect(payload.tasks.map(t => t.taskId)).toEqual(tasks.map(t => t.taskId));
      expect(payload.tasks.map(listed)).toEqual([false, true, true, true]);
      expect(payload.tasks[0].workflow).toEqual({ ...tasks[0].workflow, agents: { total: 150, running: 150, done: 0, failed: 0 } }); // its counts and phases stay
      expect(payload.truncated).toBe(false);
      expect(bytes(payload)).toBeLessThanOrEqual(ACTIVITY_PAYLOAD_MAX_BYTES);
      expect(listed(tasks[0])).toBe(true); // what the engine keeps is not changed
    });

    test("then the running workflows' lists, the oldest first, before any finished task is left out", () => {
      const tasks = [taskOf('completed'), taskOf('running', flowOf(150)), taskOf('running', flowOf(150)), taskOf('running', flowOf(150))];
      const payload = activityPayload(activityOf(tasks));
      expect(payload.tasks.map(t => t.taskId)).toEqual(tasks.map(t => t.taskId));
      expect(payload.tasks.map(listed)).toEqual([false, false, true, true]);
      expect(payload.truncated).toBe(false);
    });

    test("then the oldest finished tasks, never a running one: 200 tasks with every string at its cap still travel as one event", () => {
      // Five running tasks (three of them workflows of 200 agents and 100 phases), and 195 finished, every tenth a workflow
      // with a full list; each string at its cap in three-byte characters.
      const tasks = Array.from({ length: TASK_HISTORY_LIMIT }, (_, i) => {
        const running = i % 40 === 7;
        const flow = running ? i < 100 : i % 10 === 0;
        return taskOf(running ? 'running' : 'completed', flow ? flowOf(WORKFLOW_AGENTS_MAX, 'あ', WORKFLOW_PHASES_MAX) : null, 'あ');
      });
      const running = tasks.filter(t => t.status === 'running').map(t => t.taskId);
      expect(running).toHaveLength(5);
      expect(bytes(tasks)).toBeGreaterThan(10 * FRAME_MAX_BYTES);
      const payload = activityPayload(activityOf(tasks));
      expect(payload.tasks.filter(t => t.status === 'running').map(t => t.taskId)).toEqual(running);
      const finished = tasks.filter(t => t.status !== 'running').map(t => t.taskId);
      const kept = payload.tasks.filter(t => t.status !== 'running').map(t => t.taskId);
      expect(kept.length).toBeGreaterThan(0);
      expect(kept).toEqual(finished.slice(-kept.length)); // the newest finished ones, the oldest left out
      expect(payload.tasks.some(listed)).toBe(false);
      expect(payload.truncated).toBe(true);
      expect(bytes(payload)).toBeLessThanOrEqual(ACTIVITY_PAYLOAD_MAX_BYTES);
      expect(ActivitySchema.safeParse(payload).success).toBe(true);
      const event = { engineBootId: 'boot_' + 'b'.repeat(59), eventSeq: '9'.repeat(19), sessionId: 's'.repeat(64), runId: null, type: 'session.activity', payload, at };
      expect(() => encodeFrame({ jsonrpc: '2.0', method: 'event', params: event })).not.toThrow();
      expect(() => encodeFrame({ jsonrpc: '2.0', method: 'activity', params: { sessionId: 's'.repeat(64), activity: payload } })).not.toThrow();
    });
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
