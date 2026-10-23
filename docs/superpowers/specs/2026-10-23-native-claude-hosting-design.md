# Jolo as a native host for Claude Code

Design, 2026-10-23. Status: APPROVED by the owner on 2026-10-23 with the defaults in §8 (ultracode stays selectable for children with an explanatory line; lean child startup on; window gate 80%; Phase 1 Desktop first). Plans: `docs/superpowers/plans/2026-10-23-native-claude-host-engine.md` (Plan 1, engine core); Plan 2 (Desktop UI) and Plan 3 (settings and caps) follow.

## 1. Intent

On 2026-10-22 a Claude child task delegated from a Jolo conversation launched a 127-agent Workflow, answered "waiting on the workflow" after 19 seconds, and kept burning in the background for 23 minutes until the owner's 5-hour usage window was exhausted. Nobody saw it, nobody could stop it, Jolo showed the task as completed with 0 tokens, and the result never reached anyone.

The owner's conclusion, which this design follows: **Jolo is a bridge. Whatever Claude Code shows and asks, Jolo must show and ask. Whatever Claude Code's own interface lets a person do, Jolo must let them do. Nothing Claude starts is hidden, and nothing is killed behind the owner's back. Inside Jolo it should feel like being inside Claude Code.**

Cost is controlled the way Claude Code controls it: by making work visible, by giving the person a stop button that works at every level, and by optional caps the person sets. Not by Jolo deciding on its own what the model may do.

## 2. Goals, non-goals, anti-goals

Goals
- Every Claude Code event that its own interface renders is rendered in Jolo: tool calls, subagents, background tasks, workflow progress, questions, permission prompts, usage.
- Every control Claude Code's interface offers is offered in Jolo: stop the turn, stop background work, stop one task or one workflow, answer any dialog.
- A task is never shown as finished while Claude still has work running for it.
- A delegated child behaves like a native subagent: its parent, and the person, receive everything it says, including what it says after background work finishes.
- Spend is visible per task, per turn, per conversation, in tokens and in Claude Code's own cost estimate, never shown as zero when it is unknown.
- All limits are settings with finite defaults, nothing hardcoded.

Non-goals
- Changing how Claude decides what to do. Jolo does not edit the model's judgement, prompt it to be frugal, or strip modes it offers.
- Covering Codex or Antigravity children in this design. They have their own transports; the activity model should be reusable, but their wiring is separate work.
- A new UI framework or redesign. Existing panels (task panel, child-tasks fold, permission cards) grow the missing information.

Anti-goals (a failure even if it "works")
- Killing a Claude process that still has work the person did not stop.
- Marking a run completed, or a delegation finished, while Claude's process has running tasks for it.
- Spend that shows as 0 because Jolo did not count it.
- A guard that silently changes what the person chose (for example mapping an effort level to another one without saying so).

## 3. Constraints

- Owner rules: no over-engineering; nothing hardcoded (operational values from settings); secure by default.
- Owner runs Claude Code on a Claude Max subscription. The usage window, not dollars, is the real budget. Claude Code's `total_cost_usd` is an API-equivalent estimate; on 2026-10-22 roughly 110 estimated dollars emptied one window, so 1 dollar is about 1 percent of a window on this plan. Treat the estimate as a proxy, label it as such.
- Claude Code version on the owner's machine: 2.1.304. Protocol facts below were read from that binary and from the official docs, and the ones marked "verified" were exercised against the real binary in `jolo-delegated-child-guard.e2e/` (results.json, results2.json, claude-host-controls-probe.py).
- Jolo architecture as it stands: one run = one turn; one conversation = one Claude process kept across turns (`apps/engine/src/agents/claude-link.js`); permissions via `--permission-prompts host --permission-prompt-tool stdio`; delegation = child session + child run, parent polls `delegation_status`.
- Policy note for the owner to check, not a design decision: Anthropic's Agent SDK docs state that third parties may not offer claude.ai login or rate limits in their products without approval. Jolo drives the owner's own installed CLI and login. Whether that counts, and what it means if Jolo is distributed, is the owner's question.

