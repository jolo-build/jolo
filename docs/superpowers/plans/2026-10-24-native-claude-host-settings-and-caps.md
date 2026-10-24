# Native Claude Host, Plan 3: Settings and Caps — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Status: plan only, written 2026-10-24; nothing in it is implemented.**

**Goal:** Let the person bound what a hosted Claude Code process may spend, without Jolo deciding on its own what the model may do: a usage-window gate on starting children, an optional cost cap per task, Claude Code's own concurrency and workflow knobs passed through from settings, an approval card for every Workflow launch, a lean startup for delegated children, an optional lifetime for background work, and honest accounting; plus the three engine hardenings the Plan 1 handoff left for this plan (bridge in-flight cap, activity payload truncation, the Large threshold as a setting).

**Architecture:** Every limit is a setting with a finite default under one new `limits` group (and `children` for child startup), following the `BudgetSettingsSchema` / `BudgetPatchSchema` / `SettingsService` pattern: defaults on read, not on patch, so existing profiles get them without a migration. The engine applies them where the process is started (`claudeArgv` and `hostedEnvironment` in `claude-stream.js`), where a child is admitted (`delegation/index.js` `start()`), where the bridge admits calls (`search/mcp.js`), and where the ledger is published (`activityPayload`). The desktop shows them in a `Limits` section of Settings, a window percentage in the conversation header, a cost label in the task header, and a Workflow approval card drawn by the existing permission card from a request the engine already produces. Spec §5.6 and §5.7 are the authority; §2's anti-goals bind every task (no silent coercion of what the person chose; never a 0 for unknown spend).

**Tech Stack:** Bun 1.4.3, plain JavaScript (ESM/JSX), zod in `packages/protocol`, bun:sqlite preferences, React 19 + Electron desktop, `bun test`, the fake Claude fixture.

**Spec:** `docs/superpowers/specs/2026-10-23-native-claude-hosting-design.md` §5.6, §5.7, §8, §10; scope from `docs/superpowers/plans/2026-10-23-native-claude-host-engine-handoff.md` "Plan 3 (settings and caps) should own"; Plan 2's `LARGE_RUN_AGENTS` constant (`2026-10-24-native-claude-host-desktop-ui.md` D3).

## Decisions taken in this plan (the owner may overturn any)

