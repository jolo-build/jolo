# Native Claude Host, Plan 1: Engine Core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the engine know, show, stop and wait for everything a hosted Claude Code process does between and after turns: per-task activity with usage, per-task and all-tasks stop, Claude's user dialogs, and delegation that is "done" only when the child is idle.

**Architecture:** The hosted link (`claude-link.js`) already tracks background task ids to keep the process alive; this plan turns that into a task ledger with usage and status, published as `session.activity` events, and adds the two controls Claude Code offers a host (`stop_task`, `perTaskStopAffordance`). The stream executor (`claude-stream.js`) declares the dialog kinds Jolo renders and turns `request_user_dialog` into dialog records the UI answers. The delegation service reads the child's activity so "done" means idle, and waits inside the engine instead of letting the parent poll with model turns. UI rendering is Plan 2; settings-driven caps are Plan 3.

**Tech Stack:** Bun 1.4.3, plain JavaScript (ESM), zod schemas in `packages/protocol`, bun:sqlite storage, `bun test`.

**Spec:** `docs/superpowers/specs/2026-10-23-native-claude-hosting-design.md` (sections 4, 5.1, 5.3, 5.4, 5.5, 5.8, 10).

## Global Constraints

- Owner rules: no over-engineering; nothing hardcoded (timings are exported constants a test can shorten or settings with finite defaults); secure by default.
- Nothing Claude started is killed except by the person's stop or the close order in §5.3 of the spec: `stop_task` → interrupt → EOF → SIGTERM → SIGKILL.
- New event types join `EVENT_TYPES` only (they are gated for older subscribers); every new event has an `EventPayloadSchemas` entry.
- New settings follow the `BudgetSettingsSchema` / `BudgetPatchSchema` / `settings.js` pattern: defaults on read, not on patch.
- Every behavior lands red → green: write the test, run it and watch it fail, implement, run it and watch it pass, run the touched files' suites, commit. Commit message style: imperative, one line, as in `git log`.
- Each task adds one line under `## [Unreleased]` in `CHANGELOG.md`.
- Real-binary probes cost usage; each is capped with `--max-budget-usd` and run once, results recorded in the repo.
- Branch: `feat/native-claude-host` (worktree). Tests: `bun test <file>` from the repo root; full suite `bun test tests packages apps` before the final commit. Set `TMPDIR` to a short path when running integration tests (socket path limit).

## Review Focus

1. A `task_notification` for a task Jolo never saw start (process resumed, or started before the link attached): the ledger must record it as finished, not throw or ignore it. Pinned in Task 1.
2. A hundred `task_progress` messages in one second (a 16-agent fan-out): the activity feed must coalesce to at most a few events per second and cap the task list with a `truncated` flag. Pinned in Task 2.
3. `stop_task` for a task that finished a moment earlier: Claude answers an error; Jolo must report it as not stopped and must not escalate to an interrupt on its own. Pinned in Task 3.
4. A dialog answered after its run was stopped, or stopped while an answer is in flight: exactly one `control_response` per request, never two, never none. Pinned in Task 4.
5. A child whose process is in `background` when the parent asks: `delegation_status` must say `done: false` with `activity: "background"` even though the run is `completed`, so a parent never relays "waiting on the workflow" as the answer. Pinned in Task 5.

---

### Task 1: Task ledger in the hosted link

**Files:**
- Modify: `apps/engine/src/agents/claude-link.js:194-216` (replace the `tasks`/`backgrounded` sets with a ledger), `:90-128` (registry option `onActivity`), `:422-484` (link getter `activity`)
- Modify: `tests/fixtures/fake-claude.js` (new scenario `tasks <n> <ms>`; `task_progress` with usage in `background` and `tasks`)
- Test: `apps/engine/test/claude-link.test.js`

**Interfaces:**
- Produces `link.activity` → `{ state: 'idle' | 'working' | 'background', tasks: TaskRecord[], updatedAt: string }` where `TaskRecord = { taskId: string, runId: string | null, toolUseId: string | null, description: string, subagentType: string | null, phase: string | null, backgrounded: boolean, status: 'running' | 'completed' | 'stopped' | 'failed', startedAt: string, endedAt: string | null, usage: { totalTokens: number | null, toolUses: number | null, durationMs: number | null } }`.
- Produces `createHostedLinks({ ..., onActivity })` with `onActivity: (sessionId: string, activity) => void`, called at most once per `ACTIVITY_COALESCE_MS` (exported, default `250`) per link, trailing edge, and immediately on every `state` change.
- Produces exported `TASK_HISTORY_LIMIT = 200`: finished tasks beyond it are dropped oldest first; running tasks are never dropped.
- Keeps `link.working` exactly as today (running tasks keep the process alive).

- [ ] **Step 1: Extend the fixture.** In `tests/fixtures/fake-claude.js`, add scenario `tasks <n> <ms>`: say `Started <n> tasks.`, emit `task_started` for `task-1..task-n` (`description: "task <i>"`, `is_backgrounded: true`, `tool_use_id: "toolu_task_<i>"`), after `ms/2` emit `task_progress` for each with `usage: { total_tokens: 1000 * i, tool_uses: i, duration_ms: ms/2 }`, after `ms` emit `task_notification status: "completed"` for each, then a self-started turn `All <n> tasks done.` as `background` does. Register the task timers in `backgroundWork` so `stop_task` (Task 3) can cancel them. Add one `task_progress` (`total_tokens: 1234`) to the existing `background` scenario between its start and end.

