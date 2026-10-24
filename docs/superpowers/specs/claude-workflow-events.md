# Claude Code workflow task events over stream-json: probe record

Probed 2026-10-24 against Claude Code 2.1.304 (`/Users/ejabbarli/.local/bin/claude`), model `claude-fable-5-1`, one capped run (`--max-budget-usd 2`, 0.98 USD in total). Started as Jolo starts it (`claudeArgv`), `initialize` with `perTaskStopAffordance: true` and `forwardNestedSubagentToolCalls: true`; the host allowed the `Workflow` tool's `can_use_tool` (no `requires_user_interaction`). Script: `scratch-e2e/workflow-probe.js` (not committed); raw record `scratch-e2e/workflow-probe.jsonl`. Prompt: run a two-agent script (`meta.name 'probe-two'`, one phase `Say`, `parallel` over two `agent(...)` calls), then reply `launched`.

## Result in one line

A workflow is **one** task (`task_type: "local_workflow"`), but its `task_progress` events carry the whole picture in `workflow_progress`: every phase and every agent with its state, tokens and result preview. The agent count, the phases and the current phase are all on the wire; Jolo's ledger (Plan 1/2) read only `usage` from `task_progress` and so showed none of it.

## Sequence (t in seconds from spawn)

| t | event |
| :- | :- |
| 9.25 | `can_use_tool` for `Workflow`, `input_keys: ["script"]` |
| 9.26 | `system/background_tasks_changed` `tasks: [{ task_id, run_id, task_type: "local_workflow", description: "two trivial agents" }]` |
| 9.26 | `system/task_started` `{ task_id: "w3equtjzj", run_id: "0mvlspxtl-83fae8f7", tool_use_id, description: "two trivial agents" (= meta.description), task_type: "local_workflow", workflow_name: "probe-two", prompt: <the script verbatim> }`; **no `is_backgrounded`** |
| 9.30 | `system/task_progress` `{ task_id, run_id, tool_use_id, description: "Say: say:1", usage: { total_tokens: 0, tool_uses: 0, duration_ms: 42 }, last_tool_name: "say:1", summary: "two trivial agents", workflow_progress: [...] }` |
| 11.48, 12.71, 15.08 | further `task_progress` as agents start and finish; `usage.total_tokens` is the running sum (20388 after agent 1, 40776 after both) |
| 11.95 | `result` `success` "launched" (the turn ended while the workflow ran: the Workflow tool returns at once) |
| 15.09 | `system/task_updated` `patch: { status: "completed", end_time }` |
| 15.09 | `system/task_notification` `{ task_id, run_id, tool_use_id, status: "completed", output_file, summary: 'Dynamic workflow "two trivial agents" completed', usage: { total_tokens: 40776, tool_uses: 0, duration_ms: 5813 } }` |
| 15.09 | `system/background_tasks_changed` `tasks: []` |
| 19.51 | a turn Claude began by itself: `result` "The workflow finished. Both agents returned as expected: [\"agent 1 ok\", \"agent 2 ok\"] …" |

## `workflow_progress` shape

An array, in order, of:
- `{ type: "workflow_phase", index: 1, title: "Say" }` — one per phase declared in `meta.phases` (or created by `phase()`), in index order.
- `{ type: "workflow_agent", index: 1, label: "say:1", phaseIndex: 1, phaseTitle: "Say", agentId: "aaf9cf829d3e43dbb", model: "claude-fable-5-1", state: "start" | "done", startedAt, queuedAt, attempt: 1, promptPreview: "Reply with exactly: agent 1 ok", promptFramed: true, lastProgressAt, tokens: 20388, toolCalls: 0, durationMs: 3428, resultPreview: "agent 1 ok" }` — one per agent the script has called so far; `agentId`, `startedAt`, `tokens`, `toolCalls`, `durationMs`, `resultPreview` appear once known; a queued agent has `queuedAt` and `state: "start"` without `agentId`.

Not seen in this run (two agents, no failure): the failure/stop state names for an agent (`state` values beyond `start`/`done`), `workflow_phase` fields beyond `index`/`title`, and what a `pipeline()` stage looks like. A second probe with a failing agent would settle the state vocabulary; until then a renderer treats any state other than `start`/`done` as failed.

## What follows for Jolo

- Agent count = number of `workflow_agent` entries; phases = `workflow_phase` entries; a phase's dot = pending when none of its agents has started, running while one is `start`, done when all are `done`, failed on any other state. The current phase and agent are in `description` (`"<phase>: <label>"`).
- `usage.total_tokens` on the workflow task is the sum over its agents; per-agent `tokens` are in the entries.
- The ledger should keep a bounded summary of `workflow_progress` (counts per phase and overall, the current phase, a capped agent list) rather than the raw array, which grows with every agent and repeats on every tick.
- `task_started.prompt` is the script: `meta.name` is already in `workflow_name`, so no parsing is needed.
