# Native Claude Host, Plan 2: Desktop UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person using Jolo's desktop app sees, and can do, what they would see and do inside Claude Code's own REPL for the same events: what a conversation's Claude process is doing in the background, a stop for all of it, for one task, and for a process that ignores stops, Claude's questions and plan approvals as answerable cards, and what a delegated child is up to.

**Architecture:** Plan 1 made the engine publish a process's activity (`session.activity` events and transient `activity` ticks), expose `session.stopBackground` / `session.stopTask`, and turn Claude's AskUserQuestion / ExitPlanMode into `dialog.requested` records answered by `dialog.resolve` / `dialog.dismiss`. This plan carries those through the desktop's existing layers without new frameworks: the client's reconnect wrapper gains the `onActivity` hook, the Electron main process relays activity ticks like previews, `use-engine.js` keeps one activity snapshot and one pending-dialog queue per selected conversation, and the renderer grows an activity line above the composer, an "Activity" context panel with workflow cards, dialog modals beside the permission modal, and delegation lines in the transcript. Three small engine additions carry the UI: `session.page` lists open dialogs for a late-joining client, `delegation_status` reports why a wait ended, and `session.closeProcess` is the force-stop for a process whose tasks ignore `stop_task`.

**Tech Stack:** Bun 1.4.3, plain JavaScript (ESM) and JSX, React 19, Electron 44, zod schemas in `packages/protocol`, `bun test` (components rendered with `renderToStaticMarkup`), the desktop smoke harness (`apps/desktop/smoke`), the fake Claude fixture (`tests/fixtures/fake-claude.js`).

**Spec:** `docs/superpowers/specs/2026-10-23-native-claude-hosting-design.md` (sections 2, 5.2, 5.3, 5.4, 5.5, 8, 10), scoped by `docs/superpowers/plans/2026-10-23-native-claude-host-engine-handoff.md` ("Plan 2 (Desktop UI) must own"). Protocol facts: `docs/superpowers/specs/claude-dialogs.md`, `docs/superpowers/specs/claude-stop-semantics.md`.

## Design decisions (brainstormed from the spec, 2026-10-24)

The spec was approved with its §8 defaults and this session had no owner in the loop, so every UI-level choice below was answered from the spec and the existing desktop code. Each is a decision the implementer should follow, not reopen; the owner can overturn any of them on review.