- **D1 One settings group, finite defaults.** `settings.limits = { windowGatePercent: 80, maxBackgroundMinutes: null, largeRunAgents: 25 }`, `settings.budgets.maxBudgetUsd = { conversation: null, child: null }`, `settings.children = { leanStartup: true }`, `settings.claudeCode = { maxConcurrentSubagents: null, maxSubagentSpawnDepth: null, workflowMaxConcurrentAgents: null, disableWorkflows: false, workflowSizeGuideline: null }`. `null` means "Claude Code's own default; nothing passed". Spec §8 defaults: lean startup on, gate 80 %.
- **D2 The window gate refuses only new children.** `delegate_task` answers `limit_exceeded` with the percentage and the reset time when the answering agent's five-hour window (from `agent.limits`, the same probe the usage ring uses) is at or above `windowGatePercent`; a conversation's own turn is never refused (spec §5.6, §8.3: the person is there). A probe that fails or has no window does not gate (fail open, logged); a stale report (older than the probe's minute) is refreshed first.
- **D3 Budget cap as Claude Code's own flag.** `--max-budget-usd <n>` is appended to `claudeArgv` for a child when `budgets.maxBudgetUsd.child` is set, and for a conversation when `.conversation` is set; the result subtype `error_max_budget_usd` ends the run `failed` with the failure text "Claude's cost estimate reached the cap of $n" (spec: label it as Claude's estimate). The task header shows `cap $n` while on.
- **D4 Knobs are passed as environment, verbatim.** Each non-null `claudeCode.*` value becomes the matching `CLAUDE_CODE_*` variable in `hostedEnvironment` (`workflowSizeGuideline` goes through `--settings` as `{ "workflowSizeGuideline": … }` since it is a settings key, not an env). Jolo never maps one value to another (anti-goal: no silent coercion). The settings UI documents each knob with Claude Code's default.
- **D5 Workflow approval reuses the permission card.** Jolo passes `--settings '{"permissions":{"ask":["Workflow"]}}'` (merged with D4's settings object) so every Workflow launch reaches `can_use_tool` in host mode; the existing permission path makes a `permission.requested` whose `summary` is `Workflow <meta.name>: <N> phases[, <K> agents]` and whose `script` is the script's `meta` block; the desktop's `PermissionDialog` gains a `workflow` variant: name, phase list, the agent count when the script declares it statically (a `parallel`/`pipeline` over a literal array), and the caution "Workflows run many agents at once and can spend a usage window quickly." with the existing Once / This task / This project / Deny choices (Claude Code's own card offers Once / Always / Deny; Jolo's scopes map onto them). Gated by spec §10's probe (Task 5 Step 0): if an `ask` rule through `--settings` does not reach the host under `--effort ultracode`, the fallback is `disableWorkflows` per task plus an "allow workflows for this task" switch that restarts the process without it.
- **D6 Lean child startup.** A delegated child (a run whose `execution.pinned` is set by `delegate_task`) starts with `--strict-mcp-config` and `--setting-sources project` when `children.leanStartup` is on; the child's task header says "lean: project settings and Jolo's tools only". Conversations are untouched.
- **D7 `maxBackgroundMinutes`.** When set, a link that has been `background` for longer stops all its tasks (`stopBackground`) and publishes a `session.activity` whose tasks carry `status: stopped`; the desktop shows a notice "Background work stopped after N minutes (Settings › Limits)". One timer per link, armed on entering `background`, cleared on leaving it.
- **D8 Bridge in-flight cap.** `delegation_status` waits do not count toward `MAX_IN_FLIGHT` in `search/mcp.js` (a wait holds no engine work); other calls keep the cap, raised from `MAX_ACTIVE + 4` to `MAX_CHILDREN + 4` so sixteen waiting children and their parent's other calls fit.
- **D9 Activity payload truncation to the frame.** `activityPayload` also bounds the serialized size: finished tasks are dropped oldest first until the JSON is under `FRAME_MAX_BYTES - 8 KiB`, then descriptions and phases are cut to 120 characters (a workflow's `workflow.phases[].title` and `workflow.current` with them, and its phases dropped if that is not enough, so 100 phase titles of 500 characters per workflow cannot overflow the 256 KiB frame), then running tasks beyond the first 100 are summarized as `{ truncated: true, running: n }`; `truncated: true` in all three cases.
- **D10 Accounting.** Per turn: `result.modelUsage` and `total_cost_usd` deltas between consecutive results of the same process become the run's usage (input/output tokens per model summed; `costUsd` added to `UsageSchema` as optional); a continuation run (Claude carrying on) carries the usage of the result that produced it instead of zeros; `get_session_cost` (when the binary answers it) feeds a per-conversation total shown in the usage panel as "Claude's cost estimate"; a run whose usage is not known shows `unknown`, never 0. Per task: `task_progress` tokens already flow (Plan 1).
- **D11 The Large threshold is a setting.** `LARGE_RUN_AGENTS` (Plan 2) reads `settings.limits.largeRunAgents`; the renderer receives settings already (`useEngineConnection().settings`). Dropped after Plan 2's whole-branch review (2026-10-24) for want of an agent count on the wire, and restored the same day: the probe of 2026-10-24 (`docs/superpowers/specs/claude-workflow-events.md`) found every agent of a workflow in its `task_progress.workflow_progress`, the engine keeps the count in `TaskRecord.workflow.agents.total`, and Plan 2's card badges a workflow `Large` past `LARGE_RUN_AGENTS = 25` (`workflowSummary` in `activity.js`).
- **D12 Out of scope.** Codex and Antigravity children; a cap on conversations' own background work (spec §8.3: no); any change to what the model may do by default.

## Global Constraints

- Owner rules: no over-engineering; nothing hardcoded (every value above is a setting with a finite default or `null` meaning "the binary's default"); secure by default (settings reach the process as flags and env only; nothing from a page or a tool result becomes a flag).
- Spec anti-goals: no guard silently changes what the person chose; no spend shown as 0 when unknown; nothing Claude started is killed except by the person's stop or a limit the person set (D7 says so in its notice).
- Protocol additive only; settings follow the `BudgetSettingsSchema` / patch / `settings.js` pattern; no migration (preferences are JSON with defaults on read).
- TDD per task; commit per task; `bun test` for the touched files, `bun scripts/typecheck.js`; integration tests against the fake Claude (`tests/fixtures/fake-claude.js` gains what each task needs: argv/env echo, a `--max-budget-usd` ending, a Workflow `can_use_tool`).
- Real-binary probes cost usage: one capped probe for D5 (Task 5 Step 0, `--max-budget-usd 2`), results recorded in `docs/superpowers/specs/`.

## Review Focus

1. A gate that fires while the usage probe is stale or failing: `delegate_task` must fail open (start the child, log the missing window), never refuse on no data. Pinned in Task 2.
2. A `--max-budget-usd` end mid-tool: the run ends `failed` with the cap text, the process stays (spec: the cap stops subagents and refuses new spawns; it does not kill the process), and the activity ledger reflects the stopped tasks. Pinned in Task 3.
3. The `--settings` JSON carrying both the `ask` rule and `workflowSizeGuideline`: one object, valid JSON, no shell quoting issue through `Bun.spawn` argv. Pinned in Task 4/5.
4. A child started lean whose prompt needs a personal MCP tool: the child's error is shown with the lean note so the person knows why; nothing retried silently. Pinned in Task 6.
5. 300 finished tasks with 500-character descriptions: the payload stays under the frame, `truncated` is true, running tasks are never dropped. Pinned in Task 8.

---

### Task 1: Settings groups and the Limits section

**Files:**
- Modify: `packages/protocol/src/schemas.js` (`LimitsSettingsSchema`, `ChildrenSettingsSchema`, `ClaudeCodeSettingsSchema`, `BudgetSettingsSchema.maxBudgetUsd`, their patch schemas, `SettingsSchema` and `settings.update` params), `apps/engine/src/settings.js` (read with defaults, patch-merge, keys `limits`, `children`, `claudeCode`), `apps/desktop/src/renderer/components/settings.jsx` (a `Limits` section: window gate %, max background minutes, large-run agents, budget caps, lean child startup, the five Claude Code knobs each with its Claude Code default in the help text)
- Test: `packages/protocol/test/schemas.test.js`, `apps/engine/test/settings.test.js` (or the existing settings test file), `apps/desktop/test/settings.test.jsx`

**Interfaces:**
- Produces `settings.limits = { windowGatePercent: int 0..100 default 80, maxBackgroundMinutes: int 1..1440 | null default null, largeRunAgents: int 1..1000 default 25 }`; `settings.budgets.maxBudgetUsd = { conversation: number > 0 | null, child: number > 0 | null }` default nulls; `settings.children = { leanStartup: boolean default true }`; `settings.claudeCode = { maxConcurrentSubagents: int | null, maxSubagentSpawnDepth: int | null, workflowMaxConcurrentAgents: int | null, disableWorkflows: boolean default false, workflowSizeGuideline: 'small' | 'medium' | 'large' | 'unrestricted' | null }`.
- `settings.update({ limits, budgets, children, claudeCode })` patches merge per group as `budgets` does.

- [ ] Step 1: protocol tests: each schema parses its defaults from `{}`, rejects `windowGatePercent: 101`, `maxBudgetUsd.child: 0`, `workflowSizeGuideline: 'huge'`.
- [ ] Step 2: engine test: `settings.get()` on an empty profile returns the defaults; `update({ limits: { windowGatePercent: 60 } })` keeps `largeRunAgents: 25`.
- [ ] Step 3: desktop test: the Limits section renders each field with its default and Claude Code's default in the help text (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`: 20, `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`: 3, `CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS`: 16, `workflowSizeGuideline`: medium (10)).
- [ ] Step 4: run red, implement, run green, commit `Add the limits, children and Claude Code knob settings with a Limits section`.

### Task 2: Window gate on `delegate_task`, and the window percentage in the header

**Files:**
- Modify: `apps/engine/src/delegation/index.js` (`start()` consults `limits.windowGatePercent` against the answering agent's five-hour window from `agentLimits.report(agentId)`), `apps/engine/src/agents/limits.js` (a cached `report(agentId, { maxAgeMs })` the gate can call), `apps/desktop/src/renderer/components/workspace-pane.jsx` (header shows `NN % of window` from the same `agent.limits` report the usage ring keeps, only when a gate is set and the agent reports windows)
- Test: `apps/engine/test/delegations.test.js` (fixture gains `agentLimits` stub), `apps/desktop/test` (header render)

**Interfaces:**
- `delegate_task` → `ProtocolError('limit_exceeded', "The usage window is at 84 %, above the 80 % gate; it resets in 1h 12m (Settings › Limits).")` when gated; fail open on no window or a failed probe (Review Focus 1).

- [ ] Step 1: unit tests: gated at 84/80; not gated at 79; not gated when the report has no window or the probe throws (child starts, a warn is logged); the message names the reset time.
- [ ] Step 2: desktop test: header shows `84 % of window` with a gate of 80 and hides it when `windowGatePercent` is 100 or no window is reported.
- [ ] Step 3: red → green → commit `Refuse new child tasks above the usage-window gate, and show the window in the header`.

### Task 3: Budget cap per task

**Files:**
- Modify: `apps/engine/src/agents/claude-stream.js` (`--max-budget-usd` from `budgets.maxBudgetUsd.child` for a delegated run, `.conversation` otherwise; the `error_max_budget_usd` result subtype → outcome `failed` with the cap text), `tests/fixtures/fake-claude.js` (echo argv in a scenario `argv`; scenario `budget-cap` emits `result` with `subtype: "error_max_budget_usd"` after a `task_started`), `apps/desktop/src/renderer/components/task-header.jsx` (`cap $n` when the session's run execution carries the cap)
- Test: `tests/integration/claude-stream.test.js`, `apps/desktop/test`

- [ ] Step 1: integration: with `budgets.maxBudgetUsd.child = 2`, a delegated child's argv contains `--max-budget-usd 2` and a conversation's does not; the `budget-cap` scenario ends the run `failed` with "Claude's cost estimate reached the cap of $2" and the process stays alive (Review Focus 2).
- [ ] Step 2: desktop: the task header shows `cap $2` for a child session whose latest run carries it.
- [ ] Step 3: red → green → commit `Pass an optional cost cap to Claude Code and say when it ends a task`.

### Task 4: Claude Code knobs passed through

**Files:**
- Modify: `apps/engine/src/agents/claude-stream.js` (env from `claudeCode.*` via `hostedEnvironment`; `--settings` JSON builder shared with Task 5), `tests/fixtures/fake-claude.js` (scenario `env` echoes the `CLAUDE_CODE_*` variables it sees and the parsed `--settings`)
- Test: `tests/integration/claude-stream.test.js`

- [ ] Step 1: integration: with `claudeCode = { maxConcurrentSubagents: 4, disableWorkflows: true, workflowSizeGuideline: 'small' }` the process sees `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=4`, `CLAUDE_CODE_DISABLE_WORKFLOWS=1`, and `--settings` parses to `{ workflowSizeGuideline: 'small', permissions: { ask: ['Workflow'] } }` (Review Focus 3); with all null, no variable and no `workflowSizeGuideline` key.
- [ ] Step 2: red → green → commit `Pass Claude Code's subagent and workflow knobs through from settings`.

### Task 5: Workflow approval card

**Files:**
- Probe first (Step 0, real binary, `--max-budget-usd 2`, once): a `permissions.ask: ["Workflow"]` rule through `--settings` makes a Workflow launch reach `can_use_tool` in host mode, including under `--effort ultracode`; record in `docs/superpowers/specs/claude-workflow-approval.md`. If it does not, implement D5's fallback instead and say so in the record.
- Modify: `apps/engine/src/agents/claude-stream.js` (`describeTool` for `Workflow`: summary `Workflow <meta.name>: <N> phases[, <K> agents]`, script = the `meta` block; `permissions.ask` rule in `--settings` unless `disableWorkflows`), `apps/engine/src/agents/claude-dialogs.js` (Workflow is a permission, not a dialog), `apps/desktop/src/renderer/components/permission-dialog.jsx` (`workflow` variant per D5), `tests/fixtures/fake-claude.js` (scenario `workflow <name> <phases>` sends `can_use_tool` for `Workflow` with a script literal)
- Test: `tests/integration/claude-stream.test.js`, `apps/desktop/test/permission-dialog.test.jsx`

- [ ] Step 1: integration: the scenario yields `permission.requested` with the summary and script above; `allow_once` lets it run; `deny` ends with the fixture's "Workflow refused" text.
- [ ] Step 2: desktop: the card shows the name, the phases, `3 agents` for a static array, and the caution; Once / This task / This project / Deny.
- [ ] Step 3: red → green → commit `Ask the person before Claude launches a workflow, with its name, phases and agent count`.

### Task 6: Lean child startup

**Files:**
- Modify: `apps/engine/src/agents/claude-stream.js` (`--strict-mcp-config`, `--setting-sources project` for a delegated run when `children.leanStartup`), `apps/desktop/src/renderer/components/task-header.jsx` (the lean note)
- Test: `tests/integration/claude-stream.test.js` (argv echo), `apps/desktop/test`

- [ ] Step 1: integration: a child's argv carries both flags with the setting on and neither with it off; a conversation's never does.
- [ ] Step 2: desktop: the child's task header reads `lean: project settings and Jolo's tools only`; an error mentioning an MCP server not found is shown with that note (Review Focus 4).
- [ ] Step 3: red → green → commit `Start delegated children lean: Jolo's tools and project settings only`.

### Task 7: `maxBackgroundMinutes`

**Files:**
- Modify: `apps/engine/src/agents/claude-link.js` (a per-link timer armed on entering `background`, calling `stopBackground()` and logging), `apps/engine/src/engine.js` (pass the setting; re-read on `settings.update`), `apps/desktop/src/renderer/use-engine.js` / `engine-context.jsx` (notice on the `session.activity` that follows, keyed by a new optional `reason: 'max_background_minutes'` field on `ActivitySchema`)
- Test: `apps/engine/test/claude-link.test.js` (fixture `tasks 2 60000`, setting 1 minute shortened by an exported constant for tests), `apps/desktop/test`

- [ ] Step 1: unit: with the limit in force the tasks end `stopped` after the window and the activity carries the reason; with `null` they run on.
- [ ] Step 2: desktop: the notice text per D7.
- [ ] Step 3: red → green → commit `Stop background work after a person-set number of minutes`.

### Task 8: Bridge in-flight cap and activity payload truncation

**Files:**
- Modify: `apps/engine/src/search/mcp.js` (`MAX_IN_FLIGHT = MAX_CHILDREN + 4`; `delegation_status` exempt), `packages/protocol/src/schemas.js` (`activityPayload` size bound per D9, `FRAME_MAX_BYTES` imported from `framing.js`)
- Test: `apps/engine/test/hosted-mcp.test.js`, `packages/protocol/test/schemas.test.js`

- [ ] Step 1: protocol test: 300 finished tasks with 500-character descriptions and 150 running ones serialize under the frame, running tasks all present (or summarized past 100), `truncated: true` (Review Focus 5).
- [ ] Step 2: bridge test: 17 concurrent `delegation_status` calls proceed while a search call still waits behind the cap.
- [ ] Step 3: red → green → commit `Exempt delegation waits from the bridge cap and keep activity under the frame limit`.

### Task 9: Accounting from Claude's own numbers

**Files:**
- Modify: `apps/engine/src/agents/claude-stream.js` (usage from `modelUsage` deltas and `total_cost_usd` per result; continuation runs carry their result's usage), `packages/protocol/src/schemas.js` (`UsageSchema.costUsd` optional; `session.cost` RPC `{ sessionId } → { costUsd | null, source: 'get_session_cost' | 'results' }`), `apps/engine/src/rpc/handlers.js`, `apps/desktop/src/renderer/components/composer.jsx` (usage panel: "Claude's cost estimate $n" or `unknown`), `tests/fixtures/fake-claude.js` (results with `modelUsage` and `total_cost_usd`; `get_session_cost` answer)
- Test: `tests/integration/claude-stream.test.js`, `apps/desktop/test`

- [ ] Step 1: integration: two turns on one process report per-turn token and cost deltas, not cumulative totals; a continuation run has the usage of its result, not zeros; `session.cost` returns the fixture's number.
- [ ] Step 2: desktop: the panel shows the estimate with its label, and `unknown` when null (never 0).
- [ ] Step 3: red → green → commit `Account Claude's spend per turn from its own usage report, labelled as its estimate`.

### Task 10: The Large threshold as a setting

**Files:**
- Modify: `apps/desktop/src/renderer/activity.js` (`workflowSummary(task, { largeRunAgents })`, `LARGE_RUN_AGENTS` as its default), `apps/desktop/src/renderer/components/activity-panel.jsx` (a `largeRunAgents` prop for the workflow card), `apps/desktop/src/renderer/components/workspace-pane.jsx` (pass `settings.limits.largeRunAgents`)
- Test: `apps/desktop/test/activity.test.js`, `apps/desktop/test/activity-panel.test.jsx`

- [ ] Step 1: test: a workflow of 26 agents (`workflow.agents.total`) is large at the default and not at 50.
- [ ] Step 2: red → green → commit `Read the Large badge threshold from settings`.

### Final
- Full suite (`TMPDIR=/tmp/jt bun run test`), typecheck, `bun run desktop:smoke`, `--background-work`; one capped real-binary run of the workflow probe (Task 5 Step 0) recorded; changelog lines per task.
