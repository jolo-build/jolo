# Claude Code dialogs over stream-json: probe record

Probed 2026-10-23 against Claude Code 2.1.304 (`/Users/ejabbarli/.local/bin/claude`), model `claude-fable-5-1`.
Two capped runs, about 1.15 USD in total. The process was started as Jolo starts it:

```
claude --print --verbose --output-format stream-json --input-format stream-json \
  --permission-prompts host --permission-prompt-tool stdio --max-budget-usd 1
```

## Result in one line

No `request_user_dialog` arrived. AskUserQuestion and ExitPlanMode (plan approval) reach the host as
ordinary `can_use_tool` control requests carrying `requires_user_interaction: true`, whatever
`supportedDialogKinds` the host declares. The answer goes back inside `updatedInput`.

## Run 1: `supportedDialogKinds: ["ask_user_question"]`

Sent first:

```json
{"type":"control_request","request_id":"jolo-init","request":{"subtype":"initialize","supportedDialogKinds":["ask_user_question"]}}
```

The initialize response carries no dialog-related field (keys: `commands, agents, output_style, available_output_styles,
user_output_styles_dir, models, account, pid, claude_code_version, current_permission_mode, feedback_mode, ...,
session_state, capabilities`).

Prompt: `Use the AskUserQuestion tool to ask me whether I prefer tea or coffee, then reply with my answer.`

What Claude sent (no `request_user_dialog`):

```json
{"type":"control_request","request_id":"5a2c7280-772f-4394-bef8-15486a22dc3d","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","display_name":"AskUserQuestion","input":{"questions":[{"question":"Do you prefer tea or coffee?","header":"Drink","options":[{"label":"Tea","description":"You prefer tea."},{"label":"Coffee","description":"You prefer coffee."}],"multiSelect":false}]},"tool_use_id":"toolu_016jNz75xwpzHFfbPekw7cSA","requires_user_interaction":true}}
```

### Allowed with the input unchanged (what Jolo does today once the person allows the "permission")

```json
{"type":"control_response","response":{"request_id":"5a2c7280-...","subtype":"success","response":{"behavior":"allow","updatedInput":{"questions":[...unchanged...]}}}}
```

Tool result: `"The user did not answer the questions."` (`tool_use_result.answers: {}`). Claude replied that no answer came back.
No dialog followed the allow.

### Allowed with answers: accepted

```json
{"type":"control_response","response":{"request_id":"1cc70a35-6775-4229-a203-05402333eb28","subtype":"success","response":{"behavior":"allow","updatedInput":{"questions":[{"question":"Do you prefer tea or coffee?","header":"Drink","options":[{"label":"Tea","description":"You prefer tea."},{"label":"Coffee","description":"You prefer coffee."}],"multiSelect":false}],"answers":{"Do you prefer tea or coffee?":"Coffee"}}}}}
```

Tool result: `Your questions have been answered: "Do you prefer tea or coffee?"="Coffee". You can now continue with these answers in mind.`
Final reply: `Your answer: **Coffee**.` `answers` is keyed by the question text; the value is the chosen option's label.

### `{"behavior":"cancelled"}`: rejected

```json
{"type":"control_response","response":{"request_id":"94146d4b-13b8-4acd-ba09-91504a5b0f0b","subtype":"success","response":{"behavior":"cancelled"}}}
```

Tool result (`is_error: true`): `The canUseTool callback returned an invalid permission result. Expected {behavior: 'allow', updatedInput?: object} or {behavior: 'deny', message: string}. ...`
Claude said the harness errored and asked the same question again.

### Dismissed as a deny: accepted

```json
{"type":"control_response","response":{"request_id":"5fc3ff33-2c3f-4d7f-9e4e-212af4ec69f9","subtype":"success","response":{"behavior":"deny","message":"The user dismissed the question without answering."}}}
```

Tool result (`is_error: true`): the message verbatim; `permission_decision: {decision: "reject", source: "user_reject"}`.
Claude replied that the question was dismissed and it had no answer to report.

## Run 2: many candidate kinds declared, plus plan approval

```json
{"type":"control_request","request_id":"jolo-init","request":{"subtype":"initialize","supportedDialogKinds":["ask_user_question","permission_ask_user_question","ask_user_question_answer","enum_prompt","plan_approval","exit_plan_mode","permission_exit_plan_mode_v2","elicitation","mcp_elicitation"]}}
```

AskUserQuestion: identical `can_use_tool` with `requires_user_interaction: true`; the `answers` form was accepted again
(`"Tea"`).

Plan approval, after `{"subtype":"set_permission_mode","mode":"plan"}` and a prompt asking for a one-step plan:

```json
{"type":"control_request","request_id":"1c3ef54d-b674-4c08-ab8e-ba3ba1d2e11b","request":{"subtype":"can_use_tool","tool_name":"ExitPlanMode","display_name":"ExitPlanMode","input":{"plan":"# Plan: Create hello.txt\n...","planFilePath":"/Users/<user>/.claude/plans/<slug>.md"},"tool_use_id":"toolu_01HbA6k6DqY9mVMUEShPqb83","requires_user_interaction":true}}
```

Answered `{"behavior":"deny","message":"The user did not approve the plan. Stop here."}`: accepted (tool result is the
message, `source: "user_reject"`); Claude stopped. Approval would be `{"behavior":"allow","updatedInput":<input>}`
(not exercised).

## What the binary itself says (read from 2.1.304's bundled JS)

- `request_user_dialog` request: `{subtype: "request_user_dialog", dialog_kind: string, payload: object, tool_use_id?: string}`.
  Response: `{behavior: "completed" | "cancelled", result?: any}`, `result` opaque per kind.
- Protocol note on `dialog_kind`: "A host that receives a kind it did not declare must not answer it (an error-subtype
  response is discarded and the dialog stays pending), never with `{behavior: "cancelled"}`, which is a real settlement
  treated as the user dismissing the dialog." Claude withdraws a pending dialog with `control_cancel_request`, and
  cancels one itself after its deadline.
- Kinds an SDK host can receive as `request_user_dialog` in this build: `refusal_fallback_prompt`,
  `fable_overage_consent_prompt`, `auto_mode_server_fallback`, `enum_prompt` (a generic choice prompt with `source`,
  `title`), plus Slack-connect dialogs. None of them is AskUserQuestion, plan approval or MCP elicitation.
- MCP elicitation has its own control request: `{subtype: "elicitation", mcp_server_name, message, mode?: "form" | "url",
  url?, elicitation_id?, requested_schema?, property_order?, title?, display_name?, description?}`, answered with
  `{action: "accept" | "decline" | "cancel", content?: object}`. Not probed live.