- [ ] **Step 2: Write the failing test** in `apps/engine/test/claude-link.test.js`:

```js
test('the link keeps a record of each background task with its usage and reports activity as it changes', async () => {
  const seen = [];
  const registry = createHostedLinks({ log, onActivity: (sessionId, activity) => seen.push({ sessionId, ...activity }) });
  const link = open(registry);
  await turn(link, 'tasks 2 300', { init: true });
  await waitFor(() => link.activity.state === 'background');
  expect(link.activity.tasks.map(t => [t.taskId, t.status, t.backgrounded])).toEqual([['task-1', 'running', true], ['task-2', 'running', true]]);
  await waitFor(() => link.activity.tasks.every(t => t.usage.totalTokens !== null));
  expect(link.activity.tasks[1].usage).toEqual({ totalTokens: 2000, toolUses: 2, durationMs: 150 });
  await waitFor(() => link.activity.state === 'idle', 5000);
  expect(link.activity.tasks.map(t => t.status)).toEqual(['completed', 'completed']);
  expect(link.activity.tasks[0].endedAt).not.toBeNull();
  expect(seen.map(a => a.state)).toContain('background');
  expect(seen.at(-1)).toMatchObject({ sessionId: 'session', state: 'idle' });
  await registry.closeAll();
});

test('a task that ends without ever having been seen to start is still recorded', async () => {
  // Drive the link with a hand-written process: feed a task_notification for an unknown id through `follow`.
  // Use the fixture scenario `notify-unknown` (add it: emits task_notification task_id "ghost" status "failed", then answers).
  const registry = createHostedLinks({ log });
  const link = open(registry);
  await turn(link, 'notify-unknown', { init: true });
  expect(link.activity.tasks.find(t => t.taskId === 'ghost')).toMatchObject({ status: 'failed', startedAt: expect.any(String), description: '' });
  await registry.closeAll();
});
```

Add the `notify-unknown` scenario to the fixture as the comment says.

- [ ] **Step 3: Run to verify it fails.** Run: `bun test apps/engine/test/claude-link.test.js -t "record of each background task|without ever having been seen"`. Expected: FAIL, `link.activity` is undefined.

- [ ] **Step 4: Implement the ledger** in `claude-link.js`: a `Map<string, TaskRecord>` replacing the `tasks` set (keep a `running()` count where `tasks.size` was used: `working`, idle close, `onBackground`), `backgrounded` derived from the record. `trackTasks` handles `task_started` (new record), `task_progress` (usage), `task_updated` (`patch.workflow_phase ?? patch.phase` → `phase`, `patch.description` → `description`, `patch.status` when it names a terminal status), `task_notification` (status map: `completed`→`completed`, `stopped`→`stopped`, `failed`|`error`→`failed`, anything else→`completed`; unknown id → create the record first). Trim finished records beyond `TASK_HISTORY_LIMIT`. `state` = `current ? 'working' : running() ? 'background' : 'idle'`; recompute on `trackTasks`, `beginTurn`, `finishTurn`, process end (all records `running` → `failed`, `endedAt` set). Coalesce `onActivity` with one timer per link; flush immediately when `state` changes; `unref` the timer.

- [ ] **Step 5: Run to verify it passes.** Run: `bun test apps/engine/test/claude-link.test.js`. Expected: all PASS (the existing tests still hold: `working`, idle close, Stop semantics unchanged in this task).

- [ ] **Step 6: Commit.**

```bash
git add apps/engine/src/agents/claude-link.js apps/engine/test/claude-link.test.js tests/fixtures/fake-claude.js
git commit -m "Keep a ledger of a hosted process's tasks with their usage and report its activity"
```

---

### Task 2: `session.activity` events and a snapshot method

**Files:**
- Modify: `packages/protocol/src/schemas.js:214-248` (`EVENT_TYPES` add `"session.activity"` after `"schedule.updated"`), `:548-600` (`EventPayloadSchemas["session.activity"]`), `MethodSchemas` (`'session.activity'`)
- Modify: `apps/engine/src/engine.js:140` (pass `onActivity` to `createHostedLinks`), `apps/engine/src/rpc/handlers.js` (`'session.activity'` handler)
- Test: `tests/integration/claude-stream.test.js`, `packages/protocol/test/schemas.test.js` (existing protocol tests; add the payload case)

**Interfaces:**
- Consumes `link.activity`, `onActivity(sessionId, activity)` from Task 1.
- Produces event `session.activity` with payload `ActivitySchema = { state: 'idle'|'working'|'background', tasks: TaskRecordSchema[] (max 200), truncated: boolean, updatedAt: IsoTimestamp }`, `sessionId` set, `runId` null.
- Produces RPC `session.activity` `{ sessionId }` → `{ activity: ActivitySchema | null }` (null when the conversation has no live process).
- Exports `ActivitySchema`, `TaskRecordSchema` from `@jolo/protocol`.

- [ ] **Step 1: Write the failing protocol test** in `packages/protocol/test/schemas.test.js`: `EventPayloadSchemas["session.activity"]` parses `{ state: 'background', tasks: [{ taskId: 't1', runId: null, toolUseId: null, description: 'x', subagentType: null, phase: null, backgrounded: true, status: 'running', startedAt: new Date().toISOString(), endedAt: null, usage: { totalTokens: null, toolUses: null, durationMs: null } }], truncated: false, updatedAt: new Date().toISOString() }` and rejects `state: 'busy'`; and `GATED_EVENT_TYPES` contains `"session.activity"`.