## 4. What Claude Code gives a host (the contract Jolo builds on)

Events Claude Code emits on the stream (all `type: "system"` unless noted)
- `task_started` {task_id, run_id, tool_use_id, description, subagent_type, is_backgrounded, owned_by_subagent}. Verified live. One per subagent or background command; workflow agents are tasks whose `run_id` is the workflow run.
- `task_progress` {task_id, usage: {total_tokens, tool_uses, duration_ms}}. Periodic. This is the per-task spend Jolo never counted.
- `task_notification` {task_id, status: completed | stopped | failed, reason}. Verified live.
- `task_updated` {task_id, patch}, `task_summary`.
- `agents_killed` (background agents terminated, e.g. on interrupt), `away_summary` (what happened while the person was away), `permission_denied`, `api_retry`, `compact_boundary`, `informational`.
- `session_state_changed` when `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`: the session reports running at turn end while background work runs (`CLAUDE_CODE_BG_TASKS_REPORT_RUNNING`, default on).
- Subagent messages carry `parent_tool_use_id`; with `CLAUDE_CODE_FORWARD_SUBAGENT_TEXT=1` their text and thinking are forwarded too, at every nesting depth.
- `result` carries `total_cost_usd`, `usage` (main thread only), `modelUsage` (whole tree), `num_turns`, `permission_denials`, subtype `success | error_max_budget_usd | error_during_execution | ...`.
- `turn_duration` with pendingBackgroundAgentCount exists in the binary but was NOT seen in stream mode; do not rely on it. Count pending work from task events.

Controls a host may send (`control_request`)
- `interrupt` {cancel_queued: true} = Stop. Ends the turn; in the REPL a second stop kills background agents (`agents_killed`). When the host declared `perTaskStopAffordance: true` in `initialize` ("this consumer renders a per-task stop control wired to stop_task"), an interrupt on an interactive stream-json session spares background work. Jolo declares it (5.3).
- `stop_task` {task_id}: stops one background task or one workflow. Verified live: success response, then `task_notification status: stopped`, within 0.2 s.
- `background_tasks` {tool_use_id?}: move a foreground task to the background (Ctrl+B semantics).
- `get_task_output`, `send_task_message`, `get_usage`, `get_session_cost`, `get_context_usage`, `set_permission_mode`, `set_model`.
- Claude's questions to the person (AskUserQuestion, ExitPlanMode / plan approval) arrive in host mode as ordinary `can_use_tool` control requests carrying `requires_user_interaction: true` (probe 2026-10-23 against 2.1.304, `claude-dialogs.md`). The host answers `{ behavior: 'allow', updatedInput }` — for AskUserQuestion with `answers: { "<question>": "<option label>" }` merged into the input — or `{ behavior: 'deny', message }`; `cancelled` is rejected. `request_user_dialog` / `initialize.supportedDialogKinds` exist in the binary for other dialog kinds but are not what these tools use, so Jolo does not declare any. Jolo today treats these requests as permissions and, once allowed, sends the input back unchanged, so Claude is told the person did not answer.

