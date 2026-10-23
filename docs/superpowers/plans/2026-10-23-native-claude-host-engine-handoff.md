# Native Claude Host, Plan 1 — handoff (2026-10-23)

Branch `feat/native-claude-host` in /Users/ejabbarli/Desktop/jolo, based on upstream main f70bfc6. Plan 1 (engine core, 8 tasks) is implemented, task-reviewed, whole-branch-reviewed, fix-waved and re-reviewed. Spec: `docs/superpowers/specs/2026-10-23-native-claude-hosting-design.md`. Plan: `docs/superpowers/plans/2026-10-23-native-claude-host-engine.md`. Probe records: `docs/superpowers/specs/claude-dialogs.md`, `docs/superpowers/specs/claude-stop-semantics.md`.

## Verification state
- Full suite on the branch: 1225 pass, 7 fail; six are the known upstream-main failures (tgrep MCP, packaging needs Bun 1.3.12, two TUI signal tests, guest credential, run dedup); the seventh (`agent-context-sync` "paused again while finishing its commands") is a load-induced flake: 2/2 alone on the branch, 2/2 on upstream main, 9/9 for the whole file.
- After the fix wave: integration 109/0, engine 281/2 (the two known), packages 109/0, desktop 203/0, typecheck clean.
- Real-binary e2e (Claude Code 2.1.304), twice, before and after the fix wave: a delegated child that starts a background command → `delegation_status` reports `state completed, activity background, done false, partial true`; the child's activity lists the running task; `session.stopBackground` → `requested 1, stopped 1, escalated false`; then `activity idle, done true`; the child's process stays alive; no command left. Evidence in `helmes-api/jolo-delegated-child-guard.e2e/` (`run3.js`, `results3.json`, `results3b-after-fix-wave.json`).

## Release gate
This engine work is not to be merged or released on its own (CHANGELOG, Unreleased, first line). Alone it removes the only Stop for background work the current clients have and strands Claude's questions (`dialog.requested`) without a card. It ships together with Plan 2 (Desktop UI).

## Fix before merge (open, small)
1. `apps/engine/src/delegation/index.js` `check()`: a paused or asking **later** run of the child conversation (a continuation that paused on budget, a background question's short run) does not end a `delegation_status` wait; the wait holds until `maxWaitMs`. Test `ASKING_STATES` against `storage.listRunsForSession(child.sessionId)`, not only the delegated run; add a unit test with a paused later run. Regression against pre-branch behaviour, where `ended` included `paused`.

## Owner decisions to confirm
- A paused or failed parent also stops its completed children's background work (`STOPPED_STATES` includes `paused`/`failed`). This mirrors the existing cancelling of child runs on a parent pause; confirm or narrow to cancelled/failed/interrupted.
- Ultracode stays selectable for delegated children (spec §8 default); the measured outcome (ultracode child: 3 agents, status line, nothing delivered in 9 min, 3.98 USD; xhigh: full review in 5 min, 2.30 USD) argues for xhigh as the child default.

## Plan 2 (Desktop UI) must own
- Activity line and task panel with the workflow card (spec §5.2) from `session.activity` events + transient `activity` notifications (`client.onActivity`; `packages/client/src/reconnect.js` needs the hook); `session.activity` RPC for late joiners.
- Stop background work and per-task stop buttons (`session.stopBackground`, `session.stopTask`); a force-stop that closes the process for tasks that ignore `stop_task` (spec §5.3 "press again" needs correcting: an interrupt cannot kill them under `perTaskStopAffordance`).
- Dialog cards for `dialog.requested` (AskUserQuestion answers → `dialog.resolve { response: { answers } }`; ExitPlanMode approve → `dialog.resolve { response: {} }`, reject → `dialog.dismiss`); open dialogs listed for a late-joining client (`session.page` has `pendingPermissions` only — engine change).
- Delegation UI: show `activity`, `done`, `partial`; a wake reason for the parent (why `delegation_status` returned) — small engine addition.
- The desktop main-process allow-list already has the five new methods (`e7f92f0`).

## Plan 3 (settings and caps) should own
- Window gate, budget cap, Claude Code knob pass-through, Workflow approval card, lean child startup (`--strict-mcp-config`, `--setting-sources`), `maxBackgroundMinutes` (spec §5.6).
- Bridge in-flight cap: exempt long `delegation_status` waits or size from `MAX_CHILDREN` (16), not `MAX_ACTIVE` (4) (`apps/engine/src/search/mcp.js` `MAX_IN_FLIGHT`).
- Payload-level truncation of `session.activity` to the frame limit (per-field bounds alone allow 145+ maximal tasks to exceed 256 KiB; adversarial only).
- Accounting (spec §5.7): usage from `result.modelUsage` deltas, `get_session_cost`, task summaries from the follow-up turn.

## Deferred minors (all reviewed, none block)
See the task sections of the SDD ledger, reconstructed here in short: activity timer not flushed at process end; `finish()` last-word-wins on status; untested status-map branches; loose coalescing assertion; `TASK_HISTORY_LIMIT` two meanings; `activityPayload` in the protocol package; `stopped` undercount after a refusal; Stop-test timing slack; unref'd stop timers; `askPerson` catch unlogged; speculative asked-again guard; `check()` throw leaves a waiter; completed-parent-keeps-wait untested; `3_600_000` repeated; `view()` O(rows×runs); worst-case graceful close ~7 s vs the 6 s shutdown step; plan cancel while deferred ends `done` not `cancelled`; restart during a deferral marks the task interrupted; session deleted while deferred never wakes; older-subscriber gate test is a pure negative; parent Stop runs the stop cascade twice; duplicate desktop allow-list lines; migration 0019 checksum changed (no known profile ran the earlier one).

## Protocol facts the branch rests on (verified against 2.1.304)
`task_started/progress/notification/updated` events; `stop_task` control (0.2 s to `stopped`); `perTaskStopAffordance` in `initialize` makes an interrupt spare background commands and subagents; AskUserQuestion/ExitPlanMode arrive as `can_use_tool` with `requires_user_interaction: true` (no `request_user_dialog`), answered with `allow` + merged `updatedInput`, or `deny`; `-p` waits for background work after stdin closes; SIGKILL orphans background shells; `--max-budget-usd` covers subagents.
