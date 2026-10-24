# Native Claude Host, Plan 2 (Desktop UI): verification record

Branch `feat/native-claude-host`, verified 2026-10-24 on the final tree of Plan 2 (twelve tasks, each implemented by a fresh Opus subagent and gated by a task review; seven needed one fix round, none more), after the whole-branch review (Opus) and its fix wave (six items, re-reviewed). Plan: `2026-10-24-native-claude-host-desktop-ui.md`. Machine: macOS, Bun 1.4.3, Electron 44.9.3, Claude Code 2.1.304 at `/Users/ejabbarli/.local/bin/claude`.

## Typecheck

`bun run typecheck`: `24 programs type-check cleanly`.

## Full suite

`mkdir -p /tmp/jt; TMPDIR=/tmp/jt bun run test` (the whole of `tests packages apps`, run alone), on the final tree after the whole-branch review's fix wave: **1332 pass, 4 fail, 5 skip**, 1341 tests across 185 files, 453.3 s. (The run before the fix wave: 1323 pass, 4 fail, the same four.)

The four failures are all in the known upstream-main set:

| Test | Known cause |
| :- | :- |
| `tests/integration/tgrep.test.js` "hosted stdio MCP searches only its pinned workspace through the engine" | no `rg` on this machine |
| `tests/integration/packaging.test.js` (reported as "(unnamed)") | release builds require Bun 1.3.12; this machine runs 1.4.3 |
| `apps/engine/test` "guest credential cannot claim interactive authority, cross workspaces, or survive revocation" | known upstream-main failure |
| `apps/engine/test` "run request deduplication precedes task lookup and failed lookup cannot admit work" | known upstream-main failure |

The two TUI SIGINT/SIGTERM tests passed in this run, as did `agent-context-sync` (no rerun needed).

## Desktop smokes (final tree, after the fix wave)

- `bun apps/desktop/scripts/build.js && bun apps/desktop/scripts/smoke.js --background-work` (new in Plan 2): **green**, exit 0, twice (before and after the fix wave). Final `smoke.json` checks: "renderer opened a project through the narrow bridge"; "background work is listed and stopped from the Activity panel; AskUserQuestion and ExitPlanMode are answered from dialog cards; tasks that ignore Stop background work are ended by Force stop after the Close process confirmation and read failed; a workflow names the activity line, shows as one card titled with its name, and Stop background work ends it". Screenshots in `apps/desktop/smoke-results/`: `background-work.png` (activity line + Activity panel with two running tasks), `dialog-question.png` (AskUserQuestion card), `dialog-plan.png` (ExitPlanMode card), `force-stop.png` (stubborn tasks, "Some tasks did not stop · Force stop", the confirmation), `workflow.png` (line `Workflow demo · 00:00`, one card titled `demo`). What the smoke drives against the fake Claude: `tasks 2 20000` → `Background work: 2 tasks` and two running rows → `Stop background work` ends both → `ask-user tea or coffee?` → `coffee` + `Answer` → `You answered: coffee` → `exit-plan Ship it` → `Approve plan` → `Plan approved: Ship it` → `tasks-stubborn 2` → Stop → `Some tasks did not stop` → `Force stop` → `Close process` → rows `failed`, line gone → `workflow demo 20000` → line and card → Stop ends it.
- `bun run desktop:smoke` (the default suite): **not green in this session**, four runs on the final tree (after the suite, nothing else running): each failed at `apps/desktop/smoke/sidebar-smoke.js:52` "sidebar drag did not resize aligned header and workspace" with identical numbers (`sidebar 256 → 256`): the CDP-driven drag of the sidebar divider had no effect. The run of the same suite during Task 11 (same tree minus the changelog commit and the fix wave) passed that step and every later one and failed only at the last, `queue-smoke.js` "queued message removed", the queue race recorded as a known failure before this work. This branch's diff against its base (`f70bfc6`) touches none of `sidebar.jsx`, `sidebar-chat-row.jsx`, `app.jsx`, `sidebar-layout.js`, `sidebar-smoke.js`, and no sidebar rule in `styles.css`; the `Activity` panel entry and the new components are not on screen at that step; a leftover `fake-acp.js` fixture process from an earlier smoke was found and stopped, with no change. The failure is read as environmental (the window not receiving the synthetic drag while the machine was in use), not as a regression; it is reported here as a requirement not met, with the earlier pass and the `--background-work` smoke as the evidence for the new UI.

