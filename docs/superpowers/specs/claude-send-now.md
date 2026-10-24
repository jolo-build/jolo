# Claude Code "Send now" over stream-json: probe record

Probed 2026-10-24 against Claude Code 2.1.304 (`/Users/ejabbarli/.local/bin/claude`), three capped runs (`--max-budget-usd 2`, about 1.5 USD in all), started as Jolo starts it, `initialize` with `perTaskStopAffordance: true`. Scripts and raw records (not committed): `scratch-e2e/send-now-probe.js`, `send-now-probe-bash.jsonl`, `send-now-probe-agent.jsonl`, `send-now-probe-mcp.jsonl`, `mcp-wait-server.js`.

## What the binary documents

`initialize`'s answer advertises `interrupt_send_now_v1`. A host may send `{ subtype: "interrupt", send_now: true, message_uuid?: <uuid of a user message already queued at the CLI> }`. It is not a Stop: it ends no background task. Depending on what the CLI holds, the response's `send_now` says `nothing_waiting` (no queued person's message: nothing done), `delivering` (one waits and no turn was stopped: no turn under way, the message not yet in the queue, the CLI moving what the turn waits on to the background, the turn already stopping, or the process on its way out), or `stopped` (the running turn was aborted for what waits; its result follows). `cancel_queued: true` with it makes the request a Stop. A user message can also be sent with `priority: 'now'`. Results carry `user_message_uuids`, the uuids of the client messages the turn answered.

## What happened, three waits

| turn waiting on | `send_now` answer | what followed |
| :- | :- | :- |
| a foreground `Bash` (`python3 … time.sleep(75)`, `task_started is_backgrounded: false, task_type local_bash`) | `{ still_queued: [u2], send_now: "stopped" }` | `task_notification stopped` for the task; a `tool_result` "The user doesn't want to proceed with this tool use…"; the interruption marker as a `user` text; `result error_during_execution` with `user_message_uuids: [u1]`; 1.7 s after the request, the queued message's echo and `result success "second"` with `user_message_uuids: [u2]` |
| a foreground subagent (`Agent`, `task_type local_agent, spawn_depth 1`) whose own `Bash` slept (`task_started … owned_by_subagent: true, parent_task_id`) | `stopped` | the nested command's `task_notification stopped`; the subagent's `task_updated patch.status: "killed"` then `task_notification stopped`; the same rejection, marker and error result; the queued message answered 3 s after the request |
| an MCP tool call (`mcp__probe__wait`, 100 s, under the 2-minute auto-background delay) | `stopped` | the call rejected the same way, no background task made, the queued message answered 2.4 s after the request |

No run produced `delivering`: in 2.1.304 a turn waiting on a tool, a subagent or an MCP call is aborted for the queued message, not moved aside.

## What follows for Jolo

- Jolo's `run.sendNow` (cancel the active run with `interrupt { cancel_queued: true }`, then start the queued run as the next turn) produces the same observable result as the CLI's own Send now: the same tool rejection and interruption marker in the transcript, the turn ended as interrupted, the queued message answered about two seconds later. Moving Jolo's queue into the CLI (delivering queued messages early with their uuids, starting runs from the CLI's echoes, `cancel_async_message` on removal) would change nothing a person sees in these cases, so it is not done.
- Worth taking into the ledger (Task 15): `task_updated.patch.status` can be `"killed"` (a subagent killed by an interrupt; the `task_notification` that follows says `stopped`); a subagent's `task_started` carries `spawn_depth`, `parent_task_id` and `owned_by_subagent`; a foreground tool call also appears as a task (`is_backgrounded: false`); `task_progress` for a subagent carries `last_tool_name` and an updated `description` ("Running …").
- `user_message_uuids` on results is the field to use if run accounting ever needs to tie a result to several queued messages.