- [ ] **Step 2: Write the failing integration test** in `tests/integration/claude-stream.test.js` (the `boot()` helper subscribes with `eventTypes` = all `EVENT_TYPES`; check `client.subscribe` in `boot()` declares them, add if not):

```js
test('background work is reported as session activity while it runs and when it ends', async () => {
  const { client, events, session, runTo } = await boot();
  const run = await runTo('bg-activity', 'tasks 2 400');
  expect(run.state).toBe('completed');
  await waitFor(() => events.some(e => e.type === 'session.activity' && e.sessionId === session.id && e.payload.state === 'background'));
  const live = await client.call('session.activity', { sessionId: session.id });
  expect(live.activity.tasks).toHaveLength(2);
  await waitFor(() => events.some(e => e.type === 'session.activity' && e.payload.state === 'idle' && e.payload.tasks.every(t => t.status === 'completed')), { timeoutMs: 5000 });
  const bursts = events.filter(e => e.type === 'session.activity');
  expect(bursts.length).toBeLessThan(12); // coalesced: not one event per progress message
});
```

- [ ] **Step 3: Run to verify both fail.** Run: `bun test packages/protocol/test/schemas.test.js tests/integration/claude-stream.test.js -t "session.activity|session activity"`. Expected: FAIL (`session.activity` not in `EVENT_TYPES`; unknown RPC method).

- [ ] **Step 4: Implement.** Schemas as in Interfaces (`tasks: z.array(TaskRecordSchema).max(TASK_HISTORY_LIMIT)`; the engine sets `truncated: true` and slices to the newest 200 when the ledger has more). `engine.js`: `onActivity: (sessionId, activity) => storage.appendEvent({ sessionId, type: 'session.activity', payload: activity })` (storage already publishes appended events; a session that no longer exists → skip). `handlers.js`: `'session.activity': ({ sessionId }) => ({ activity: hostedLinks?.get(sessionId)?.activity ?? null })` with the same session access checks `session.page` applies.

- [ ] **Step 5: Run to verify it passes.** Run the two files. Expected: PASS. Then `bun test packages apps/engine/test` to confirm nothing else parses events strictly.

- [ ] **Step 6: Commit.**

```bash
git add packages/protocol/src/schemas.js packages/protocol/test/schemas.test.js apps/engine/src/engine.js apps/engine/src/rpc/handlers.js tests/integration/claude-stream.test.js CHANGELOG.md
git commit -m "Publish a hosted process's background activity as session.activity events"
```

---

### Task 3: Stop one task, stop all background work, and tell Claude Jolo can

**Files:**
- Modify: `apps/engine/src/agents/claude-link.js` (`stopTask`, `stopBackground`, `follow` routing of stop-task responses, `close` order), `apps/engine/src/agents/claude-stream.js:561` (`initialize` adds `perTaskStopAffordance: true`), `packages/protocol/src/schemas.js` (`MethodSchemas['session.stopBackground']`, `['session.stopTask']`), `apps/engine/src/rpc/handlers.js`
- Modify: `tests/fixtures/fake-claude.js` (handle `stop_task`)
- Test: `apps/engine/test/claude-link.test.js`, `tests/integration/claude-stream.test.js`, `CHANGELOG.md`

