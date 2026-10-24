# Claude Code 2.1.304: `get_task_output`, `mcp_status`, and the init message's MCP list

Probe record, 2026-10-24 (`scratch-e2e/task-output-probe.js`, not committed): one stream-json session (`--model haiku`),
one background shell command, two `get_task_output` requests, one `mcp_status` request.

## `get_task_output`

Host → CLI: `{ type: "control_request", request_id, request: { subtype: "get_task_output", task_id } }`.

CLI → host, while the task runs (1.5 s after `task_started`):

```json
{ "type": "control_response", "response": { "subtype": "success", "request_id": "out1",
  "response": { "output": "line 1\nline 2\n", "total_bytes": 14, "truncated": false } } }
```

After the task's `task_notification` (status `completed`), the same request answers the whole output, with the
command's exit line appended by Claude Code:

```json
{ "output": "line 1\nline 2\nline 3\nline 4\n\n[exited with code 0]\n", "total_bytes": 50, "truncated": false }
```

So the output is readable for as long as the process lives, during and after the task. Its file on disk is the
`output_file` of the notification (`…/tasks/<task_id>.output`). Not probed: a task of another type (agent, workflow),
an unknown `task_id` (expect an `error` subtype), and the size at which `truncated` turns true.

## `mcp_status`

Host → CLI: `{ type: "control_request", request_id, request: { subtype: "mcp_status" } }`.

CLI → host: `{ "subtype": "success", "response": { "mcpServers": [ { "name", "status", "config", "scope", "source", "error"? } ] } }`,
`status` one of `pending`, `connected`, `failed`, `needs-auth`; `source` one of `plugin`, `user`, `claudeai` (seen);
`error` present on a failed server (`ENOENT: …`). Asked right after `initialize` every server is `pending` or `failed`.

## `init` carries the list too

Every turn's `system/init` message has `mcp_servers: [{ name, status, source }]`, and the statuses move between turns
(`pending` → `connected` / `failed`): the second turn's init listed the plugin servers `connected`, `alphaxiv` `failed`.
A host that keeps the latest init's list has the status without asking.

## `away_summary`

Not observed in this probe (it is the summary Claude Code gives when the person returns after being away). The spec
(docs/superpowers/specs/2026-10-23-native-claude-hosting-design.md) lists it among the `system` subtypes; its payload
field is unprobed.