Lifecycle facts
- In print mode, after the turn and after stdin closes, the process stays open and waits for background work: subagents and workflows until they finish, other work up to `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` (default 10 min). Verified: with a background command running it did not exit within 60 s of stdin close.
- SIGTERM: kills Bash process trees, runs SessionEnd hooks, exits 143, leaves the turn unfinished. SIGKILL gives no cleanup; a background shell survived it in the probe. Order of preference: stop_task, then interrupt, then EOF, then SIGTERM, SIGKILL last.
- `--max-budget-usd` covers subagents, refuses new spawns at the cap, stops running background subagents, and ends with `error_max_budget_usd`. Verified. Checked after each response, so it can overshoot by one response plus in-flight subagents.
- Usage-limit pause/resume of workflows happens only in interactive subscription sessions. In print mode the affected agents fail. So a Jolo-hosted workflow does not auto-resume after a reset.
- Workflow approval: in print mode Claude Code never shows its own approval prompt; the Workflow tool call goes through normal permission evaluation. It asks the host only when an `ask` rule or mode requires it. The Desktop app's approval card shows the workflow name, phase list, a token caution, and Once / Always / Deny. That card is the template for Jolo.
- Knobs: `disableWorkflows` / `CLAUDE_CODE_DISABLE_WORKFLOWS`, `workflowSizeGuideline` (small 5, medium 10, large 50, unrestricted; advisory), `CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS` (default 16), `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` (default 20, not enforced under ultracode), `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` (default 3), `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`, `--strict-mcp-config` (only `--mcp-config` servers), `--setting-sources` (which settings layers load), `skipWorkflowUsageWarning`.
- Baseline cost: a trivial turn in the owner's setup is about 40k input tokens, because the process loads the owner's personal MCP servers (206 tools from 5 servers in the e2e child), plugins and skills. Every agent of every workflow pays that on every call.

## 5. The design

### 5.1 Activity model: the process has a state of its own

Today Jolo knows runs. It must also know what the Claude process is doing between and after runs. Per hosted link (one per conversation) Jolo keeps an activity ledger built from the stream:

- tasks: task_id → {description, subagent_type, workflow run_id, phase (from task_updated when present), is_backgrounded, started_at, status, usage}. Opened by `task_started`, updated by `task_progress` / `task_updated`, closed by `task_notification`.
- activity state: `idle` (no open tasks, no turn), `working` (a run's turn in progress), `background` (turn ended, open tasks remain). Separate from run state; a run can be completed while the link is `background`.
- Jolo also sets `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1` and treats `session_state_changed` as a cross-check.

The ledger is stored with the session (events, so the UI replays it) and survives engine restarts as history; live state is rebuilt from the process.

### 5.2 Showing it: the task panel is Claude Code's task panel

- Conversation header or footer shows the activity line whenever it is not idle: `Working` / `Background work: 3 tasks · 412k tokens · 06:12`. With a workflow: `Workflow <name>: Verify 37/120 · 1.2M tokens`.
- The task panel (the existing child-tasks fold grows into this) lists open and recent tasks: description, phase, status, elapsed, tokens, with workflow agents grouped under their run and phase. Selecting a task shows its recent output (`get_task_output`).
- A workflow run shows phases with counts, exactly the information Claude Code's `/workflows` view draws from the same events. Full prompt/result detail per agent is a later step.

The workflow card (owner's reference: Claude Code's own card, e.g. `helmes-api-plan-review · Workflow · 3 agents · 9m 41s · ●●●●`). Jolo renders the same card, one per workflow run, in the task panel and in the child panel when the run belongs to a child:

| Element | Shown as | Source |
| :- | :- | :- |
| Title | the workflow's name | `meta.name` parsed from the Workflow tool call's `script` input (or `scriptPath` basename), which Jolo already sees as the tool_use; fallback: the first `task_started.description` of the run |
| Kind | `Workflow` | the task's `run_id` is a workflow run; a lone subagent shows `Agent`, a background command `Command` |
| Agent count | `3 agents` | number of `task_started` with this `run_id` |
| Elapsed | `9m 41s` | now minus the first `task_started` of the run, frozen at the last `task_notification` |
| Status dots | one dot per phase when the script declares phases, else one per agent; grey pending, amber running, green done, red failed/stopped | phase from the task record's `workflow_phase` where the stream carries it, else agent status from `task_notification` |
| Tokens | `1.2M` next to the elapsed time | sum of `task_progress.usage.total_tokens` for the run |
| Chevron | opens the run: phases → agents → one agent's recent calls and result | `task_updated` / `get_task_output` |
| Actions | Stop run (`stop_task` on the run's tasks), stop one agent, pause/resume where Claude Code exposes it | §5.3 |

The card appears the moment the first `task_started` of a run arrives, before any result, and stays after the run ends with its final state. A `Large` badge joins it under the rule in this section.
- Jolo marks a run `Large` when its open plus finished agents exceed the size guideline in force (default 25, Claude Code's own threshold) or its tokens pass a settings threshold. Advisory badge, like Claude Code's.
- `away_summary` content is shown as a system message in the conversation when it arrives.

### 5.3 Controls: everything Claude Code's REPL can do

- Stop (exists): `interrupt` with `cancel_queued: true`. Ends the turn. Background work is listed, not killed: Jolo declares `perTaskStopAffordance: true` at `initialize`, which is exactly what Claude Code asks of a host that offers per-task stop.
- Stop background work: available whenever the activity line shows background work, during or after a run. Sends `stop_task` for every open task (workflows included), then shows `agents_killed` / `task_notification stopped` as they arrive. A second press within a short window escalates to interrupt, mirroring the REPL's "press again".
- Per task: stop (`stop_task`), background (`background_tasks` with the tool_use_id), view output.
- Answer any dialog (5.4).
- Process close happens only when: the person stops all work and the link is idle; the task is archived or deleted; the agent or its configuration changes; the engine stops; or the idle timeout elapses with the link idle. The idle timer no longer counts while tasks are open (today it is reset by every message, which hides the problem rather than solving it; with the ledger it is simply not armed while `background`).
- Close order: `stop_task` for open tasks, `interrupt`, EOF, SIGTERM after grace, SIGKILL last. Grace values are settings.
- A process in `background` has no lifetime cap by default (my call): the person sees it and can stop it, which is how Claude Code's own `-p` mode treats a background command. An optional setting `limits.maxBackgroundMinutes`, default off, stops all tasks and shows a notice when a link has been in `background` longer than that.
- Degrade by capability (my call): Jolo reads `capabilities` from `system/init`. If `stop_task` is not supported, Stop background work falls back to `interrupt`; unknown control replies are logged, never fatal.
- `CLAUDE_CODE_FORWARD_SUBAGENT_TEXT` is a setting, default off: the task panel shows a subagent's tool calls and summaries as Claude Code's REPL does; full subagent text is opt-in because of stream volume.

### 5.4 Dialogs: Claude's questions reach the person

- A `can_use_tool` request with `requires_user_interaction: true` (or for a tool in `DIALOG_TOOLS = ['AskUserQuestion', 'ExitPlanMode']`) is a dialog, not a permission: no permission record, a dialog record instead, published as `dialog.requested`, answered by `dialog.resolve { response }` (merged into `updatedInput`, allow) or `dialog.dismiss { message }` (deny). Stop denies with "The run was stopped in Jolo."; a withdrawal by Claude cancels it silently.
- Each kind renders as a Jolo dialog card next to permission cards, with the same board/notification plumbing. The run shows `awaiting_user` while a dialog is open. Answer, decline, and cancel map to the request's response shape.
- Background subagents' questions behave as permission requests do today (a short run holds the question).

### 5.5 Delegation = native subagent semantics

- A child's live stream is visible under the parent (exists), with the activity line and task panel of 5.2.
- The child's turn text goes to the parent as today. The delegation state is `working` while the child's link is `working` or `background`; it is `completed` only when the child's link is idle and its last result is on record. `delegation_status` reports both the run state and the activity state, so a parent cannot mistake "waiting on the workflow" for the answer.
- When the child's background work finishes and Claude writes its follow-up turn (Claude Code's task-notification turn), that text is delivered to the parent as a child notification: the parent run, if still live, receives it as a tool-result continuation of its `delegation_status` wait; if the parent run has ended, Jolo starts a continuation run for the parent with the notification, the same way it already carries Claude's own self-started turns. The person sees the child's follow-up in the child panel and the parent's reaction in the conversation.
- Waiting is free: `delegation_status` with `waitMs` suspends the parent inside Jolo without a model call; the cap rises from 25 s to a settings value (default 10 min) and the wait ends on any child event (result, notification, dialog, activity change). The 30-second poll loop that cost 18 percent of the window goes away.
- Long waits and Claude Code's auto-backgrounding (my call): Claude Code moves an MCP tool call that runs longer than `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` (default 2 min) to a background task and ends the parent's turn; the call's eventual result then wakes the parent as a task-notification turn. That is the native shape, so Jolo keeps it: a long `delegation_status` wait becomes a background task (visible in the parent's task panel as "waiting on child <title>"), the parent's link is `background`, and the child's result arrives as a continuation run. Jolo does not disable auto-backgrounding. For non-Claude parents (Codex, Antigravity) the wait cap stays at the transport's tool deadline until each transport is checked.
- While the child is `working` or `background`, `delegation_status` still returns the child's latest text as `output` with `partial: true`, so a parent can relay progress; the final text replaces it when the state becomes `completed`.
- Stop cascades: stopping the parent run stops its children (exists); stopping a child stops its tasks first (5.3), then its turn. Nothing is closed silently; the child task shows what was stopped.

### 5.6 Cost controls: optional, visible, the person's choice

All in settings, with finite defaults; none change what the model may do unless the person turns them on.
- Window gate: Jolo already reads the 5-hour window utilization (usage ring). Setting `limits.windowGatePercent` (default 80): above it, `delegate_task` refuses to start a new child with a clear message, and the conversation header shows the window percentage. Starting a conversation turn is never refused; the person is there.
- Budget cap per task: `budgets.maxBudgetUsd` for children and, separately, for conversations; default off. Passed as `--max-budget-usd`. Shown in the task header when on. Label it "Claude's cost estimate".
- Claude Code knobs passed through from settings, default unset: `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`, `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`, `CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS`, `CLAUDE_CODE_DISABLE_WORKFLOWS`, `workflowSizeGuideline`. One settings group, each key documented with Claude Code's default.
- Workflow approval card: Jolo adds a permission `ask` rule for `Workflow` through `--settings` so every launch reaches Jolo's permission card in host mode. The card shows the workflow name, phases, the agent count the script declares when it is static, and a token caution, with Once / Always / Deny. This is the Desktop app's behavior and replaces both the silent launch of 2026-10-22 and the `--disallowedTools Workflow` denylist of the interim patch.
- Child baseline: children start with `--strict-mcp-config` (only Jolo's bridge) and `--setting-sources project`, so a delegated child does not carry the person's personal MCP servers and plugins into every call. Setting `children.leanStartup`, default on. My call, marked for the owner: it makes children cheaper and more predictable; it also means a child cannot use the person's personal plugins or MCP tools, which a conversation still can.
- Effort and ultracode stay as the person chooses them everywhere. The model menu shows one line of what ultracode does ("plans a workflow for every substantive task; much higher usage") and the current window percentage. No silent coercion. Owner decision; see §8.

### 5.7 Accounting: never zero when it is unknown

- Per task tokens from `task_progress`; per turn and per tree from `result.modelUsage` and `total_cost_usd` deltas between consecutive results of the same process; per session totals from `get_session_cost` when available.
- Continuation runs carry the usage of the work they report instead of 0; a run whose usage is not known shows `unknown`.
- The usage ring keeps showing the window percentage from `get_usage`; the task panel shows tokens and the estimate side by side.

### 5.8 Same model for plans and conversations

The activity ledger is per Claude process, so plan task sessions and ordinary conversations get the activity line, the task panel, the stop controls and the dialogs for free. The orchestrator treats a plan task as finished only when its link is idle, with the same rule as delegation.

## 6. Migration from the interim patch

`jolo-delegated-child-guard.patch` (close the child process at run end; `--disallowedTools Workflow`) was a stopgap. Under this design:
- "close at run end" is replaced by the activity-aware lifecycle of 5.3 and the completion rule of 5.5; a child is closed when its work is done or the person stops it.
- the Workflow denylist is replaced by the approval card of 5.6 and the optional `disableWorkflows` setting.
The owner may ship the stopgap first and remove it when 5.3 and 5.5 land; the e2e scripts in `jolo-delegated-child-guard.e2e/` are reused as the real-binary checks for this design.

## 7. Phasing

Phase 1, the incident cannot repeat unseen: activity ledger (5.1), activity line and task panel (5.2), stop background work and per-task stop (5.3), completion rule and free waiting for delegation (5.5), dialogs (5.4).
Phase 2, the person can bound it: window gate, budget cap, knob pass-through, Workflow approval card, lean child startup (5.6).
Phase 3, polish: accounting from `modelUsage` deltas and `get_session_cost` (5.7), away summary, plan integration (5.8), per-agent detail in the panel.

## 8. Owner decisions still open

1. Ultracode for delegated children: keep selectable with the explanatory line (this design), or remove it from the child menu. Measured on 2026-10-23: the same review prompt under ultracode without Workflow spawned 3 agents, returned a status line, and delivered nothing in 9 minutes for 3.98 estimated dollars; under xhigh it delivered a complete review in 5 minutes for 2.30. With 5.5 in place the ultracode child's follow-up would eventually reach the parent, at the higher cost.
2. Lean child startup default (5.6): on, as proposed, or off.
3. Window gate default percentage, and whether the gate also pauses a conversation's own background work at a higher threshold (this design: no, the person is there and can stop it).
4. Client scope for Phase 1: the task panel, activity line and dialog cards in the Desktop app first, with the terminal client showing the same as plain status lines and text prompts; or both clients fully in Phase 1. This changes the size of the plan.

## 9. Left to the builder

- Exact field names of `task_updated` patches for phase and label; confirm with a two-agent workflow probe before building the tree view (`--max-budget-usd 1`). The binary's task record carries `workflow_phase`, `toolCalls`, `lastToolName`, `lastToolSummary`, `resultPreview`, `promptPreview`, `outputFile`, `usage`, `status`, `description`; a `task_updated` patch holds the fields that changed. Which of these reach the stream is what the probe settles.
- Where the activity ledger lives (storage events vs in-memory on the link) and how the UI subscribes.
- Dialog payload and response shapes per kind; read them from the binary schemas (`describe(...)` strings) and confirm with one probe each.
- Settings schema entries and their migration for existing profiles, following the `budgets.hostedToolDeadlineMs` precedent.
- Fake Claude fixture extensions: task events, `stop_task`, dialog-style `can_use_tool` with `requires_user_interaction`, `session_state_changed`, delayed exit while tasks are open.

## 10. Verification

- Unit and integration tests against the fake binary for every control and state transition above, red before green.
- Before building 5.6's approval card, one capped probe (`--max-budget-usd 2`) that a `permissions.ask: ["Workflow"]` rule passed through `--settings` makes a Workflow launch reach the host's `can_use_tool` in host mode, including with `--effort ultracode`. If it does not, the fallback is `disableWorkflows` per task plus an explicit "allow workflows for this task" switch that restarts the process without it.
- Real-binary e2e, extending `jolo-delegated-child-guard.e2e/`: a child that starts a background command; a child that launches a two-agent workflow (capped); a dialog of each declared kind; stop background work during and after a run; delegation completion only when idle; parent notified of the child's follow-up; window gate refusal.
- Acceptance for Phase 1 is the incident replayed with a capped workflow: the person sees the workflow in the panel, the delegation stays `working`, Stop background work ends it, the parent receives the stop notice, no process is killed silently, and spend is shown.