**Interfaces:**
- Consumes the ledger from Task 1.
- Produces `link.stopTask(taskId) → Promise<{ ok: boolean, error: string | null }>` (sends `{ type: 'control_request', request_id: 'jolo-stop-task-<n>', request: { subtype: 'stop_task', task_id } }`, resolves on its `control_response`; `ok` false with Claude's error text on an error response; resolves `{ ok: false, error: 'process ended' }` if the process goes away).
- Produces `link.stopBackground() → Promise<{ requested: number, stopped: number, escalated: boolean }>`: `stopTask` for every `running` record, then wait up to `STOP_TASK_GRACE_MS` (exported, default `3000`) for their `task_notification`; if any is still running after the grace, send one Stop (`sendStop()`) and set `escalated: true`. Two kinds of error answer are told apart: an error whose text contains `not supported` means this Claude Code cannot stop tasks, so `stopBackground` escalates to the Stop at once (the spec's capability fallback); any other error (an unknown or already finished task) counts the task as not stopped and never escalates on its own (Review Focus 3). Add a fixture flag `FAKE_CLAUDE_NO_STOP_TASK=1` that makes the fixture answer every `stop_task` with `error: "stop_task is not supported in this context"`, and a unit test that `stopBackground()` then returns `{ requested: n, stopped: 0, escalated: true }` and the tasks end through the interrupt.
- Produces RPC `session.stopBackground { sessionId } → { requested, stopped, escalated }` and `session.stopTask { sessionId, taskId } → { ok, error }`; both answer `{ requested: 0, stopped: 0, escalated: false }` / `{ ok: false, error: 'no process' }` when the conversation has no live process.
- `initialize` now carries `perTaskStopAffordance: true`, so Claude's interrupt spares background work; the spec's Stop = "ends the turn, background work is listed, not killed".

- [ ] **Step 1: Teach the fixture `stop_task`.** In `fake-claude.js` input loop: on `control_request` subtype `stop_task`, if `task_id` is a known running task, clear its timers, emit `task_notification` with `status: "stopped"`, answer `control_response` success `{}`; otherwise answer `control_response` subtype `error`, `error: "stop_task: unknown task"`. The fixture already spares background work on interrupt when `perTaskStopAffordance` was declared (`sparesBackground`).

- [ ] **Step 2: Write the failing unit tests** in `claude-link.test.js`:

```js
test('stopping one background task ends it and leaves the others and the process', async () => {
  const registry = createHostedLinks({ log });
  const link = open(registry);
  await turn(link, 'tasks 2 5000', { init: true });
  await waitFor(() => link.activity.tasks.length === 2);
  expect(await link.stopTask('task-1')).toEqual({ ok: true, error: null });
  await waitFor(() => link.activity.tasks.find(t => t.taskId === 'task-1').status === 'stopped');
  expect(link.activity.tasks.find(t => t.taskId === 'task-2').status).toBe('running');
  expect(link.alive).toBe(true);
  expect(await link.stopTask('nope')).toMatchObject({ ok: false, error: expect.stringContaining('unknown task') });
  await registry.closeAll();
});

test('stopping all background work ends every task without escalating when they comply', async () => {
  const registry = createHostedLinks({ log });
  const link = open(registry);
  await turn(link, 'tasks 3 5000', { init: true });
  await waitFor(() => link.activity.tasks.length === 3);
  expect(await link.stopBackground()).toEqual({ requested: 3, stopped: 3, escalated: false });
  expect(link.activity.state).toBe('idle');
  const next = await turn(link, 'still here?');
  expect(next.text).toMatch(/still here\?$/); // the process stayed
  await registry.closeAll();
});
```

Add a fixture scenario `tasks-stubborn <n>` whose tasks ignore `stop_task` (answer success but never emit `task_notification`), and a third test: `stopBackground()` on it returns `{ requested: n, stopped: 0, escalated: true }` within `STOP_TASK_GRACE_MS + 500` ms, and the interrupt that follows ends the tasks (the fixture's interrupt handler clears `backgroundWork` when `sparesBackground` is false; make `tasks-stubborn` tasks always clear on interrupt).

- [ ] **Step 3: Run to verify they fail.** Run: `bun test apps/engine/test/claude-link.test.js -t "stopping one background task|stopping all background work"`. Expected: FAIL, `link.stopTask is not a function`.

- [ ] **Step 4: Implement** `stopTask`, `stopBackground`, response routing (a `Map<requestId, resolve>` consulted in `follow` for `control_response`, before the Stop receipts), and the `initialize` field in `claude-stream.js:561`. Update the comment at `claude-stream.js:560` and the one at `claude-link.js:171` to say Stop ends the turn and what waits behind it, and that background work is stopped through `stopBackground`.

- [ ] **Step 5: Fix the two tests whose expectation the spec changes.** `claude-link.test.js:333` ("stopping a run drops its waiting message and ends the background work") and `tests/integration/claude-stream.test.js:933` ("stopping a turn stops the background work the process is running too"): with `perTaskStopAffordance` declared, Stop leaves background work running. Rewrite each to assert the background task is still `running` after Stop and ends after `stopBackground()` / `session.stopBackground`. Keep their names honest.

- [ ] **Step 6: Add the RPC methods** in `schemas.js` and `handlers.js`, and the integration test:

```js
test('Stop background work ends a conversation\'s background tasks and keeps its process', async () => {
  const { client, events, session, runTo, starts } = await boot();
  await runTo('bg', 'tasks 2 20000');
  await waitFor(() => events.some(e => e.type === 'session.activity' && e.payload.state === 'background'));
  expect(await client.call('session.stopBackground', { sessionId: session.id })).toEqual({ requested: 2, stopped: 2, escalated: false });
  await waitFor(() => events.some(e => e.type === 'session.activity' && e.payload.state === 'idle'));
  expect(starts()).toHaveLength(1);
  expect(alive(starts()[0])).toBe(true);
});
```

- [ ] **Step 7: Run to verify everything passes.** Run: `bun test apps/engine/test/claude-link.test.js tests/integration/claude-stream.test.js`. Expected: PASS.

- [ ] **Step 8: Commit.**

```bash
git add apps/engine/src/agents/claude-link.js apps/engine/src/agents/claude-stream.js packages/protocol/src/schemas.js apps/engine/src/rpc/handlers.js tests/fixtures/fake-claude.js apps/engine/test/claude-link.test.js tests/integration/claude-stream.test.js CHANGELOG.md
git commit -m "Let the person stop one background task or all of them; Stop itself now spares background work"
```

---

### Task 4: Claude's user dialogs reach Jolo

**Files:**
- Create: `apps/engine/src/agents/claude-dialogs.js` (`DIALOG_KINDS`, payload/response helpers), `apps/engine/src/dialogs/service.js` (`createDialogService`), `apps/engine/src/storage/dialogs.js` (`DialogRepository`), migration in `apps/engine/src/storage/schema/` following the latest migration's pattern (`dialogs` table: `id, session_id, run_id, request_id, kind, payload, response, state, created_at, resolved_at`)
- Modify: `apps/engine/src/agents/claude-stream.js:285-300` (`onControlRequest` branch for `request_user_dialog`), `:561` (`initialize.supportedDialogKinds`), `packages/protocol/src/schemas.js` (events `dialog.requested`, `dialog.resolved`; RPC `dialog.resolve`), `apps/engine/src/rpc/handlers.js`, `apps/engine/src/engine.js` (wire the service), `apps/engine/src/storage/index.js` (repository, `appendEvent` on changes)
- Modify: `tests/fixtures/fake-claude.js` (scenario `ask-user <question>`)
- Test: `apps/engine/test/dialogs.test.js` (new), `tests/integration/claude-stream.test.js`, `CHANGELOG.md`
- Record: `docs/superpowers/specs/claude-dialogs.md` (probe results)

**Interfaces:**
- Produces `DIALOG_KINDS = ['ask_user_question']` (grow per probe; each kind listed only once its request and response shapes are recorded in `claude-dialogs.md`).
- Produces storage rows `Dialog = { id, sessionId, runId, requestId, kind, payload: object, response: object | null, state: 'requested' | 'answered' | 'cancelled', createdAt, resolvedAt }`.
- Produces events `dialog.requested { dialogId, runId, kind, payload, toolUseId: string | null }` (sessionId set) and `dialog.resolved { dialogId, state }`.
- Produces RPC `dialog.resolve { dialogId, response: object }` → `{ dialogId, state: 'answered' }`; a second resolve answers `conflict`.
- Produces `dialogs.request({ run, requestId, kind, payload, toolUseId })` → `Dialog`, `dialogs.waitForResolution(dialogId, signal)` → `Dialog` (rejects when the signal aborts), `dialogs.cancel(dialogId)`.
- Run state while a dialog is open: `awaiting_permission` (my call: reuse the existing waiting state; the UI tells dialogs from permissions by the event type).

- [ ] **Step 1: Probe the real shapes once** (budget cap 1 USD). Script after `jolo-delegated-child-guard.e2e/claude-host-controls-probe.py` in the owner's workspace: start `claude --print --input-format stream-json --output-format stream-json --max-budget-usd 1`, send `initialize` with `supportedDialogKinds: ["ask_user_question"]`, then the prompt `Use the AskUserQuestion tool to ask me whether I prefer tea or coffee, then reply with my answer.`; capture the `request_user_dialog` message (kind, payload), answer it with the response shape the payload implies, record what Claude accepted, and also record what a declined/cancelled answer looks like (send a second dialog and answer with `{ behavior: "cancelled" }`; note whether Claude accepts it). Write both shapes into `docs/superpowers/specs/claude-dialogs.md`. If the probe shows a different kind name for AskUserQuestion, use that name in `DIALOG_KINDS`.

- [ ] **Step 2: Teach the fixture.** Scenario `ask-user <question>`: emits `control_request` `{ subtype: "request_user_dialog", dialog_kind: "ask_user_question", payload: <recorded shape with the question> }`, waits for its `control_response`, then says `You answered: <answer text from the recorded response shape>`; a cancelled response makes it say `No answer.`.

- [ ] **Step 3: Write the failing unit test** `apps/engine/test/dialogs.test.js`: `createDialogService({ storage })` → `request(...)` emits `dialog.requested`, `waitForResolution` resolves after `resolve(id, response)` with `state: 'answered'` and emits `dialog.resolved`; a second `resolve` throws `ProtocolError` `conflict`; `waitForResolution` with an aborted signal rejects and marks the dialog `cancelled`.

- [ ] **Step 4: Write the failing integration tests** in `claude-stream.test.js`:

```js
test('a question Claude asks the person reaches Jolo as a dialog and the answer goes back', async () => {
  const { client, events, session, messagesOf, text } = await boot();
  const { run } = await client.call('run.start', { sessionId: session.id, requestId: 'ask', prompt: 'ask-user tea or coffee?' });
  const asked = await waitFor(() => events.find(e => e.type === 'dialog.requested' && e.runId === run.id));
  expect(asked.payload.kind).toBe('ask_user_question');
  expect((await client.call('run.snapshot', { runId: run.id })).run.state).toBe('awaiting_permission');
  await client.call('dialog.resolve', { dialogId: asked.payload.dialogId, response: <recorded answer shape for 'coffee'> });
  await waitFor(() => events.some(e => e.type === 'run.state' && e.runId === run.id && e.payload.state === 'completed'));
  expect(await text((await messagesOf(run.id)).at(-1))).toBe('You answered: coffee');
});

test('stopping a run with a dialog open cancels the dialog and answers Claude exactly once', async () => {
  const { client, events, session } = await boot();
  const { run } = await client.call('run.start', { sessionId: session.id, requestId: 'ask-stop', prompt: 'ask-user tea or coffee?' });
  const asked = await waitFor(() => events.find(e => e.type === 'dialog.requested' && e.runId === run.id));
  await client.call('run.cancel', { runId: run.id });
  await waitFor(() => events.some(e => e.type === 'dialog.resolved' && e.payload.dialogId === asked.payload.dialogId && e.payload.state === 'cancelled'));
  await expect(client.call('dialog.resolve', { dialogId: asked.payload.dialogId, response: {} })).rejects.toMatchObject({ code: 'conflict' });
});
```

- [ ] **Step 5: Run to verify they fail.** Run: `bun test apps/engine/test/dialogs.test.js tests/integration/claude-stream.test.js -t "dialog"`. Expected: FAIL (module missing; Claude's request answered with "Jolo does not handle").

- [ ] **Step 6: Implement.** Repository + migration (bump the schema version as the last migration did; `storage/db.js` compares the expected schema). Service with an in-memory waiter map keyed by dialog id, resolved by `resolve`/`cancel`. In `onControlRequest`: when `request.subtype === 'request_user_dialog'`, create the dialog, `ctx.transition('awaiting_permission')`, `await dialogs.waitForResolution(id, withdrawn.signal)`; on answer write `control_response` success with the recorded response shape; on cancel write the recorded cancelled shape; one write per request, guarded by a `answered` flag per request id. `initialize` adds `supportedDialogKinds: DIALOG_KINDS`. Unknown kinds (not in `DIALOG_KINDS`) are answered cancelled at once and logged at `warn`.

- [ ] **Step 7: Run to verify it passes.** Run the two test files and `bun test apps/engine/test`. Expected: PASS.

- [ ] **Step 8: Commit.**

```bash
git add apps/engine/src/agents/claude-dialogs.js apps/engine/src/dialogs apps/engine/src/storage apps/engine/src/agents/claude-stream.js apps/engine/src/engine.js apps/engine/src/rpc/handlers.js packages/protocol/src/schemas.js tests/fixtures/fake-claude.js apps/engine/test/dialogs.test.js tests/integration/claude-stream.test.js docs/superpowers/specs/claude-dialogs.md CHANGELOG.md
git commit -m "Show Claude's questions to the person as dialogs and send their answers back"
```

---

### Task 5: A delegation is done when the child is idle, and waiting costs nothing

**Files:**
- Modify: `apps/engine/src/delegation/index.js` (`createDelegationService({ ..., links, settings })`, `view`, `status`), `apps/engine/src/tools/delegation.js` (descriptions, `waitMs` max, `deadlineMs`), `packages/protocol/src/schemas.js` (`DelegationSchema` gains `activity`, `done`, `partial`; `DelegationSettingsSchema`, patch, `SettingsSchema.delegation`), `apps/engine/src/settings.js` (`delegation` group), `apps/engine/src/engine.js:151` (pass `links: hostedLinks, settings: settingsService`)
- Test: `apps/engine/test/delegations.test.js`, `tests/integration/claude-stream.test.js`, `CHANGELOG.md`

**Interfaces:**
- Consumes `links.get(sessionId)?.activity` and `session.activity` events (Tasks 1–2).
- Produces `DelegationSchema` fields: `activity: 'idle' | 'working' | 'background' | null` (null: no live process), `done: boolean` (= run ended AND activity is not `working`/`background`), `partial: boolean` (= output present but not done).
- Produces `DelegationSettingsSchema = { maxWaitMs: int 1_000..3_600_000 default 600_000 }` under `settings.delegation`, with the matching patch schema and `settings.update({ delegation })`.
- `status(runId, { delegationId, waitMs })` waits `min(waitMs, settings.delegation.maxWaitMs)` until `done`, or a newer completed run with text exists in the child session, or a `dialog.requested` / `permission.requested` event arrives for the child session; wakes on `runs.settled` for any run of the child session and on `session.activity` for it.
- `output` is the text of the latest completed run in the child session that has assistant text (so the follow-up turn after background work is what the parent reads).
- Tool text (`delegation_status`): "Read a child task's state and latest answer. A child may keep working after its first answer: `done` is true only when its process is idle. Set `waitMs` (up to the configured maximum, default 600000) to wait inside Jolo without polling. If `activity` is `background`, the child is still working; do not report its `output` as final while `partial` is true."

- [ ] **Step 1: Write the failing unit tests** in `delegations.test.js` (extend `fixture()` with a `links` stub `{ activities: new Map(), get(id) { const a = this.activities.get(id); return a ? { activity: a, working: a.state !== 'idle' } : null; } }` and a way to emit `session.activity` through `storage.appendEvent`):

```js
test('a child whose process still has background work is not done, and its output is partial', async () => {
  const f = fixture();
  const { delegation } = await f.service.start(f.parent.id, { modelAlias: 'm1', prompt: 'model', title: 'Child', requestId: 'r1' });
  await f.settled(delegation.runId);
  f.links.activities.set(delegation.sessionId, { state: 'background', tasks: [], truncated: false, updatedAt: new Date().toISOString() });
  const working = await f.service.status(f.parent.id, { delegationId: delegation.id });
  expect(working.delegation).toMatchObject({ state: 'completed', activity: 'background', done: false, partial: true });
  const waiting = f.service.status(f.parent.id, { delegationId: delegation.id, waitMs: 5000 });
  f.links.activities.set(delegation.sessionId, { state: 'idle', tasks: [], truncated: false, updatedAt: new Date().toISOString() });
  f.storage.appendEvent({ sessionId: delegation.sessionId, type: 'session.activity', payload: f.links.activities.get(delegation.sessionId) });
  expect((await waiting).delegation).toMatchObject({ done: true, partial: false });
});

test('waitMs is capped by the delegation.maxWaitMs setting', async () => {
  const f = fixture({ settings: { delegation: { maxWaitMs: 1000 } } });
  const { delegation } = await f.service.start(f.parent.id, { modelAlias: 'm1', prompt: 'model', title: 'Child', requestId: 'r2' });
  f.links.activities.set(delegation.sessionId, { state: 'background', tasks: [], truncated: false, updatedAt: new Date().toISOString() });
  const started = Date.now();
  await f.service.status(f.parent.id, { delegationId: delegation.id, waitMs: 60_000 });
  expect(Date.now() - started).toBeLessThan(2500);
});
```

- [ ] **Step 2: Write the failing integration test** in `claude-stream.test.js`, using the fake parent pattern from the owner's `jolo-delegated-child-guard.e2e/run.js` (a `parent.json` manifest pointing at the fixture, a parent run held on a permission, `delegation.call` RPC) — fold that helper into the test file as `bootWithParent()`:

```js
test('a delegated child that keeps working after its first answer is done only when its process is idle, and the follow-up is its answer', async () => {
  const { client, events, parent } = await bootWithParent();
  const { delegation } = await client.call('delegation.call', { runId: parent.id, name: 'delegate_task', arguments: { modelAlias: 'm1', title: 'bg child', prompt: 'background 1500 Follow-up: all good', requestId: 'c1' } });
  await waitFor(() => events.some(e => e.type === 'run.state' && e.runId === delegation.runId && e.payload.state === 'completed'));
  const early = await client.call('delegation.call', { runId: parent.id, name: 'delegation_status', arguments: { delegationId: delegation.id } });
  expect(early.delegation).toMatchObject({ done: false, partial: true, activity: 'background', output: 'Background work started.' });
  const late = await client.call('delegation.call', { runId: parent.id, name: 'delegation_status', arguments: { delegationId: delegation.id, waitMs: 10_000 } });
  expect(late.delegation).toMatchObject({ done: true, partial: false, output: 'Follow-up: all good' });
});
```

- [ ] **Step 3: Run to verify they fail.** Run: `bun test apps/engine/test/delegations.test.js tests/integration/claude-stream.test.js -t "done only when|not done|maxWaitMs"`. Expected: FAIL (`done` undefined; `waitMs` rejected above 25000).

- [ ] **Step 4: Implement.** Settings group and schemas; `delegation/index.js` as in Interfaces (`view` gains the three fields; `status` builds one promise that resolves on the first of: `runs.settled` for a run of the child session, a `session.activity` event for it with `state: 'idle'`, a `dialog.requested`/`permission.requested` event for it, the timer). `tools/delegation.js`: `waitMs` max `3_600_000`, `deadlineMs` for `delegation_status` `3_600_000`; verify in `apps/engine/src/tools/registry.js` / the dispatcher that the bridge path does not apply a shorter default deadline to RPC-executed delegation tools (fix if it does). Update `delegationInstructions` text in `delegation/index.js:161` to say a child may keep working after its first answer and to wait until `done`.

- [ ] **Step 5: Run to verify it passes.** Run the two files, then `bun test apps/engine/test tests/integration/codex-app-server.test.js` (the Codex delegation test must still pass). Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add apps/engine/src/delegation/index.js apps/engine/src/tools/delegation.js packages/protocol/src/schemas.js apps/engine/src/settings.js apps/engine/src/engine.js apps/engine/test/delegations.test.js tests/integration/claude-stream.test.js CHANGELOG.md
git commit -m "Call a delegated child done only when its process is idle, and wait for it inside the engine"
```

---

### Task 6: Closing a process stops its tasks first

**Files:**
- Modify: `apps/engine/src/agents/claude-link.js:408-420` (`close`)
- Test: `apps/engine/test/claude-link.test.js`

**Interfaces:**
- Consumes `stopBackground()` from Task 3.
- `close({ graceful: true })` with running tasks: `await stopBackground()` (bounded by `STOP_TASK_GRACE_MS`), then EOF and graceful terminate as today. `graceful: false` is unchanged.

- [ ] **Step 1: Write the failing test:**

```js
test('closing a process with background work stops the tasks first, then the process leaves', async () => {
  const registry = createHostedLinks({ log });
  const link = open(registry);
  await turn(link, 'tasks 2 20000', { init: true });
  await waitFor(() => link.activity.tasks.length === 2);
  await link.close({ reason: 'test' });
  expect(link.activity.tasks.map(t => t.status)).toEqual(['stopped', 'stopped']);
  expect(link.alive).toBe(false);
});
```

- [ ] **Step 2: Run to verify it fails.** Run: `bun test apps/engine/test/claude-link.test.js -t "stops the tasks first"`. Expected: FAIL, statuses are `failed` (process ended with tasks running).

- [ ] **Step 3: Implement** in `close`: `if (alive && graceful && running()) await stopBackground();` before `child.end()`.

- [ ] **Step 4: Run to verify it passes.** Run: `bun test apps/engine/test/claude-link.test.js`. Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/engine/src/agents/claude-link.js apps/engine/test/claude-link.test.js
git commit -m "Stop a process's background tasks before closing it"
```

---

### Task 7: A plan task finishes when its process is idle

**Files:**
- Modify: `apps/engine/src/orchestrator/index.js:164-180` (`onRunSettled`), `apps/engine/src/engine.js:155` (`createOrchestrator({ ..., links: hostedLinks })`)
- Test: the orchestrator's existing test file under `apps/engine/test/` (locate with `ls apps/engine/test | grep -i -E "orchestr|plan"`), extended with a `links` stub as in Task 5

**Interfaces:**
- Consumes `links.get(sessionId)?.working` and `session.activity` events.
- When a plan task's run settles `completed` while its session's process is `working`/`background`, the task stays `running` with `summary: 'finishing background work'`, and the settle handling runs once the session's activity reaches `idle` (or the process ends). Failed/cancelled runs settle at once as today.

- [ ] **Step 1: Write the failing test:** start a plan task whose run completes while the stub reports `state: 'background'`; assert the task is still `running` with that summary; emit `session.activity` idle; assert the task becomes `done`.
- [ ] **Step 2: Run to verify it fails.** Expected: task is `done` immediately.
- [ ] **Step 3: Implement:** in `onRunSettled`, when `run.state === 'completed'` and `links?.get(run.sessionId)?.working`, record the deferral (in memory, keyed by run id) and subscribe once to `storage.events` for `session.activity` with `state: 'idle'` for that session, then call the original settle path.
- [ ] **Step 4: Run to verify it passes.** Run the orchestrator test file and `bun test apps/engine/test`.
- [ ] **Step 5: Commit.**

```bash
git add apps/engine/src/orchestrator/index.js apps/engine/src/engine.js apps/engine/test/<orchestrator test>.js CHANGELOG.md
git commit -m "Finish a plan task only when its process has no background work left"
```

---

### Task 8: Progress ticks travel on a transient channel; only state and task changes are durable

Added by controller ruling after Task 2's review: durable `session.activity` events at up to 4 per second per busy process would churn the bounded reconnect feed that run and message events share. Replay only needs the coarse picture; the live UI needs the ticks.

**Files:**
- Modify: `apps/engine/src/agents/claude-link.js` (coalescer carries a `reason`), `apps/engine/src/engine.js` (`onActivity` routes by reason), `apps/engine/src/runs/service.js:31` (or a new emitter passed to the server) and `apps/engine/src/rpc/server.js:203-212` (forward `activity` notifications like `preview`), `packages/protocol/src/schemas.js:206` (`NotificationSchema.method` gains `"activity"`; `ActivityNotificationSchema`; `parseActivity`), `packages/client/src/index.js:55-58,145` (`onActivity` handler)
- Test: `apps/engine/test/claude-link.test.js`, `tests/integration/claude-stream.test.js`, `packages/protocol/test/protocol.test.js`

**Interfaces:**
- Consumes `link.activity`, `onActivity`, `activityPayload` from Tasks 1–2.
- Produces `onActivity(sessionId, activity, reason)` with `reason: 'state' | 'tasks' | 'progress'`: `state` when `activity.state` changed, `tasks` when a task started or ended (status changed) since the last report, `progress` when only usage/phase/description changed. A coalesced flush carries the strongest reason seen in its window (`state` > `tasks` > `progress`).
- Engine: `state` and `tasks` → `storage.appendEvent({ sessionId, type: 'session.activity', payload })` as today; `progress` → transient notification `{ method: 'activity', params: { sessionId, activity: activityPayload(...) } }` to subscribers of that session (same filter as `preview`), never stored.
- Produces client `subscribe({...}, { onActivity })` delivering parsed `{ sessionId, activity }`.
- `session.activity` RPC (Task 2) is unchanged and remains the way a late client gets the current ticks.

- [ ] **Step 1: Write the failing unit test** in `claude-link.test.js`: with `tasks 2 400`, collect `onActivity` calls with their reason; assert the sequence contains `state` (idle→background), `progress` (usage arrived) and `tasks`/`state` at the end, and that no `progress` report coincides with a state change.
- [ ] **Step 2: Write the failing integration test** in `claude-stream.test.js`: subscribe with `onActivity`; run `tasks 2 400`; assert at least one transient activity notification with task usage arrived, and that the durable `session.activity` events for the run number at most `2 + 2 × tasks` (one per state change and per task start/end), with none carrying a usage-only change.
- [ ] **Step 3: Run both; expected FAIL** (`reason` undefined; no `activity` notification method).
- [ ] **Step 4: Implement** per Interfaces; the protocol test asserts `NotificationSchema` accepts `method: "activity"` and `parseActivity` validates `{ sessionId, activity }`.
- [ ] **Step 5: Run** the three files, `bun test packages apps/engine/test`, and `TMPDIR=/tmp/jt bun test tests/integration/claude-stream.test.js`. Expected PASS (Task 2's "fewer than 12 events" test still holds and may be tightened to the new bound).
- [ ] **Step 6: Commit.**

```bash
git add apps/engine/src/agents/claude-link.js apps/engine/src/engine.js apps/engine/src/runs/service.js apps/engine/src/rpc/server.js packages/protocol/src/schemas.js packages/client/src/index.js apps/engine/test/claude-link.test.js tests/integration/claude-stream.test.js packages/protocol/test/protocol.test.js CHANGELOG.md
git commit -m "Send activity progress ticks as transient notifications; keep only state and task changes durable"
```

---

### Final: whole-branch checks

- [ ] Run the full suite: `TMPDIR=/private/var/folders/<short>/T/ bun test tests packages apps`. Expected: the only failures are the six that fail on `upstream/main` without this branch (packaging needs Bun 1.3.12; tgrep MCP; two TUI signal tests; guest credential; run dedup). Anything else is this branch's.
- [ ] Run `bun scripts/typecheck.js`. Expected: `programs type-check cleanly`.
- [ ] Real-binary e2e (owner's machine, usage capped): rerun `jolo-delegated-child-guard.e2e/run.js` against this branch's engine with the child prompt `Use your Bash tool with run_in_background set to true to start exactly this command: sleep 60 . Then reply with exactly: started` and assert: `delegation_status` reports `done: false, activity: 'background'` after `started`, `session.stopBackground` on the child session returns `stopped: 1`, then `done: true`; the child's process is still alive until the idle timeout. Record the output under `jolo-delegated-child-guard.e2e/`.
- [ ] Open the pull request against `jolo-build/jolo` `main` from `feat/native-claude-host` with the spec and this plan linked.
