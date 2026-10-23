# Claude Code Stop over stream-json: does an interrupt spare background work? Probe record

Probed 2026-10-23 against Claude Code 2.1.304 (`/Users/ejabbarli/.local/bin/claude`), the account's default model.
Two capped runs, 0.57 USD in total (0.38 + 0.19). The process was started as Jolo starts it (`claudeArgv` in
`apps/engine/src/agents/claude-stream.js`) plus a budget cap:

```
claude --print --verbose --output-format stream-json --input-format stream-json \
  --include-partial-messages --replay-user-messages \
  --permission-prompts host --permission-prompt-tool stdio --max-budget-usd 1
```

`--include-partial-messages` is what makes `stream_event` arrive, which the probe waits for before interrupting. The
probe answered the Bash permission request with `{behavior: "allow", updatedInput: <input unchanged>}`. The parent
session's `CLAUDE_CODE_*` / `CLAUDECODE` variables were removed from the child's environment, because the engine does not
run under Claude Code. Script: `.superpowers/sdd/2026-10-23-native-claude-host-engine/probe/stop-probe.py` (not
committed); raw records `run-with.json`, `run-without.json` next to it.

## Result in one line

With `perTaskStopAffordance: true` the interrupt ends the turn and leaves a background command running, so Jolo's Stop
does what the design says. The control run without the declaration spared the command too. The declaration only
changes what an interrupt does to background **agents and workflows**, which this probe did not start (see below).

## What was sent (both runs)

1. `initialize`. Run 1 included the affordance and run 2 did not:
   ```json
   {"type":"control_request","request_id":"jolo-init","request":{"subtype":"initialize","forwardNestedSubagentToolCalls":true,"perTaskStopAffordance":true}}
   {"type":"control_request","request_id":"jolo-init","request":{"subtype":"initialize","forwardNestedSubagentToolCalls":true}}
   ```
2. `{"type":"user","message":{"role":"user","content":"Use your Bash tool with run_in_background set to true to start exactly this command: sleep 240 . Do not wait for it. Then reply with exactly: started"}}`.
   Then the probe waited for the `result`.
3. `{"type":"user","message":{"role":"user","content":"Count slowly from 1 to 200, one number per line."}}`. On the
   first `stream_event` of that turn (`message_start`) the probe sent:
   ```json
   {"type":"control_request","request_id":"probe-interrupt","request":{"subtype":"interrupt","cancel_queued":true}}
   ```
4. The probe watched the stream for 5 s and ran `ps -axo pid=,pgid=,args=` for `sleep 240`.
5. Clean-up: `stop_task` for the task, stdin closed, the process group signalled if still alive.

## Run 1: `perTaskStopAffordance: true`

| t (s) | arrived |
| :- | :- |
| 3.66 | `system/task_started` `bd5wmsi2f` "Sleep for 240 seconds in background", `task_type: local_bash`, `is_backgrounded: true` |
| 4.63 | `result` `success` "started" (0.377 USD) |
| 4.69 | `ps`: `69519 69518 sleep 240` (under its zsh wrapper 69518) |
| 5.81 | first `stream_event` of turn 2; interrupt sent |
| 5.81 | `control_response` success `{still_queued: [], cancelled: []}` |
| 5.82 | `user` replay `[Request interrupted by user]`; `result` `error_during_execution`, `is_error: true` |
| 5.82–10.81 | nothing else: no `task_notification`, no `task_updated`, no `agents_killed` |
| 10.86 | `ps`: `69519 69518 sleep 240` still alive |
| 10.86 | after the clean-up `stop_task`: `task_updated`, `task_notification` `stopped`, `background_tasks_changed`, success response |
| after exit | `ps`: no `sleep 240` |

## Run 2 (control): no `perTaskStopAffordance`

| t (s) | arrived |
| :- | :- |
| 3.54 | `system/task_started` `b5ie2a0hh`, `local_bash`, `is_backgrounded: true` |
| 5.04 | `result` `success` "started" (0.194 USD) |
| 5.08 | `ps`: `69651 69650 sleep 240` |
| 6.54 | first `stream_event` of turn 2; interrupt sent |
| 6.55 | `control_response` success `{still_queued: [], cancelled: []}`; `result` `error_during_execution` |
| 6.55–11.55 | nothing else: no `task_notification`, no `agents_killed` |
| 11.60 | `ps`: `69651 69650 sleep 240` still alive |
| 11.60 | after the clean-up `stop_task`: `task_notification` `stopped` |
| after exit | `ps`: no `sleep 240` |

(In run 2 the probe's `ps` lines also matched the shell that ran the probe, because its command line contained the
pattern. The lists above are filtered to the `sleep 240` process and its wrapper.)

## Why the control run spared the command too: what the binary says

From 2.1.304's bundled JS (`print.ts`, minified):

- `initialize.perTaskStopAffordance` description: "When declared, an interrupt on an open-input (interactive stream-json)
  session spares running background agents/workflows (Stop only aborts the turn). [...] ABSENCE also fails closed: the
  interrupt kills background tasks, since the user would otherwise have no way to stop a runaway one."
- The interrupt handler calls the spare path when the declaration is present (`per_task_stop_sparing {spared: true}`).
  That path stops one narrower class of running task; the kill path runs the same step first. Otherwise it calls the kill path, which also stops running
  tasks picked by further predicates. Those predicates are minified and were not resolved here. The probe shows that a
  backgrounded `local_bash` task is not picked, which matches the description's "agents/workflows".

What follows for Jolo:

- Jolo's Stop (interrupt with `cancel_queued`) never ends a background command, with or without the declaration.
- With the declaration (what Jolo sends) it also spares background agents and workflows. This half is the binary's own
  documented behaviour and was not exercised live: the probe started a command only, to stay inside the budget.
- So the capability fallback in spec §5.3 ("if `stop_task` is not supported, Stop background work falls back to
  `interrupt`") stops background agents on such a binary, but not background commands. Only `stop_task` (or closing the
  process) ends a background command.

## Run 3 (controller, 2026-10-23): a background *agent* under `perTaskStopAffordance: true`

Same launch as above, `--max-budget-usd 1.5`. `initialize` carried `perTaskStopAffordance: true` and `forwardNestedSubagentToolCalls: true`.

1. Prompt: `Use the Agent tool with run_in_background set to true to start one general-purpose subagent whose only job is to run the shell command "sleep 150" with Bash and then reply done. Do not wait for it. Then reply with exactly: launched`
   - `task_started` at 6.3 s: `task_id a1ddd6d7…`, description `Sleep 150 seconds`, `is_backgrounded: true`; the subagent's `can_use_tool` for Bash was allowed by the host; result `launched` at 9.5 s (0.50 USD).
   - `ps`: a `sleep 150` process alive.
2. Second prompt `Count slowly from 1 to 200, one number per line.`; on its first `stream_event` the host sent `{ subtype: "interrupt", cancel_queued: true }` (78.0 s).
   - Within 12 s after the interrupt: no `agents_killed`, no `task_notification` for the agent task. `sleep 150` still alive.
   - Results seen: `launched`; the interrupted count (`1\n2\n…`); then a self-started turn `The background agent reported an interim…` (the agent kept working and reported).
3. stdin closed at ~95 s; process exited 0.4 s later with code 0.

Verdict: with the declaration, an interrupt ends the turn and spares a background **subagent** as well as a background command. This closes the half the earlier runs could not show. The control case (no declaration, background agent) was not run; the design does not depend on it.