- **D1 Where the activity line lives.** Above the composer, where `resume-note` and the permission notice already sit (spec §5.2 "header or footer"), and only while the conversation's process has running tasks. While the turn itself runs, the transcript's own run note already says `Working`, so the line is not duplicated for that. Wording: `Background work: 3 tasks · 412k tokens · 06:12`; with an open workflow run: `Workflow <name>: <phase> 37/120 · 1.2M tokens` (phase = the phase of the most recently started running agent of the run, counts = finished agents / all agents of the run; without phases: `3 agents`). Tokens are shown only when at least one task reported usage, never as 0 (spec §2 anti-goal). The elapsed time is now minus the earliest running task's `startedAt`, ticked locally once a second. The line holds `Stop background work` and opens the Activity panel when its text is clicked. Revised after the whole-branch review (2026-10-24): a running task counts as background work when it is backgrounded or when the process is in `background` (the turn ended), and the workflow form reads `Workflow <name> · <elapsed>[ · <tokens>][ · N other tasks]`; the stream carries no agent counts or phases. Corrected by the probe of 2026-10-24 (see D3): once Claude reports a workflow's agents the form reads `Workflow <name>: <phase> <done>/<total> · <elapsed>[ · <tokens>][ · N other tasks]`.
- **D2 The task panel is a context panel named Activity.** It joins `CONTEXT_PANELS` (`['activity', 'Activity', 'agents']`), with the detail `N tasks` only while tasks run, and is offered in standalone chats too. The spec's "the existing child-tasks fold grows into this" is not followed literally: the child-tasks popover is 292 px wide and lists conversations, not tasks; the panel pattern (`ChecksPanel`, `PlanPane`) is the existing home for a list with actions. The panel lists workflow cards (tasks that share a non-null `runId`) first, then standalone tasks (kind `Agent` when `subagentType` is set, else `Task`; Jolo's ledger does not carry `task_type`, so a command is not told apart from another backgrounded tool call), running before finished, newest first within each; `truncated: true` adds one line "Older finished tasks are not listed". Revised after the whole-branch review: tasks are not grouped by `runId` (a per-task run id); a workflow is one task with `taskType: 'local_workflow'` and `workflowName`, and kinds are `Workflow` / `Command` / `Agent` / `Task` from `taskType`.
- **D3 Workflow card.** Title: `meta.name` parsed from the `script` input of a `Workflow` tool call (`export const meta = { name: '...' }`), or the basename of `scriptPath`. The call is found for a run in this order, all best effort and none a protocol change: (1) a projection tool call (`projection.tools`, fed by `tool.started`) named `Workflow` whose `callId` equals a `toolUseId` of the run's tasks, parsed from its `preview`; (2) a `Workflow` tool message whose text contains the run's `runId` (the tool answers at once with the run's id); (3) the one `Workflow` message when the transcript has exactly one and exactly one run is open; (4) else the run's first task description. The Workflow tool returns at once, so "the call still streaming" is never a usable key; spec §9 leaves the exact `task_started` ids to a probe this session does not spend. Kind `Workflow`, `N agents`, elapsed (frozen at the last task's `endedAt` once none runs), tokens = sum of the run's `usage.totalTokens` (shown only when known), status dots: one per distinct phase when any task of the run has a phase (grey = no agent of that phase ended, amber = one running, green = all ended completed, red = any failed/stopped), else one per agent by status. A chevron opens the run's agents as rows (description, phase, status, elapsed, tokens, Stop). Actions: `Stop run` (= `session.stopTask` for every running task of the run), Stop per agent. Not built: pause/resume (Claude Code exposes no such control to a host), `get_task_output` (no engine RPC yet; later plan), `background_tasks` (same). A `Large` badge appears when the run's agents exceed `LARGE_RUN_AGENTS = 25`, a renderer constant until Plan 3 makes it a setting (spec §5.2, Claude Code's own threshold).

  Revised after the whole-branch review (2026-10-24): on Claude Code 2.1.304 `run_id` is each task's own run id, not a workflow's id (the owner's real-binary run gave a plain `sleep 60` background command `run_id: "0mvll0x40-1842e72b"`), so grouping by `runId` rendered every background command as a one-agent workflow card with `Stop run`. A workflow is ONE task: its `task_started` carries `task_type: "local_workflow"` and `workflow_name`, and its agents have no task ids of their own; a background command is `local_bash`, a subagent `local_agent` (with `subagent_type`); the wire `task_updated` patch has no `workflow_phase`; and `is_backgrounded` is set only for `local_agent` and `local_bash` (a later move to the background arrives as `task_updated.patch.is_backgrounded`), so a task counts as background unless the flag is `false`, as Claude Code's own client reads it. The engine records `taskType` and `workflowName` (optional, nullable `TaskRecordSchema` fields). The card is that one task: title `workflowName ?? description`, kind `Workflow`, status, elapsed (frozen at `endedAt`), tokens when known, and `Stop` while it runs; no agent count, phase dots, `Large` badge, `Stop run`, agent rows or transcript name lookup (`parseWorkflowName`, `workflowNames`), since none of that is on the wire. While a workflow runs the line reads `Workflow <name> · <elapsed>[ · <tokens>][ · N other tasks]`; task rows name their kind (`Command`, `Agent`, `Task`).
  Revised again after the probe of 2026-10-24 (`docs/superpowers/specs/claude-workflow-events.md`, Claude Code 2.1.304): a workflow is still one task, but every `task_progress` of it carries `workflow_progress`, each phase (`workflow_phase`: index, title) and each agent (`workflow_agent`: index, label, phaseIndex, state `start` | `done`, tokens, ...), and names an agent in `description` (`<phase>: <label>`). The engine keeps a bounded summary of it, `TaskRecord.workflow = { phases: [{ title, agents, done, running, failed }] (at most 100, in index order), agents: { total, running, done, failed }, current }` (`current` = the agent the last progress named) (optional and nullable in `TaskRecordSchema`; an agent in a state other than `start` or `done` counts as failed until a probe settles that vocabulary); the record's `description` stays the one `task_started` gave. The card now shows agents and phases from it: `Workflow · <status> · N agents · <elapsed>[ · <tokens>]`, a status dot per phase (pending border only, running `--highlight`, done `--green`, failed `--red`, stopped a muted fill; a phase the last report left running on a workflow that ended takes the workflow's own end word, `stopped`, `failed` or `done`, in its dot and tooltip, and the dots' tooltip names `current` only while the workflow runs), a `Large` badge past `LARGE_RUN_AGENTS = 25` (restored; Plan 3 makes it a setting), and a `Phases` disclosure listing `<title> · <done>/<agents>`; the line reads `Workflow <name>: <phase> <done>/<total> · <elapsed>[ · <tokens>][ · N other tasks]` (phase = the first with running agents, else the last with a done or failed agent, else the first). Until a workflow reports its agents (and from an engine from before them), card and line read as above: no count is ever inferred. A token count of 0 (Claude's first tick says `total_tokens: 0` before any agent reported spend) is left out of the line, the card and task rows, as unknown usage is.
- **D4 Activity data flow.** The main process subscribes with `onActivity` and relays ticks as relay kind `activity`, dropped like previews when the renderer is behind (transient; the durable `session.activity` event and the `session.activity` RPC carry the truth). The renderer partitions them by session as it does previews. `use-engine.js` keeps one `activity` for the selected conversation: read with `session.activity` when the conversation is selected (an older engine's `unknown_method` leaves it null), replaced whole by each durable `session.activity` event and each tick for that session, cleared when the conversation changes.
- **D5 Dialog cards are modals.** A question from Claude blocks its run exactly as a permission request does, and the REPL blocks input on it, so the dialog card is a `Modal` beside `PermissionDialog`, one modal at a time: a pending permission wins over a pending dialog; the oldest dialog first. AskUserQuestion: one block per question (header as eyebrow, the question, options as radio buttons, or checkboxes when `multiSelect`, each with its description as a hint) plus an "Other" free-text option per question, as the REPL offers; the answer is `{ answers: { [question]: label } }` where a multi-select answer is the chosen labels joined with `", "` and a free-text answer is the typed text (Claude Code's own encoding; not probed live, marked as this plan's call). The primary button is disabled until every question has an answer. `Dismiss` sends `dialog.dismiss` with `The user dismissed the question without answering.` (the probe's wording). ExitPlanMode: the plan as Markdown in a scrollable card, `Approve plan` → `dialog.resolve { response: {} }`, `Send back` with an optional feedback field → `dialog.dismiss { message: feedback || 'The user rejected the plan.' }`. Any other tool with `requires_user_interaction` (a future dialog tool): a generic card with the input as JSON, `Allow` → `dialog.resolve { response: {} }`, `Dismiss`. A truncated input (`{ truncated: true, preview }`) shows the preview in a code block and offers `Dismiss` only, with the note that the question was too long to show.
- **D6 Inactive panes and precedence.** `PermissionNotice` gains `title` and `icon` props so the same quiet line says `Claude has a question` for a dialog in a pane that is not active; `Review` focuses the pane as it does for permissions. Overlay bookkeeping (`setOverlay`) counts a pending dialog like a pending permission.
- **D7 Late joiners.** `session.page` returns `pendingDialogs` (optional, same shape as the `dialog.requested` payload, input truncated by the same rule). The renderer's `PendingDialogs` mirrors `PendingPermissions`: seeded from the page with its cursor, fed by `dialog.requested` / `dialog.resolved` events and cleared by a terminal `run.state` of the dialog's run; events seen during the load are replayed after the seed.
- **D8 Notifications.** The main process's attention service announces `dialog.requested` the way it announces an approval: `<project> needs your answer`, body = the first question's text, or `Plan ready for your review` for ExitPlanMode, or the tool's name; dismissed on `dialog.resolved` and on the run ending; a renderer that shows the dialog on screen suppresses the in-app notice as it does for approvals. The dock badge already counts the run's `needs_you`.
- **D9 Delegation UI.** Two places. In the parent's transcript, a `mcp__jolo__delegate_task`, `delegation_status` or `delegation_cancel` tool call renders as one line instead of a raw JSON tool block: `Child <title> · <state words> · <activity words>[ · partial answer][ · woke: <reason words>]`, with an `Open` button that selects the child conversation; the raw call stays behind a disclosure. The engine shows at most 600 characters of a tool result (`RESULT_DISPLAY_MAX` in `apps/engine/src/agents/hosted.js`), so the result JSON is usually cut off: the line is read with a tolerant field extractor (as `subagent.js` reads a cut-off head) for `id`, `sessionId`, `title`, `state`, `activity`, `done`, `partial`, `wakeReason`, which Task 3 keeps ahead of `output` in the result's key order, and the live `delegation.list` row with the same `id` (or, for `delegate_task` while its result is still cut off, the row whose `title` equals the call's `title` argument) overrides state, activity, done and partial when present. In the task header's child-tasks popover, each child row shows the same state and activity words, read from `delegation.list` (allow-listed for the renderer) when the popover opens and refreshed on `run.state` / `session.activity` events of a child.
- **D10 Wake reason (engine, the handoff's named spot).** `DelegationSchema` gains optional `wakeReason`: `done` (the child is done), `answer` (a newer answer), `asking` (a run of the child waits on the person), `parent_stopped`, `stopped` (the waiting call itself was stopped), `timeout` (`waitMs` elapsed); absent when no wait was made. `delegation_status`'s description names it so the parent model can say why it woke.
- **D11 Force-stop (engine, one addition beyond the handoff's two named spots).** Spec §5.3's "second press escalates to interrupt" cannot end a background task under `perTaskStopAffordance` (handoff), so the force-stop that the handoff assigns to Plan 2 needs a way to close the process: `session.closeProcess { sessionId } → { closing: boolean }`, which starts the hosted link's graceful close (`stop_task` → EOF → SIGTERM after grace → SIGKILL, spec §5.3's order) and returns without waiting. The UI offers it only after a `Stop background work` left tasks running (its result had `stopped < requested` or `escalated: true` and the next activity still shows running tasks), behind a confirmation that says the process is closed, that any answer in progress ends with it (the close sends EOF after the stop attempt), and that the conversation continues with a fresh process on the next message. Recorded as a decision taken without the owner because the scoped feature cannot exist without it; the handler is six lines and additive.
- **D12 Out of scope here.** The terminal client (spec §8.4: Desktop first); `get_task_output` and `background_tasks`; `away_summary` as a system message (Phase 3); accounting (§5.7); every cap and setting (Plan 3); Codex/Antigravity children (spec non-goal).
- **D13 Look.** Follow `.resume-note`, `.plan-card`, `.checks-panel`; nothing is permanently lit: the line, the panel detail and the card badges exist only while there is something running or something to answer.
- **D14 Proof.** Unit tests per module, component tests by static markup, and one new desktop smoke (`--background-work`) against the fake Claude: tasks appear on the line and in the panel, `Stop background work` ends them, an AskUserQuestion is answered through the modal, an ExitPlanMode plan is approved. The default smoke stays as it is.

## Global Constraints

- Owner rules: no over-engineering; nothing hardcoded (the one renderer constant, `LARGE_RUN_AGENTS = 25`, is exported and named for Plan 3); secure by default (every new renderer call is in the main process allow-list; the renderer never reaches Electron).
- Only these areas change: `apps/desktop`, `packages/client`, `packages/protocol` (additive only: new optional fields, new methods, nothing renamed or removed), `tests`, `docs`, `CHANGELOG.md`, and in the engine exactly `session.page` pending dialogs, the delegation wake reason, and `session.closeProcess` (D11).
- No new UI framework, no new dependency. Existing components and `styles.css` conventions; one new CSS block per new component, next to its neighbours.
- Every behavior lands red → green: write the test, run it and watch it fail, implement, run it and watch it pass, run the touched files' suites, commit. Commit message style: imperative, one line, as in `git log`.
- Tests: `bun test <file>` from the repo root; integration tests with `mkdir -p /tmp/jt; TMPDIR=/tmp/jt bun test tests/integration/<file>` (long socket paths break them); desktop smokes with `bun apps/desktop/scripts/build.js && bun apps/desktop/scripts/smoke.js [--flag]`.
- Copy: sentence case, no exclamation marks, the words the rest of the desktop uses (`task`, `conversation`, `Stop`).
- Spec §2 anti-goals hold in the UI: never show a token count of 0 for unknown usage; never call a run finished while its process has running tasks.

## Review Focus

1. A `session.activity` snapshot that arrives for a conversation other than the selected one, or after the user switched conversations mid-request: it must never be shown under the wrong conversation. Pinned in Task 5 (the `session.activity` read is discarded when the selection changed).
2. A dialog whose input is `{ truncated: true, preview }` (longer than 64 KiB of JSON): the card must still open, say so, and let the person dismiss it, never throw on `questions` being undefined. Pinned in Task 8.
3. Two hundred tasks with usage in one snapshot (a 16-agent fan-out over an hour): the panel must render in one pass without per-row RPCs, and the line must not re-render on every tick beyond its text. Pinned in Task 5 (pure grouping is one pass over `tasks`) and Task 7 (static render of 200 tasks stays under a bound).
4. `Stop background work` on a process whose tasks ignore `stop_task`: the result says `escalated: true` (or `stopped < requested`) and the tasks still run; the UI must then offer the force-stop and must not offer it before. Pinned in Task 7.
5. A `dialog.requested` for a run whose `run.state` went terminal before the client read the page (Stop raced the question): the dialog must not stay on screen; `dialog.resolved { cancelled }` or the terminal `run.state` clears it. Pinned in Task 5 (`PendingDialogs`).

---

### Task 1: Activity ticks reach the renderer

**Files:**
- Modify: `packages/client/src/reconnect.js` (an `activities` handler set; `subscribe(params, { onActivity })`; `client.onActivity` re-attached on every connection; `onActivity(fn)` method)
- Modify: `apps/desktop/src/main/index.js:224-227` (`client.subscribe(..., { onActivity: (activity) => this.relay.push("activity", activity) })`), `apps/desktop/src/main/relay.js` (an `activity` item is dropped like a preview when credits are out; it is sized by `JSON.stringify` as events are)
- Modify: `apps/desktop/src/renderer/engine-events.js` (partition `activity` items by `value.sessionId` as previews are, so a pane receives only its own conversation's ticks)
- Test: `packages/client/test/reconnect.test.js`, `apps/desktop/test/relay.test.js`, `apps/desktop/test/engine-events.test.js` (new)

**Interfaces:**
- Consumes the socket client's `subscribe(params, { onActivity })` and `onActivity(fn)` (Plan 1 Task 8), which deliver `{ sessionId, activity }`.
- Produces `connectResumable(...).subscribe(params, { onEvent, onPreview, onActivity })` and `.onActivity(fn) → unsubscribe`, delivering `{ sessionId, activity }` on every connection, including after a reconnect.
- Produces relay batches whose items may be `{ kind: 'activity', value: { sessionId, activity } }`; `subscribePaneEvents` hands a pane only the `activity` items whose `sessionId` is the pane's session.

- [ ] **Step 1: Write the failing tests.** In `reconnect.test.js`, extend `connection()` with `onActivity(fn) { listeners.activity = fn; }` and `activity(sessionId) { listeners.activity?.({ sessionId, activity: { state: 'background', tasks: [], truncated: false, updatedAt: 'now' } }); }`, then:

```js
test('activity ticks reach the subscriber before and after a reconnect', async () => {
  const first = connection(), next = connection(); let opens = 0;
  const client = await connectResumable({ open: async () => ++opens === 1 ? first : next, retryBaseMs: 1 });
  try {
    const seen = [];
    await client.subscribe({ after: '1' }, { onActivity: tick => seen.push(tick.sessionId) });
    first.activity('a');
    first.drop();
    await until(() => next.subscriptions.length);
    next.activity('b');
    expect(seen).toEqual(['a', 'b']);
  } finally { await client.close(); }
});
```

In `relay.test.js`: `test('activity ticks are dropped while blocked, like previews', ...)`: push 8 events without ack, then `relay.push('activity', { sessionId: 's', activity: { state: 'background', tasks: [], truncated: false, updatedAt: 'x' } })`; expect `relay.stats.queued` to be `0` and, after acking, the next batch's `previewsDropped` to be `1` (ticks count in the same counter; they are the same kind of loss).

In `engine-events.test.js` (new; stub `window.jolo.onEvents` with a function that captures the listener): subscribe two panes for sessions `a` and `b`; deliver a batch `[{ kind: 'activity', value: { sessionId: 'a', activity } }, { kind: 'event', value: { type: 'run.state', sessionId: 'a' } }]`; expect pane `a` to receive both items in order and pane `b` only the event.

- [ ] **Step 2: Run to verify they fail.** `bun test packages/client/test/reconnect.test.js apps/desktop/test/relay.test.js apps/desktop/test/engine-events.test.js`. Expected: FAIL (`seen` is `[]`; the activity item is queued; pane `b` receives the tick).
- [ ] **Step 3: Implement** per Interfaces. In `reconnect.js`, `activities` is a third handler set wired exactly like `previews`, attached with `client.onActivity?.(...)` so a connection without the method (the other tests' stubs, an older socket client) still works. In `relay.js`, the drop branch reads `kind === "preview" || kind === "activity"`. In `engine-events.js`, the per-session filter treats `activity` as it treats `preview`; its test sets `globalThis.window = { jolo: { onEvents: listener => { captured = listener; return () => {}; } } }` before importing the module.
- [ ] **Step 4: Run to verify they pass**, then `bun test packages/client apps/desktop/test`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Carry a process's activity ticks through the reconnecting client and the desktop relay"`

---

### Task 2: `session.page` lists the dialogs still waiting on the person

**Files:**
- Modify: `apps/engine/src/storage/dialogs.js` (`requestedForSession(sessionId)`), `apps/engine/src/dialogs/service.js` (`pendingForSession(sessionId)` returning event-shaped payloads; export the `eventInput` truncation it already has), `apps/engine/src/rpc/handlers.js:269-277` (`session.page` adds `pendingDialogs`), `packages/protocol/src/schemas.js:816-818` (`session.page` result gains `pendingDialogs: z.array(EventPayloadSchemas['dialog.requested']).optional()`)
- Test: `apps/engine/test/dialogs.test.js`, `tests/integration/claude-stream.test.js`

**Interfaces:**
- Produces `dialogs.pendingForSession(sessionId) → Array<{ dialogId, runId, tool, input, toolUseId }>` (oldest first; `input` truncated by the same rule as the event) and `session.page` → `{ ..., pendingDialogs }`.

- [ ] **Step 1: Write the failing unit test** in `dialogs.test.js`: request two dialogs in one session and one in another; `resolve` the first; `pendingForSession(sessionId)` returns only the second, shaped `{ dialogId, runId, tool: 'AskUserQuestion', input, toolUseId: null }`; a dialog whose input JSON is longer than `DIALOG_INPUT_EVENT_MAX` comes back as `{ truncated: true, preview: expect.any(String) }`.
- [ ] **Step 2: Write the failing integration test** in `claude-stream.test.js` next to the dialog tests: start `ask-user tea or coffee?`, wait for `dialog.requested`, then `client.call('session.page', { sessionId })` → `pendingDialogs` has one entry equal to the event's payload; after `dialog.resolve`, the page's `pendingDialogs` is `[]`.
- [ ] **Step 3: Run to verify they fail.** `bun test apps/engine/test/dialogs.test.js; mkdir -p /tmp/jt; TMPDIR=/tmp/jt bun test tests/integration/claude-stream.test.js -t "pendingDialogs|still waiting"`. Expected: FAIL (`pendingForSession is not a function`; `pendingDialogs` undefined).
- [ ] **Step 4: Implement** per Interfaces; `requestedForSession` is the `requested()` query with `AND session_id = ?1`.
- [ ] **Step 5: Run to verify they pass**, then `bun test packages/protocol apps/engine/test`. Expected: PASS (the two known engine failures aside).
- [ ] **Step 6: Commit.** `git commit -m "List a conversation's open dialogs in session.page for a client that joins late"`

---

### Task 3: `delegation_status` says why a wait ended

**Files:**
- Modify: `packages/protocol/src/schemas.js:898-911` (`DelegationSchema` gains `wakeReason: z.enum(['done', 'answer', 'asking', 'parent_stopped', 'stopped', 'timeout']).optional()`), `apps/engine/src/delegation/index.js` (`status()` records the first reason that ended the wait and passes it to `view(row, true, wakeReason)`), `apps/engine/src/tools/delegation.js` (description of `delegation_status` gains one sentence: "`wakeReason` says why a wait ended: done, answer, asking, parent_stopped, stopped (the call itself), or timeout.")
- Test: `apps/engine/test/delegations.test.js`

**Interfaces:**
- Produces `delegation.wakeReason` on the result of `status()` when `waitMs > 0`: `done` when `isDone`, `answer` when a newer answer woke it, `asking` when a run of the child waits on the person (`ASKING_STATES` or a `dialog.requested` / `permission.requested` event), `parent_stopped` when the parent's settle ended it, `stopped` when `signal` aborted, `timeout` when the timer did; absent otherwise (`waitMs` 0, `list`, `start`, `cancel`).

- [ ] **Step 1: Write the failing tests** in `delegations.test.js`, extending the existing cases rather than duplicating their setup:
  - the paused-later-run test (Task 1 of this session) also expects `wakeReason: 'asking'`;
  - the `maxWaitMs` test expects `wakeReason: 'timeout'`;
  - the background-work test expects `wakeReason: 'done'` after the idle activity;
  - a new test: a wait with `waitMs: 0` has no `wakeReason` key (`expect(result.delegation).not.toHaveProperty('wakeReason')`).
- [ ] **Step 2: Run to verify they fail.** `bun test apps/engine/test/delegations.test.js`. Expected: FAIL (`wakeReason` undefined).
- [ ] **Step 3: Implement**: in `view()`, move `output: ''` and `truncated: false` to the end of the result literal and add `wakeReason` right after `state`, so a tool display cut at 600 characters still carries `state`, `wakeReason`, `activity`, `done` and `partial` (the schema does not care about key order; the desktop's transcript line does). In `status()`, `finish(reason)` keeps the first reason; the `check()` branches pass `'done'`, `'asking'`, `'answer'`; the waiter's `wake(true)` passes `'parent_stopped'` from `onSettled` and `'asking'` from the dialog/permission events (thread a `reason` through `wake(final, reason)`); the timer passes `'timeout'`, the abort listener `'stopped'`. `view()` spreads `...(wakeReason ? { wakeReason } : {})`.
- [ ] **Step 4: Run to verify they pass**, then `bun test packages/protocol apps/engine/test delegation`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Tell a waiting parent why delegation_status returned"`

---

### Task 4: `session.closeProcess`, and the renderer may call it and `delegation.list`

**Files:**
- Modify: `packages/protocol/src/schemas.js` (`MethodSchemas['session.closeProcess'] = { params: z.object({ sessionId: Id }), result: z.object({ closing: z.boolean() }) }`), `apps/engine/src/rpc/handlers.js:286-295` (handler beside `session.stopBackground`), `apps/desktop/src/main/index.js:61` (allow-list adds `"session.closeProcess", "delegation.list"`)
- Test: `tests/integration/claude-stream.test.js`, `apps/desktop/test/desktop-policy.test.js` (if it asserts the allow-list; else none for the list)

**Interfaces:**
- Produces RPC `session.closeProcess { sessionId } → { closing: boolean }`: `requireInteractive`; `not_found` for an unknown session; when the conversation has a live link, `void hostedLinks.close(sessionId, 'stopped by the person')` (graceful: `stop_task` → EOF → SIGTERM after grace → SIGKILL) and `{ closing: true }`; `{ closing: false }` when it has none.

- [ ] **Step 1: Write the failing integration test** in `claude-stream.test.js`:

```js
test('force-stopping a conversation closes its process, which ends the tasks that ignored stop_task', async () => {
  const { client, events, session, runTo, starts } = await boot();
  await runTo('stubborn', 'tasks-stubborn 2');
  await waitFor(() => events.some(e => e.type === 'session.activity' && e.payload.state === 'background'));
  expect(await client.call('session.stopBackground', { sessionId: session.id })).toMatchObject({ requested: 2, stopped: 0 }); // stubborn tasks acknowledge stop_task and keep running: escalated stays false
  expect(await client.call('session.closeProcess', { sessionId: session.id })).toEqual({ closing: true });
  await waitFor(() => !alive(starts()[0]), { timeoutMs: 15_000 });
  const last = events.filter(e => e.type === 'session.activity' && e.sessionId === session.id).at(-1);
  expect(last.payload.state).toBe('idle');
  expect(last.payload.tasks.every(t => t.status !== 'running')).toBe(true);
  expect(await client.call('session.closeProcess', { sessionId: session.id })).toEqual({ closing: false });
}, 30_000);
```

- [ ] **Step 2: Run to verify it fails.** `TMPDIR=/tmp/jt bun test tests/integration/claude-stream.test.js -t "force-stopping"`. Expected: FAIL, `unknown method session.closeProcess`.
- [ ] **Step 3: Implement** the schema, the handler and the allow-list lines.
- [ ] **Step 4: Run to verify it passes**, then `bun test packages/protocol apps/desktop/test`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Let the person close a conversation's process when its tasks ignore stop_task"`

---

### Task 5: Renderer state: the conversation's activity and its waiting dialogs

**Files:**
- Create: `apps/desktop/src/renderer/activity.js` (pure helpers), `apps/desktop/src/renderer/pending-dialogs.js`
- Modify: `apps/desktop/src/renderer/use-engine.js` (activity state; `PendingDialogs`; new actions)
- Test: `apps/desktop/test/activity.test.js`, `apps/desktop/test/pending-dialogs.test.js`

**Interfaces:**
- Produces in `activity.js`:
  - `export const LARGE_RUN_AGENTS = 25;`
  - `runningTasks(activity) → TaskRecord[]` (`status === 'running'`; `[]` for null).
  - `groupActivity(activity) → { runs: WorkflowRun[], tasks: TaskRecord[] }` where `WorkflowRun = { runId, tasks, agents: number, startedAt, endedAt: string | null, running: boolean, phases: { name: string | null, status: 'pending' | 'running' | 'done' | 'failed' }[], tokens: number | null, large: boolean }`; runs are tasks with a non-null `runId`, ordered by first `startedAt` ascending; `phases` per D3 (one per distinct phase, else one per agent); `tokens` null when no task of the run reported `totalTokens`; `tasks` are the standalone ones, running first, newest first.
  - `activityLine(activity, { now, workflowNames }) → { text: string, running: number } | null`: D1's wording; null when nothing runs. `workflowNames: Map<runId, string>`.
  - `formatTokens(n) → '412k' | '1.2M' | '850'`, `formatElapsed(ms) → '06:12' | '1:04:09'`.
  - `parseWorkflowName(toolText) → string | null`: from a tool block whose head is `Workflow {json}`; `meta.name` matched with `/name\s*:\s*(['"`])([^'"`]+)\1/` inside the `script`, else the basename of `scriptPath`, else null.
  - `workflowNames(messages, tools, runs) → Map<runId, string>` per D3: `tools` is `[...projection.tools.values()]` (`{ callId, name, preview }`); step (1) matches `tool.callId` to any `toolUseId` of the run's tasks and parses `tool.preview`; (2) a `Workflow` message whose `text` includes `run.runId`; (3) the single pair; a run with no name is absent from the map (the caller falls back to the first task's description).
- Produces `PendingDialogs` with the same shape as `PendingPermissions`: `first`, `requests: Map<dialogId, payload>`, `seed(dialogs, cursor)`, `apply(event)` (handles `dialog.requested`, `dialog.resolved`, and terminal `run.state` for the dialog's run; the same cursor guard and during-load replay), `remove(id)`.
- Produces from `useEngine()`: `activity` (`ActivitySchema | null` for the selected conversation), `pendingDialog` (`PendingDialogs.first`), `stopBackground() → Promise<{ requested, stopped, escalated }>`, `stopTask(taskId) → Promise<{ ok, error }>`, `closeProcess() → Promise<{ closing }>`, `resolveDialog(dialogId, response)`, `dismissDialog(dialogId, message)`, `delegationList() → Promise<Delegation[]>` (`delegation.list` for the selected conversation; `[]` on `unknown_method`).

- [ ] **Step 1: Write the failing tests** in `activity.test.js` (pure functions; name each case after its rule):
  - `groupActivity` on three tasks sharing `runId: 'wf1'` with phases `Review, Review, Verify` and statuses `completed, running, running` gives one run with `agents: 3`, `phases: [{ name: 'Review', status: 'running' }, { name: 'Verify', status: 'running' }]`, `running: true`, `tokens: 3000` when usages are `1000, 2000, null`;
  - a run with no phases gives one phase entry per agent; a run with 26 agents is `large`;
  - standalone tasks come running first, newest first; `groupActivity(null)` is `{ runs: [], tasks: [] }`;
  - `activityLine` with two running commands and no usage is `{ text: 'Background work: 2 tasks · 00:30', running: 2 }` for `now` 30 s after their start; with usage `412_000` the text adds ` · 412k tokens`; with an open workflow named `review` in phase `Verify`, 37 of 120 agents finished and 1.2M tokens: `Workflow review: Verify 37/120 · 1.2M tokens`; null when nothing runs;
  - `parseWorkflowName('Workflow {"script":"export const meta = { name: \'review-changes\', description: \'x\' }"}\n...')` is `review-changes`; with only `scriptPath: '/a/b/plan-review.js'` it is `plan-review`; a `Bash` head gives null; a cut-off head (`Workflow {"script":"export const meta = { name: 'review-changes', descr`) still gives `review-changes`;
  - `workflowNames`: a run whose task has `toolUseId: 'toolu_wf'` takes the name from a tool `{ callId: 'toolu_wf', name: 'Workflow', preview: 'Workflow {"script":"export const meta = { name: \'by-call\'' }`; a run `wf_2` with no such tool takes the Workflow message whose text includes `wf_2`; with one Workflow message and one run, that message; otherwise the run is absent from the map;
  - Review Focus 3: `groupActivity` over 200 tasks across 16 runs returns within one pass (assert the result sizes; no timing).
  - In `pending-dialogs.test.js`, port the four `PendingPermissions` cases to dialogs (`dialogId`), plus Review Focus 5: `apply(run.state cancelled)` seen before `seed` clears a dialog of that run.
- [ ] **Step 2: Run to verify they fail.** `bun test apps/desktop/test/activity.test.js apps/desktop/test/pending-dialogs.test.js`. Expected: FAIL, modules missing.
- [ ] **Step 3: Implement** `activity.js` and `pending-dialogs.js` per Interfaces.
- [ ] **Step 4: Wire `use-engine.js`:** `const [activity, setActivity] = useState(null)`; in `selectSession`: reset to null, then after the page, `call('session.activity', { sessionId: id }).then(r => { if (sessionRef.current === id) setActivity(r.activity); }).catch(() => {})` (Review Focus 1); in the pane event loop: a durable `session.activity` event for the selected session → `setActivity(payload)`; an item `kind === 'activity'` for it → `setActivity(item.value.activity)`; `dialogs.current = new PendingDialogs()` per selection, seeded with `page.pendingDialogs ?? []`, `apply` beside `permissions.current.apply`; the six actions per Interfaces (`resolveDialog`/`dismissDialog` remove from the queue and `redraw()` as `resolvePermission` does). Return them all.
- [ ] **Step 5: Run** `bun test apps/desktop/test` and `bun scripts/typecheck.js`. Expected: PASS, type-clean.
- [ ] **Step 6: Commit.** `git commit -m "Keep the selected conversation's process activity and open dialogs in the renderer"`

---

### Task 6: The activity line above the composer

**Files:**
- Create: `apps/desktop/src/renderer/components/activity-line.jsx`
- Modify: `apps/desktop/src/renderer/components/workspace-pane.jsx` (render between `Conversation` and `PermissionNotice`; pass `onOpenPanel={() => selectContext('activity')}`), `apps/desktop/src/renderer/styles.css` (`.activity-line` beside `.resume-note`)
- Test: `apps/desktop/test/activity-line.test.jsx`

**Interfaces:**
- Produces `ActivityLine({ activity, workflowNames, onStop, onOpenPanel, stopping })`: null when `activityLine(...)` is null; otherwise `<div className="activity-line" role="status">` with a text button (`aria-label="Show background work"`) that calls `onOpenPanel`, and a `Stop background work` button (`disabled={stopping}`, label `Stopping…` while pending) calling `onStop`. It re-renders its elapsed time with a one-second interval only while something runs.

- [ ] **Step 1: Write the failing tests** (static markup): with two running tasks the markup contains `Background work: 2 tasks` and a button `Stop background work`; with no running tasks the markup is empty; with `stopping` the button reads `Stopping…` and is disabled.
- [ ] **Step 2: Run to verify they fail.** `bun test apps/desktop/test/activity-line.test.jsx`. Expected: FAIL, module missing.
- [ ] **Step 3: Implement** the component and wire it: in `workspace-pane.jsx`, `const names = useMemo(() => workflowNames(projection?.ordered() ?? [], projection ? [...projection.tools.values()] : [], groupActivity(state.activity).runs), [...])`; `onStop` = `reportError(async () => { setStopping(true); try { lastStop.current = await state.stopBackground(); } finally { setStopping(false); } })` (`lastStop` is read by Task 7's panel for the force-stop rule; keep it in pane state `stopResult`).
- [ ] **Step 4: Run to verify they pass**, then `bun test apps/desktop/test` and typecheck. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Show a conversation's background work above the composer, with a stop for all of it"`

---

### Task 7: The Activity panel with workflow cards, per-task stop and force-stop

**Files:**
- Create: `apps/desktop/src/renderer/components/activity-panel.jsx`
- Modify: `apps/desktop/src/renderer/components/panel-menu.jsx` (`CONTEXT_PANELS` adds `['activity', 'Activity', 'agents']`), `apps/desktop/src/renderer/components/workspace-pane.jsx` (`details.activity = running ? `${running} tasks` : null`; the standalone filter includes `'activity'`; a `tool-panel` host `hidden={context !== 'activity'}`), `apps/desktop/src/renderer/styles.css`
- Test: `apps/desktop/test/activity-panel.test.jsx`

**Interfaces:**
- Produces `ActivityPanel({ activity, workflowNames, stopResult, onStopAll, onStopTask, onStopRun, onForceStop })`:
  - header `Activity` with `Stop background work` while anything runs, and `Nothing running` otherwise;
  - one `.workflow-card` per `WorkflowRun` (D3): title, `Workflow`, `N agents`, elapsed, tokens (omitted when null), `.status-dots` (one `<span data-status>` per phase entry), `Large` badge when `large`, `Stop run` while running, a `<details>` listing agents as `.task-row`s;
  - one `.task-row` per standalone task: description, kind (`Agent`/`Task`), phase, status word (`running`, `done`, `stopped`, `failed`), elapsed, tokens, `Stop` while running;
  - `Older finished tasks are not listed` when `truncated`;
  - the force-stop: when `stopResult` says `escalated || stopped < requested` and tasks still run (Review Focus 4), a `.panel-note` `Some tasks did not stop` with a `Force stop` button that opens a `Modal` (`Close Claude's process?` / `Its background work, and any answer in progress, end with the process. The conversation continues with a fresh process on your next message.` / `Cancel` · `Close process`) whose confirm calls `onForceStop`; absent before any stop was attempted. Tasks that end with the process are recorded `failed` by the engine and read `failed` here; that is what happened to them.

- [ ] **Step 1: Write the failing tests** (static markup): a workflow run of three agents (two phases) renders one card with `3 agents`, two status dots, `Stop run`; a standalone running task renders a row with `Stop`; `stopResult = { requested: 2, stopped: 0, escalated: true }` with running tasks renders `Force stop`, and `stopResult = null` does not; `truncated` renders the note; Review Focus 3: 200 tasks across 16 runs render to markup in one call (`expect(html.match(/task-row/g).length).toBe(200)`).
- [ ] **Step 2: Run to verify they fail.** `bun test apps/desktop/test/activity-panel.test.jsx`. Expected: FAIL.
- [ ] **Step 3: Implement** the panel, the menu entry, the pane wiring (`onStopRun = run => Promise.all(run.tasks.filter(running).map(t => state.stopTask(t.taskId)))`, `onForceStop = () => state.closeProcess()`), and the styles (`.workflow-card` from `.plan-card`, `.status-dots span` 7 px circles coloured by `data-status`: `pending` border only, `running` `var(--highlight)`, `done` `var(--green)`, `failed` `var(--red)`).
- [ ] **Step 4: Run to verify they pass**, `bun test apps/desktop/test`, typecheck. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Add the Activity panel: workflow cards, per-task stop, and a force-stop for tasks that ignore it"`

---

### Task 8: Dialog cards: Claude's questions and plan approvals

**Files:**
- Create: `apps/desktop/src/renderer/components/dialog-modal.jsx`
- Modify: `apps/desktop/src/renderer/components/permission-notice.jsx` (`title = 'Approval needed'`, `icon = 'shield'` props), `apps/desktop/src/renderer/components/workspace-pane.jsx` (render `DialogModal` when `active && pendingDialog && !pendingPermission`; the notice for an inactive pane; `setOverlay` and `autoFocusOnType` count `pendingDialog`; `ModelControls` disabled as for a permission), `apps/desktop/src/renderer/styles.css`
- Test: `apps/desktop/test/dialog-modal.test.jsx`, `apps/desktop/test/permission-dialog.test.jsx` (notice props)

**Interfaces:**
- Produces `DialogModal({ dialog, onResolve, onDismiss })` per D5, a `Modal` with `className="dialog-modal"` and `dismissOnBackdrop={false}`, with `dialog = { dialogId, runId, tool, input, toolUseId }`:
  - `AskUserQuestion`: `input.questions[]` → per question an eyebrow `header`, the `question`, `options` as `<label><input type="radio|checkbox" name=q-index>` with the description as `.hint`, and an `Other` row with a text input; `Answer` (primary, disabled until every question has a choice or text) calls `onResolve({ answers })` with labels joined by `, ` for multi-select; `Dismiss` calls `onDismiss('The user dismissed the question without answering.')`;
  - `ExitPlanMode`: `<Markdown text={input.plan} />` in a scrollable `.plan-body`, a feedback `<textarea placeholder="What should change? (optional)">`, `Send back` → `onDismiss(feedback.trim() || 'The user rejected the plan.')`, `Approve plan` (primary) → `onResolve({})`;
  - any other tool: `<pre>` of the input JSON, `Allow` → `onResolve({})`, `Dismiss` → `onDismiss('The user dismissed the request.')`;
  - `input.truncated === true`: `This question is too long to show here.` with `input.preview` in a `<pre>` and `Dismiss` only (Review Focus 2);
  - Enter on the primary button behaves as in `PermissionDialog` (no repeat, one decision); errors from `onResolve`/`onDismiss` show as `role="alert"` and re-enable the buttons.

- [ ] **Step 1: Write the failing tests** (static markup): an AskUserQuestion with two options renders both labels as radios, the header, and a disabled `Answer`; a `multiSelect` question renders checkboxes; an ExitPlanMode renders the plan heading text, `Approve plan` and `Send back`; a truncated input renders `too long to show` and no `Answer`/`Approve`; an unknown tool renders `Allow`; `PermissionNotice` with `title="Claude has a question"` renders that text.
- [ ] **Step 2: Run to verify they fail.** `bun test apps/desktop/test/dialog-modal.test.jsx apps/desktop/test/permission-dialog.test.jsx`. Expected: FAIL.
- [ ] **Step 3: Implement** the component, the notice props and the pane wiring (`onResolve = response => state.resolveDialog(pendingDialog.dialogId, response)`, `onDismiss = message => state.dismissDialog(pendingDialog.dialogId, message)`; the notice for an inactive pane: `<PermissionNotice request={{ summary: firstQuestionOrPlan }} title="Claude has a question" icon="chat" active={active} onReview={() => onFocus(pane.id)} />`).
- [ ] **Step 4: Run to verify they pass**, `bun test apps/desktop/test`, typecheck. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Answer Claude's questions and plan approvals from a dialog card beside the permission card"`

---

### Task 9: Notifications for a question Claude asks

**Files:**
- Modify: `apps/desktop/src/main/attention-service.js` (`BOARD_EVENTS` adds `dialog.requested`, `dialog.resolved`; `announce(event, 'dialog')` per D8; `visibleApprovals` keyed by `dialogId` as well; `dismissApproval` by dialog id on `dialog.resolved` and on the run ending), `apps/desktop/src/renderer/engine-context.jsx` (a notice whose `focus.dialogId` matches a `dialog.resolved` event is dropped, as for permissions)
- Test: `apps/desktop/test/desktop-policy.test.js` (its `attentionFixture()` already doubles `bridge.rawCall`, `window`, `app` and `Notification`; extend the fixture's `read` so `session.page` answers `pendingDialogs` too)

**Interfaces:**
- Produces notices `{ kind: 'approval', dialogId, permissionId: null, title: '<project> needs your answer', body: <first question | 'Plan ready for your review' | tool> }` and dismissals `{ dismiss: true, dialogId }`.

- [ ] **Step 1: Write the failing test** in `desktop-policy.test.js` with `attentionFixture()`: feed `{ type: 'dialog.requested', runId: 'r', sessionId: 's', payload: { dialogId: 'dlg', runId: 'r', tool: 'AskUserQuestion', input: { questions: [{ question: 'tea or coffee?', header: 'Choice', options: [], multiSelect: false }] }, toolUseId: null } }` with the page read answering `pendingDialogs: [that payload]`; expect one notice `{ kind: 'approval', dialogId: 'dlg', permissionId: null, title: 'repo needs your answer', body: 'tea or coffee?' }` (sent to the window, the fixture's window being focused); feed `{ type: 'dialog.resolved', ..., payload: { dialogId: 'dlg', state: 'answered' } }` and expect `{ dismiss: true, dialogId: 'dlg' }` and no second notice.
- [ ] **Step 2: Run to verify it fails.** `bun test apps/desktop/test/desktop-policy.test.js -t "dialog"`. Expected: FAIL (nothing notified).
- [ ] **Step 3: Implement** per Interfaces, reusing the approval path; `show()` keys a dialog by `dialogId` where it keys an approval by `permissionId`.
- [ ] **Step 4: Run to verify it passes**, `bun test apps/desktop/test`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Tell the person when Claude asks them a question, as for an approval"`

---

### Task 10: Delegation in the transcript and the child-tasks list

**Files:**
- Create: `apps/desktop/src/renderer/delegation.js` (`parseDelegationCall`, `delegationWords`)
- Modify: `apps/desktop/src/renderer/components/conversation.jsx` (a `DelegationBlock` for tool messages that `parseDelegationCall` recognises, grouped like `subagent`; prop `onOpenSession`), `apps/desktop/src/renderer/components/child-tasks-menu.jsx` (`delegations` prop: a `Map<sessionId, Delegation>`; each row adds `<small>` with `delegationWords`), `apps/desktop/src/renderer/components/task-header.jsx` and `workspace-pane.jsx` (load `state.delegationList()` when the popover opens and on `run.state` / `session.activity` events whose `sessionId` is a child's; pass the map down; `Conversation onOpenSession={id => state.selectSession(id)}`)
- Test: `apps/desktop/test/delegation.test.js`, `apps/desktop/test/conversation.test.jsx`

**Interfaces:**
- Produces `parseDelegationCall(text) → { name: 'delegate_task' | 'delegation_status' | 'delegation_cancel', args: object, delegation: Partial<Delegation> | null, error: string | null } | null`: head `/^(?:mcp__jolo__|jolo\/)(delegate_task|delegation_status|delegation_cancel) (\{.*)$/s` (`args` parsed, or rescued field by field as `subagent.js` does when the head is cut); the result is the text after the head, which the engine cuts at 600 characters and ends with `…`: `delegation` holds whichever of `id`, `sessionId`, `title`, `state`, `activity`, `done`, `partial`, `wakeReason` a tolerant extractor finds (string fields by `"key":"value"`, booleans by `"key":true|false`), null while the result is empty; a non-JSON result is `error`.
- Produces `liveDelegation(parsed, delegations) → Partial<Delegation>`: the `delegations` map (`Map<id, Delegation>` from `delegation.list`) row with `parsed.delegation.id`, else for `delegate_task` the row whose `title === parsed.args.title`, merged over the parsed fields (live wins; `wakeReason` comes only from the parsed result).
- Produces `delegationWords(delegation) → string`: `<state words> · <activity words>` where state words follow `desktopRunLabel` (`Working`, `Needs approval`, `Ready for review` → `Answered`, `Stopped`, `Task failed`), activity words are `background work` for `background`, `working` for `working`, omitted for `idle`/null; ` · partial answer` when `partial`; ` · done` when `done`; ` · woke: <reason words>` with `done` → `finished`, `answer` → `new answer`, `asking` → `needs you`, `parent_stopped` → `parent stopped`, `stopped` → `wait stopped`, `timeout` → `wait timed out`.
- Produces `DelegationBlock({ text, status, delegations, onOpenSession })`: `<div className="delegation-block">` with an `agents` icon, `Child <title>` (title from the result, else `args.title`, else `Child task`), the words, an `Open` button when the result has a `sessionId`, and a `<details>` holding the raw tool text as a `ToolBlock` does.

- [ ] **Step 1: Write the failing tests**: `parseDelegationCall('mcp__jolo__delegation_status {"delegationId":"del_1","waitMs":600000}\n{"delegation":{"id":"del_1","parentRunId":"run_p","runId":"run_c","sessionId":"ses_c","title":"bg child","modelAlias":"m1","state":"completed","wakeReason":"timeout","failure":null,"execution":{"agentId":"claude","preset":null,"model":"opus","effort":null,"pinned":true},"createdAt":"2026-10-24T00:00:00.000Z","activity":"background","done":false,"partial":true,"output":"started and then a very long answer that the engine cu…')` (a result cut mid-`output`, as the engine shows it) gives `name`, `args.waitMs`, and `delegation` with `id`, `sessionId`, `title`, `state`, `activity: 'background'`, `done: false`, `partial: true`, `wakeReason: 'timeout'`; a streaming call (head only) gives `delegation: null`; a `Bash` head gives null; `liveDelegation(parsed, new Map([['del_1', { id: 'del_1', state: 'completed', activity: 'idle', done: true, partial: false }]]))` has `done: true`, `activity: 'idle'` and still `wakeReason: 'timeout'`; `delegationWords` for that delegation is `Answered · background work · partial answer · woke: wait timed out`; `delegationWords({ state: 'completed', activity: 'idle', done: true, partial: false, wakeReason: 'done' })` is `Answered · done · woke: finished`. In `conversation.test.jsx`: a tool message with that cut-off text renders `Child bg child`, the words, and an `Open` button; no raw JSON outside the `<details>`.
- [ ] **Step 2: Run to verify they fail.** `bun test apps/desktop/test/delegation.test.js apps/desktop/test/conversation.test.jsx`. Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces; `Conversation` receives `delegations` (a `Map<id, Delegation>`; the pane builds it from `state.delegationList()` and also indexes rows by `sessionId` for the child-tasks popover, which reads `delegationsBySession.get(task.sessionId)`).
- [ ] **Step 4: Run to verify they pass**, `bun test apps/desktop/test`, typecheck. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Show what a delegated child is doing, in the transcript and the child-tasks list"`

---

### Task 11: Fixture scenario for plan approval, and the background-work smoke

**Files:**
- Modify: `tests/fixtures/fake-claude.js` (scenario `exit-plan <title>`: emits `can_use_tool` for `ExitPlanMode` with `requires_user_interaction: true` and `input: { plan: "# <title>\n\n1. Do the thing.", planFilePath: "/tmp/plan.md" }`; allow → `say("Plan approved: <title>")`, deny → `say("Plan sent back: <message>")`; documented in the file's header comment)
- Create: `apps/desktop/smoke/background-work-smoke.js`
- Modify: `apps/desktop/scripts/smoke.js` (`--background-work` → `JOLO_BACKGROUND_WORK_SMOKE=1`), `apps/desktop/smoke/smoke.js` (dispatch like `JOLO_DELEGATION_SMOKE`)
- Test: `tests/integration/claude-stream.test.js` (one case for `exit-plan` through `dialog.resolve {}` → `Plan approved: Ship it`), the smoke itself

**Interfaces:**
- Produces `runBackgroundWorkSmoke({ window, bridge, evaluate, waitFor, report, results })`:
  1. `window.__joloSmoke.pickAnswerer('claude')`; send `tasks 2 20000`; wait for `.activity-line` containing `Background work: 2 tasks`; open the Activity panel through `selectPanel(evaluate, waitFor, 'Activity')`; assert two `.task-row` elements; screenshot `background-work.png`; click `Stop background work`; wait for the line to disappear and the rows to read `stopped`.
  2. Send `ask-user tea or coffee?`; wait for `.dialog-modal[open]`; click the `coffee` radio; click `Answer`; wait for `window.__joloSmoke.state().assistantText` to contain `You answered: coffee`.
  3. Send `exit-plan Ship it`; wait for the modal with `Approve plan`; click it; wait for `Plan approved: Ship it`.
  4. `report.checks.push('background work is listed and stopped from the Activity panel; AskUserQuestion and ExitPlanMode are answered from dialog cards')`.

- [ ] **Step 1: Write the failing integration test** for `exit-plan` (as the dialog tests are written) and run it: `TMPDIR=/tmp/jt bun test tests/integration/claude-stream.test.js -t "exit-plan|plan approval"`. Expected: FAIL (the fixture does not know the prompt).
- [ ] **Step 2: Add the fixture scenario**; run the test again. Expected: PASS.
- [ ] **Step 3: Write the smoke** per Interfaces and run it: `bun apps/desktop/scripts/build.js && bun apps/desktop/scripts/smoke.js --background-work`. Expected: exit 0 and the check in `smoke-results/smoke.json`. A failure here is a defect in Tasks 5–8, fixed there, not in the smoke.
- [ ] **Step 4: Run the default smoke**: `bun run desktop:smoke`. Expected: exit 0.
- [ ] **Step 5: Commit.** `git commit -m "Smoke the Activity panel, Stop background work, and the dialog cards against the fake Claude"`

---

### Task 12: Changelog

**Files:**
- Modify: `CHANGELOG.md` (`## [Unreleased]`: the Plan 1 release-gate line is replaced in Step 5 of the session; this task adds the user-facing lines for Plan 2)

- [ ] **Step 1: Add the lines** under `## [Unreleased]`, in the file's voice: the Activity panel and the activity line; Stop background work, per-task stop and force-stop; dialog cards for Claude's questions and plan approvals, with notifications; delegation lines in the transcript and the child-tasks list; `delegation_status`'s `wakeReason`.
- [ ] **Step 2: Run** `bun scripts/typecheck.js` and `bun test packages apps/desktop/test apps/engine/test`. Expected: clean; the two known engine failures aside.
- [ ] **Step 3: Commit.** `git commit -m "Changelog: the desktop shows and stops Claude's background work and answers its questions"`

---

## Final: whole-branch checks (Step 4 of the session)

- `bun run typecheck` clean.
- `mkdir -p /tmp/jt; TMPDIR=/tmp/jt bun run test` with only the six known upstream failures (two TUI signal tests, guest credential, hosted stdio MCP / tgrep, run request deduplication, packaging Bun version); `agent-context-sync` rerun alone if it flakes.
- `bun run desktop:smoke` green; `bun apps/desktop/scripts/smoke.js --background-work` green.
- Real-binary check from `scratch-e2e/run3.js` (not committed): a delegated child that starts a background command shows as a running task through `session.activity`, `session.stopBackground` ends it, the child's process stays alive, `delegation_status` reports `done: false` then `done: true`, with `wakeReason`.
- Evidence recorded in `docs/superpowers/plans/2026-10-24-native-claude-host-desktop-ui-verification.md`.