## Real-binary check (installed Claude Code 2.1.304 through the engine)

Script: a copy of `jolo-delegated-child-guard.e2e/run3.js` (kept outside the repo as `scratch-e2e/run4.js`, not committed) with the `wakeReason` and `session.page` fields added. It starts a real engine on a temporary profile, a fake parent held on a permission, and delegates to `^agent:claude/default`, the installed binary, with the prompt "Use your Bash tool with run_in_background set to true to start exactly this command: sleep 60 …". Run three times on 2026-10-24, the last two on the final tree after the fix wave (results in `scratch-e2e/results4.json`):

| Step | Result |
| :- | :- |
| `delegation_status` after the child's first answer (12.6 s) | `state completed, activity background, done false, partial true, output "started"` (no `wakeReason`: no wait was made) |
| the child's `session.activity` (what the activity line and the Activity panel draw) | `state background`, one task `description "Sleep for 60 seconds in background", status running, backgrounded true, taskType "local_bash", runId "0mvln6jk1-d31c7c64"` (a per-task run id, as the whole-branch review established: the renderer now shows it as a `Command` row, not as a workflow); the child's three Claude processes alive; a `sleep 60` process running |
| `session.stopBackground` on the child | `{ requested: 1, stopped: 1, escalated: false }` |
| `delegation_status` with `waitMs: 20000` | returned at once: `activity idle, done true, partial false, wakeReason "done"` |
| after the stop | the same three Claude pids alive (the process was not killed); no `sleep 60` left; the child's activity `idle` with the task `stopped`; durable `session.activity` sequence `working, working, background, idle`; `session.page.pendingDialogs` is `[]` |

That is the sequence the Plan 2 UI renders: the task appears as a running row and on the activity line, Stop background work ends it, the line disappears, the delegation line in the parent reads `done`, and the wake reason names why the parent's wait returned. The dialog cards were exercised against the real binary in Plan 1's probe (`claude-dialogs.md`); here they are exercised against the fake Claude in the smoke above, whose protocol shape was taken from that probe.

## Final checks after Tasks 13–26 (2026-10-25, commits 930a635 and 4fe497d)

Twelve tasks followed Plan 2 at the owner's request (workflow agents and phases, the panel laid out like Claude Code's,
per-agent lines and task detail, a square stop per task and a Workflow card in the chat, copy and time on messages,
chat titles from the answerer's cheapest model with a shimmer and a typed title, the agent table, child tasks in the
panel, activity history across processes with migration 0020, agent kind and model, one delegation line per child,
task output on demand with the MCP line and the away summary, the stop taken off the composer's line). Each was
reviewed on its own (Opus), with fix rounds where asked; a whole-branch review covered e3ef8a9..930a635 and its two
Important findings (clients created chats already titled, so the model never named them; a task carried over from an
earlier process showed Claude's raw error for its output) and eight Minors were fixed in 4fe497d, re-reviewed clean.

- `bun scripts/typecheck.js`: 24 programs clean.
- Full suite alone (`TMPDIR=/tmp/jt bun run test`): 1515 pass, 4 fail in 479 s on 930a635, and 1521 pass, 4 fail in
  482 s on 4fe497d after the whole-branch review's fixes; the four are the known ones on this machine (tgrep needs
  `rg`; packaging needs Bun 1.3.12; guest-credential EPIPE; run-dedup's fake storage).
- `--background-work` smoke: green from a fresh build at each task (tasks, stop square, dialogs, force stop, workflow
  card and table, output pane, MCP line, persistence across Force stop, Clear finished); `--delegation` smoke green
  (child tasks in the panel, one line per child).
- Default desktop smoke (`bun run desktop:smoke`): the sidebar-drag step passed this time; it stops at the known
  "queued message removed" step (the queue smoke clicks Remove while the run still has its optimistic id — pre-existing
  on main, not touched by this branch).
- Real binary (Claude Code 2.1.304): probed `workflow_progress`, `send_now`, the one-shot title call
  (`--setting-sources "" --tools "" --strict-mcp-config`, OAuth sign-in works, ≈$0.0002 and ~1 s per title),
  `get_task_output` and `mcp_status` (docs/superpowers/specs/claude-task-output.md). Not probed: `away_summary`'s
  payload and timing, a workflow's permission prompt text and reply text, output of agent/workflow tasks.
- Schema: migration 0020 (`session_activity`) takes a database to version 20; the engine backs up before migrating.
