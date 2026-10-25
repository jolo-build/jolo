#!/usr/bin/env bun
// A stand-in for the Claude Code binary that speaks its stream-json host protocol, so the adapter is tested
// end to end without the real CLI or its API. Shapes mirror what the real binary sent in a live session.
// Like the real binary in streaming-input mode, one process answers as many turns as the host feeds it and
// leaves when its stdin closes; it never exits on its own after a turn.
// Behaviour is scripted by the prompt text: "run <cmd>" asks permission for a Bash call ("run-described <description>\n<cmd>"
// for one with a description), "write <file>" for a
// Write, "read <file>" for a Read, "fail" ends in an error result, "model" reports the model, effort and fast mode
// it was started with, "background <ms> <text>" answers at once and then, <ms> later, starts a turn of its own with
// <text> (what a finished background task does), "zero-result <text>" sends an empty result before the real
// answer (what a resumed binary did with an orphaned task notification), "slow <ms> <text>" answers after a
// pause, "exit-after-turn" leaves once its answer is out, "background-permission <ms> <ms>" answers at once and then,
// <ms> later, has a background subagent ask permission while the main thread is idle and report back <ms> after the
// answer, "race-self <text>" begins a turn of its own just before taking up the message (a background task finishing
// as the message arrives), "ask-on-stop" has a background subagent ask just as the turn is interrupted, "ask-user
// <question>" asks the person <question> with AskUserQuestion and says what they answered, "ask-user-withdraw <ms>" takes
// that question back <ms> later, "ask-user-exit <ms>" leaves (exit 1) <ms> after asking, the question unanswered,
// "exit-plan <title>" asks the person to approve a plan titled <title> with ExitPlanMode
// and says whether it was approved or sent back, "workflow <name> <ms>" starts a workflow named <name> as one background
// task (task_type local_workflow, no is_backgrounded field, ids wf-1, wf-2, ... in a process) whose progress reports carry its phases and agents
// (workflow_progress): at once both agents of phase "Say" (say:1, say:2, model claude-fable-5-1) have started (0 tokens, as the real binary's first
// tick says), halfway through <ms> say:1 is done (20388 tokens, its duration and result preview "agent 1 ok") and say:2 at work (state "progress",
// 8000 tokens, one tool call), and at <ms> both are done (40776 tokens); it then
// completes with the summary 'Dynamic workflow "Workflow <name>" completed' and the output file /tmp/<name>.output unless stop_task ended it first, and is
// reported a moment later in a turn of its own ("Workflow <name> done."), "nested-agent <ms>" runs a background subagent agent-1 and the command cmd-1
// it owns (parent_task_id agent-1), the subagent's own message naming its model claude-opus-5-5, which end at <ms>, the command first, the
// subagent's transcript written as it works (JSON lines, its last assistant message the report) and named in its notice through the
// link Claude Code makes to it (tasks/agent-1.output, in a directory of its own under TMPDIR), and
// stop_task on the subagent kills it (task_updated status "killed"), and
// anything else just answers in prose. A second control response to one request, or one to a request it took back,
// makes the fixture exit 70. "away-summary <text>" sends a system away_summary with <text> as its summary, then a reply. It answers
// get_task_output for a task it started (its description, two lines, and the exit line once it ended; an unknown task is an
// error, and so is an agent's, in Claude Code's words, since it serves commands and monitors only) and mcp_status with three servers (connected, failed, needs-auth), which every init lists too. The other scenarios
// are described where they are played.
// Like the real binary, turns run one at a time: a message that arrives during a turn waits for it, every turn opens
// with system/init listing the messages it takes up, its result names the message it answers, and with
// --replay-user-messages each message is echoed back as its turn takes it up, except one that carries a tag the
// binary keeps for itself (a task notification, command output). An interrupt with cancel_queued drops waiting messages.
const argv = process.argv.slice(2);
const flags = new Set(argv);
const resumed = argv.includes("--resume") ? argv[argv.indexOf("--resume") + 1] : null;
// One-shot print mode, how Jolo asks for a task's title: the prompt is stdin, read to its end, and the one JSON result line
// names it after the prompt's first three words.
if (flags.has("--print") && flags.has("--output-format") && argv[argv.indexOf("--output-format") + 1] === "json" && !flags.has("--input-format")) {
  const words = require("node:fs").readFileSync(0, "utf8").trim().split(/\s+/).slice(0, 3).join(" ");
  require("node:fs").writeSync(1, `${JSON.stringify({ type: "result", subtype: "success", result: `Fixture title: ${words}`, is_error: false })}\n`); // whole before the exit
  process.exit(0);
}
if (!flags.has("--print") || !flags.has("--output-format") || !argv.includes("stream-json") || !flags.has("--permission-prompt-tool") || argv[argv.indexOf("--permission-prompt-tool") + 1] !== "stdio") {
  process.stderr.write(`fake-claude: unexpected argv ${JSON.stringify(argv)}\n`);
  process.exit(64);
}
const offersBrowser = config => config?.args?.at(-1)?.split(',').includes('browser');
const valueOf = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] ?? null : null);
const replay = flags.has("--replay-user-messages");
const chosenModel = valueOf("--model");
const chosenEffort = valueOf("--effort");
// Headless, Claude Code runs fast only when the launch's own --settings ask for it.
const fastMode = JSON.parse(valueOf("--settings") ?? "{}").fastMode === true;
const MODELS = [
  { value: "default", resolvedModel: "fake-default", displayName: "Default (recommended)", description: "the everyday choice", supportsEffort: true, supportedEffortLevels: ["low", "high"] },
  { value: "fable", resolvedModel: "fake-fable-5-1", displayName: "Fable", description: "the capable one", supportsEffort: true, supportedEffortLevels: ["low", "high", "xhigh", "max"], supportsFastMode: true },
  { value: "haiku", resolvedModel: "fake-haiku", displayName: "Haiku", description: "the quick one" },
];
// The parts of a get_usage answer Jolo reads, in the shape Claude Code 2.1 sends.
const USAGE = {
  subscription_type: "max", rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 16, resets_at: "2026-10-14T22:49:59.786341+00:00" },
    seven_day: { utilization: 44, resets_at: "2026-10-19T06:59:59.786360+00:00" },
    seven_day_opus: null, seven_day_sonnet: null,
    model_scoped: [{ display_name: "Fable", utilization: 91, resets_at: "2026-10-19T06:59:59.786515+00:00" }],
  },
  behaviors: null,
};
// FAKE_CLAUDE_USAGE scripts the get_usage answer: unset sends USAGE, "error" refuses the request, "api-key" is how an
// API-key sign-in answers (no plan limits), "unavailable" is how Claude answers while its usage endpoint fails with
// nothing cached (rate_limits: null), "long" names a model and a plan past what agent.limits may carry, "hang"
// never answers, and "exit" leaves without answering.
const USAGE_MODE = process.env.FAKE_CLAUDE_USAGE ?? "";
const answerUsage = (requestId) => {
  if (USAGE_MODE === "error") return out({ type: "control_response", response: { subtype: "error", request_id: requestId, error: "fake-claude: usage endpoint returned 503" } });
  if (USAGE_MODE === "api-key") return out({ type: "control_response", response: { subtype: "success", request_id: requestId, response: { subscription_type: null, rate_limits_available: false, rate_limits: null, behaviors: null } } });
  if (USAGE_MODE === "unavailable") return out({ type: "control_response", response: { subtype: "success", request_id: requestId, response: { ...USAGE, rate_limits: null } } });
  if (USAGE_MODE === "long") return out({ type: "control_response", response: { subtype: "success", request_id: requestId, response: { ...USAGE, subscription_type: "p".repeat(200), rate_limits: { ...USAGE.rate_limits, model_scoped: [{ display_name: "m".repeat(200), utilization: 7, resets_at: null }] } } } });
  if (USAGE_MODE === "hang") return; // stays silent, as a CLI stuck before its answer would
  if (USAGE_MODE === "exit") { process.stderr.write("fake-claude: scripted exit before answering get_usage\n"); process.exit(3); }
  if (USAGE_MODE) { process.stderr.write(`fake-claude: unknown FAKE_CLAUDE_USAGE ${JSON.stringify(USAGE_MODE)}\n`); process.exit(64); }
  out({ type: "control_response", response: { subtype: "success", request_id: requestId, response: USAGE } });
};
// The commands initialize names, in the shape Claude Code 2.1 sends: its built-ins carry `builtin`, the rest are plugins,
// skills and user-defined commands. Two are enough to show the list and that one reached the fixture whole.
const COMMANDS = [
  { name: "compact", description: "Free up context by summarizing the conversation so far", argumentHint: "<optional custom summarization instructions>", builtin: true },
  { name: "deploy", description: "Ship the current branch to an environment", argumentHint: "<environment>" },
];
const sessionId = resumed ?? `fake-${Math.random().toString(36).slice(2, 10)}`;
// The MCP servers this Claude has, as mcp_status answers (with the config it also sends) and each turn's init lists them.
const MCP_SERVERS = [
  { name: "probe", status: "connected", config: { type: "stdio", command: "probe" }, scope: "user", source: "user" },
  { name: "pencil", status: "failed", config: { type: "stdio", command: "pencil" }, scope: "user", source: "user", error: "ENOENT" },
  { name: "claude.ai Gmail", status: "needs-auth", config: { type: "claudeai-proxy" }, scope: "claudeai", source: "claudeai" },
];
const INIT_MCP = MCP_SERVERS.map(({ name, status, source }) => ({ name, status, source }));
/** The tasks this process started, and whether each ended: get_task_output answers for them, by what went out. */
const startedTasks = new Map();
const noteTask = (message) => {
  if (message?.type !== "system") return;
  if (message.subtype === "task_started") startedTasks.set(message.task_id, { description: message.description ?? "", type: message.task_type ?? null, ended: false });
  else if (message.subtype === "task_notification" && startedTasks.has(message.task_id)) startedTasks.get(message.task_id).ended = true;
};
/** get_task_output: its description and two lines, then the exit line once it ended, as Claude Code 2.1.304 answers for a command. */
const answerTaskOutput = (requestId, taskId) => {
  const task = startedTasks.get(taskId);
  if (!task) return out({ type: "control_response", response: { subtype: "error", request_id: requestId, error: "no such task" } });
  // Claude Code serves a command's or a monitor's output only; an agent's is in its output file (seen 2026-10-25).
  if (task.type === "local_agent") return out({ type: "control_response", response: { subtype: "error", request_id: requestId, error: "get_task_output: no shell or Monitor task with that task_id in this session" } });
  const output = `${task.description}\nline 1\nline 2\n${task.ended ? "[exited with code 0]\n" : ""}`;
  out({ type: "control_response", response: { subtype: "success", request_id: requestId, response: { output, total_bytes: Buffer.byteLength(output), truncated: false } } });
};
/** The last local command's output, which the binary replays after a compaction. */
let lastLocalOutput = null;
/** Lines held back to go out in one write, as the real binary's output often arrives: several messages in one read. */
let batch = null;
const out = (message) => { noteTask(message); const line = `${JSON.stringify(message)}\n`; if (batch) batch.push(line); else process.stdout.write(line); };
const flush = () => { const lines = batch ?? []; batch = null; if (lines.length) process.stdout.write(lines.join("")); };
const pending = new Map();
let counter = 0;
let turnsAnswered = 0;
/** Background work the process runs beside its turns. Like the real binary, an interrupt kills it unless the host said
 * at initialize that it stops such work on its own (perTaskStopAffordance). */
let sparesBackground = false;
/** FAKE_CLAUDE_NO_STOP_TASK=1 is a Claude Code that cannot stop tasks: it refuses every stop_task, and knowing nothing of
 * perTaskStopAffordance, its interrupt ends background work whatever the host declared. */
const NO_STOP_TASK = process.env.FAKE_CLAUDE_NO_STOP_TASK === "1";
/** FAKE_CLAUDE_SILENT_STOP_TASK=1 never answers a stop_task, and the task goes on. */
const SILENT_STOP_TASK = process.env.FAKE_CLAUDE_SILENT_STOP_TASK === "1";
/** Like the real binary, a subagent's own subagents' tool calls and results reach the host only when it asked for them. */
let forwardsNested = false;
const backgroundWork = new Set();
/** Background tasks still running, by id: the timers carrying each one's work, and whether it ignores stop_task. */
const runningTasks = new Map();
/** `onStop` is what stop_task does to the task in place of ending it as stopped. */
const startTask = (taskId, { stubborn = false, onStop = null } = {}) => runningTasks.set(taskId, { timers: new Set(), stubborn, onStop });
/** A task ends: its work is cancelled and its end is told, as the real binary tells it, with what `notice` adds (a summary, an output file). */
const endTask = (taskId, status, notice = {}) => {
  const task = runningTasks.get(taskId);
  if (!task) return;
  runningTasks.delete(taskId);
  for (const timer of task.timers) { clearTimeout(timer); backgroundWork.delete(timer); }
  out({ type: "system", subtype: "task_notification", task_id: taskId, status, ...notice, session_id: sessionId });
};
/** Work done later beside the turns; with `taskId`, part of that running task's work, cancelled when it ends. */
const inBackground = (fn, ms, taskId = null) => {
  const timer = setTimeout(() => { backgroundWork.delete(timer); runningTasks.get(taskId)?.timers.delete(timer); fn(); }, ms);
  backgroundWork.add(timer);
  runningTasks.get(taskId)?.timers.add(timer);
};
/** The workflows this process started, which number their task ids. */
let workflows = 0;
/** How long after a workflow completes the turn reporting it begins: the real binary begins it a moment later. */
const WORKFLOW_REPORT_DELAY_MS = 300;
/** stop_task: a running task is stopped once the request is answered, as Claude Code 2.1 does; one that ignores it is only answered. */
const stopTask = (requestId, taskId) => {
  if (SILENT_STOP_TASK) return;
  if (NO_STOP_TASK) return out({ type: "control_response", response: { subtype: "error", request_id: requestId, error: "stop_task is not supported in this context" } });
  const task = runningTasks.get(taskId);
  if (!task) return out({ type: "control_response", response: { subtype: "error", request_id: requestId, error: "stop_task: unknown task" } });
  out({ type: "control_response", response: { subtype: "success", request_id: requestId, response: {} } });
  if (task.onStop) task.onStop();
  else if (!task.stubborn) endTask(taskId, "stopped");
};
/** The turn in progress, so an interrupt from the host can end it the way the real binary does. */
let current = null;
const ask = (toolName, input, extra = {}) => new Promise((resolve) => {
  const requestId = `req-${++counter}`;
  pending.set(requestId, resolve);
  out({ type: "control_request", request_id: requestId, request: { subtype: "can_use_tool", tool_name: toolName, display_name: toolName, input, description: extra.description ?? toolName, permission_suggestions: [], tool_use_id: extra.toolUseId } });
});
/** A question that needs the person, as Claude Code 2.1.304 sends AskUserQuestion in host mode: an ordinary can_use_tool
 * marked requires_user_interaction, answered inside the permission answer (see apps/engine/src/agents/README.md, "Dialogs"). */
const askPerson = (toolName, input, toolUseId) => new Promise((resolve) => {
  const requestId = `req-${++counter}`;
  pending.set(requestId, resolve);
  out({ type: "control_request", request_id: requestId, request: { subtype: "can_use_tool", tool_name: toolName, display_name: toolName, input, tool_use_id: toolUseId, requires_user_interaction: true } });
});
/** Requests the process took back: the host must not answer them. */
const withdrawn = new Set();
/** Take back a question nobody has answered, as the real binary does with control_cancel_request. */
const takeBack = (requestId) => {
  withdrawn.add(requestId);
  out({ type: "control_cancel_request", request_id: requestId });
  const resolve = pending.get(requestId); pending.delete(requestId); resolve?.({ behavior: "withdrawn" });
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const result = (turns, uuid = null) => out({ type: "result", subtype: "success", is_error: false, result: "done", ...(uuid ? { user_message_uuid: uuid } : {}), session_id: sessionId, num_turns: turns, duration_ms: 5, stop_reason: "end_turn", total_cost_usd: 0.001, usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 20, output_tokens: 7 }, modelUsage: { fake: { contextWindow: 1_000_000, maxOutputTokens: 64_000 } } });
const say = (text) => {
  out({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, session_id: sessionId });
  // Keep large fixture replies bounded without flooding thousands of unpaced events.
  for (const piece of text.match(text.length > 32768 ? /.{1,4096}/gsu : /.{1,12}/gsu) ?? []) out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } }, session_id: sessionId });
  out({ type: "stream_event", event: { type: "content_block_stop", index: 0 }, session_id: sessionId });
  out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] }, session_id: sessionId });
  // The final usage of the call arrives on message_delta, as Claude Code 2.1 sends it: this is how full the window is.
  out({ type: "stream_event", event: { type: "message_delta", usage: { input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: 40000, output_tokens: 5 } }, session_id: sessionId });
  out({ type: "stream_event", event: { type: "message_stop" }, session_id: sessionId });
};

/** What each turn's init says this binary does, as Claude Code 2.1.304 lists it. */
const CAPABILITIES = ["interrupt_receipt_v1", "interrupt_cancel_queued_v1", "msg_lifecycle_v1"];
/** What became of a message the host sent, as Claude Code 2.1 reports it: queued, started, then one final state. */
const lifecycle = (uuid, state) => { if (uuid) out({ type: "command_lifecycle", command_uuid: uuid, state, session_id: sessionId }); };
/** Messages whose turn was stopped: their final state is 'cancelled'. */
const stoppedMessages = new Set();

/**
 * The host asked for the turn to stop: answer with a receipt naming the messages that still wait, end the turn with a
 * result, and let whatever it was waiting on go. A Stop that names messages acts only on a turn that carries one.
 */
const interrupt = (requestId, cancelQueued = false, names = null) => {
  const named = Array.isArray(names) && names.length > 0 && !cancelQueued;
  const spared = named && !(current && names.includes(current.uuid));
  const cancelled = cancelQueued ? waiting.filter((entry) => !entry.cancelled && entry.uuid).map((entry) => entry.uuid) : [];
  if (cancelQueued) for (const entry of waiting) entry.cancelled = true;
  const stillQueued = waiting.filter((entry) => !entry.cancelled && entry.uuid).map((entry) => entry.uuid);
  out({ type: "control_response", response: { subtype: "success", request_id: requestId, response: { still_queued: stillQueued, ...(cancelQueued ? { cancelled } : {}), ...(named ? { turn: spared ? "spared" : current ? "stopped" : "idle" } : {}) } } });
  for (const uuid of cancelled) lifecycle(uuid, "cancelled");
  if (spared) return;
  if (!sparesBackground) {
    for (const taskId of [...runningTasks.keys()]) endTask(taskId, "stopped");
    for (const timer of backgroundWork) clearTimeout(timer);
    backgroundWork.clear();
  }
  if (!current) return;
  const turn = current;
  current = null;
  turn.interrupted = true;
  if (turn.uuid) stoppedMessages.add(turn.uuid);
  // Still streaming when the interrupt lands: one more tool call goes out before the turn ends.
  if (turn.lateTool) out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: `toolu_${++counter}`, name: "Read", input: { file_path: "notes.txt" } }] }, session_id: sessionId });
  turn.child?.kill("SIGKILL");
  for (const [id, resolve] of pending) { pending.delete(id); resolve({ behavior: "deny", message: "interrupted" }); }
  // A background subagent happens to ask just as the turn is stopped, before its result.
  if (turn.lateQuestion) void subagentAsks({ command: "echo late" }).then((answer) => setTimeout(() => enqueue(() => selfStartedTurn(`Background agent finished: ${answer.behavior}: ${answer.message}`)), 100));
  out({ type: "result", subtype: "success", is_error: false, result: "Request interrupted by user", ...(turn.uuid ? { user_message_uuid: turn.uuid } : {}), session_id: sessionId, num_turns: 1, duration_ms: 5, stop_reason: "end_turn", total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 0 } });
};

/** Turns run one at a time, in the order they come; a message that arrives during a turn waits for it. */
/** @type {Promise<unknown>} */
let queue = Promise.resolve();
/** Messages waiting for their turn, so an interrupt with cancel_queued can drop them. */
const waiting = [];
const enqueue = (work) => { queue = queue.then(work).catch((error) => { process.stderr.write(`fake-claude: ${error?.stack ?? error}\n`); }); };
/** A notice of finished background work, queued as the real binary queues it: uuid-less, so cancel_queued drops it too. */
const enqueueNotice = (work) => { const entry = { cancelled: false, notice: true }; waiting.push(entry); enqueue(async () => { waiting.splice(waiting.indexOf(entry), 1); if (!entry.cancelled) await work(); }); };

/** A turn the binary starts by itself, as it does when background tasks it launched finish: their notices, then a turn. */
const selfStartedTurn = async (text, taskIds = ["fake-task"]) => {
  for (const taskId of taskIds) out({ type: "system", subtype: "task_notification", task_id: taskId, status: "completed", session_id: sessionId });
  const state = { interrupted: false, child: null };
  current = state;
  out({ type: "system", subtype: "init", session_id: sessionId, mcp_servers: INIT_MCP, capabilities: CAPABILITIES, tools: ["Bash", "Read", "Write"], permissionMode: "default", cwd: process.cwd(), model: "fake" });
  say(text);
  if (state.interrupted) return;
  current = null;
  result(1);
};

/** A subagent asking permission, as the real binary sends it: it names its agent, and its tool call comes first. By
 * default a background agent's; `call` names the main thread's Agent call a foreground one runs under, and `forwarded`
 * false is a nested agent, which asks before its call is forwarded. `person` makes it a question for the person instead
 * (`tool` AskUserQuestion, say), marked requires_user_interaction as Claude Code 2.1.304 sends one. */
let lastQuestion = null;
const subagentAsks = (input, { call = "toolu_bg_agent", agent = "fake-agent", toolUseId = "toolu_bg_bash", forwarded = true, tool = "Bash", person = false } = {}) => new Promise((resolve) => {
  const requestId = `req-${++counter}`;
  lastQuestion = requestId;
  pending.set(requestId, resolve);
  const toolUse = { type: "assistant", parent_tool_use_id: call, agent_id: agent, message: { role: "assistant", content: [{ type: "tool_use", id: toolUseId, name: tool, input }] }, session_id: sessionId };
  if (forwarded) out(toolUse);
  out({ type: "control_request", request_id: requestId, request: { subtype: "can_use_tool", tool_name: tool, display_name: tool, input, tool_use_id: toolUseId, agent_id: agent, ...(person ? { requires_user_interaction: true } : { description: "background command" }) } });
  if (!forwarded) out(toolUse);
  out({ type: "system", subtype: "task_progress", task_id: "fake-task", description: "waiting for permission", session_id: sessionId }); // a notice, not a turn
});

/** A subagent starting and ending, as the binary reports foreground ones too: its task id is its agent id. */
const taskStarted = (agent, call) => out({ type: "system", subtype: "task_started", task_id: agent, tool_use_id: call, description: "subagent", is_backgrounded: false, session_id: sessionId });
const taskDone = (agent, call) => out({ type: "system", subtype: "task_notification", task_id: agent, tool_use_id: call, status: "completed", session_id: sessionId });

async function turn(prompt, images = [], uuid = null) {
  const received = prompt;
  prompt = prompt.split("\n\nCurrent request:\n").at(-1);
  if (prompt.startsWith("race-self ") || prompt === "race-self-blocked") await selfStartedTurn("A background task finished first.");
  const state = { interrupted: false, child: null, lateTool: false, lateQuestion: false, uuid };
  current = state;
  turnsAnswered += 1;
  const continuing = resumed || turnsAnswered > 1; // this process, or a resumed one, already holds the conversation
  out({ type: "system", subtype: "init", session_id: sessionId, mcp_servers: INIT_MCP, capabilities: CAPABILITIES, tools: ["Bash", "Read", "Write"], permissionMode: "default", cwd: process.cwd(), model: "fake", user_message_uuids: uuid ? [uuid] : [] });
  const ownTags = /<(task-notification|bash-stdout|bash-stderr|local-command-stdout|local-command-stderr|tick)>/;
  if (replay && uuid && !ownTags.test(received)) out({ type: "user", message: { role: "user", content: received }, uuid, isReplay: true, parent_tool_use_id: null, session_id: sessionId });
  const tool = async (name, input, produce) => {
    const toolUseId = `toolu_${++counter}`;
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: toolUseId, name, input }] }, session_id: sessionId });
    const decision = await ask(name, input, { toolUseId });
    if (state.interrupted) return { denied: true, message: "interrupted" };
    if (decision.behavior !== "allow") {
      out({ type: "system", subtype: "permission_denied", tool_name: name, tool_use_id: toolUseId, message: decision.message, session_id: sessionId });
      out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: decision.message, is_error: true }] }, session_id: sessionId });
      return { denied: true, message: decision.message };
    }
    const produced = await produce(decision.updatedInput ?? input);
    if (state.interrupted) return { denied: true, message: "interrupted" };
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: produced.content, is_error: Boolean(produced.isError) }] }, session_id: sessionId });
    return { denied: false, content: produced.content };
  };
  let turns = 1;
  let match;
  if (prompt === '/compact') {
    // Claude takes its own /compact only as the whole message; anything wrapped around it would be answered in prose.
    // After the boundary the real binary replays what it kept: a summary, and the output of a local command just before.
    out({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 41000 }, session_id: sessionId });
    out({ type: 'user', isCompactSummary: true, message: { role: 'user', content: 'This session is being continued from a previous conversation.' }, session_id: sessionId });
    if (lastLocalOutput) out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: lastLocalOutput }] }, session_id: sessionId });
  } else if (prompt === '/cost') {
    // A command the binary answers itself, without the model: its output, unstreamed, then an empty result.
    lastLocalOutput = "Total cost: $0.0042";
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: lastLocalOutput }] }, session_id: sessionId });
    out({ type: "result", subtype: "success", is_error: false, result: lastLocalOutput, ...(uuid ? { user_message_uuid: uuid } : {}), session_id: sessionId, num_turns: 0, duration_ms: 1, stop_reason: null, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 }, modelUsage: { fake: { contextWindow: 1_000_000, maxOutputTokens: 64_000 } } });
    current = null;
    return;
  } else if (received.startsWith('/')) {
    // Any other slash command, likewise: the whole message is echoed, so a handoff wrapped around it would show.
    say(`Command received: ${received}`);
  } else if (prompt === 'subagent-review') {
    const parentId = 'toolu_reviewer';
    const child = message => out({ ...message, parent_tool_use_id: parentId, session_id: sessionId });
    const event = value => out({ type: 'stream_event', event: value, parent_tool_use_id: null, session_id: sessionId });
    const report = '[{"file":"app.js","line":10,"summary":"INTERNAL_REVIEW","failure_scenario":"internal details"}]';
    out({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'tool_use', id: parentId, name: 'Agent', input: { description: 'Review the code', subagent_type: 'code-reviewer', prompt: 'Review the code' } }] }, session_id: sessionId });
    // Two overlapping streams use the same block index. A child stop must not clear the parent's block.
    event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'I found one issue. ' } });
    child({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
    child({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: report } } });
    child({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
    child({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: report }, { type: 'tool_use', id: 'child-bash', name: 'Bash', input: { command: 'echo child-review' } }] } });
    // Child permissions still go through the host policy even though their transcript stays internal.
    const decision = await new Promise(resolve => {
      pending.set('child-permission', resolve);
      child({ type: 'control_request', request_id: 'child-permission', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'echo child-review' }, tool_use_id: 'child-bash' } });
    });
    child({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'child-bash', content: decision.behavior }] } });
    child({ type: 'stream_event', event: { type: 'message_stop' } });
    child({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'SECOND_INTERNAL_REVIEW' }, { type: 'tool_use', id: 'child-read', name: 'Read', input: { file_path: 'app.js' } }] } });
    out({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: parentId, content: report }] }, session_id: sessionId });
    event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Validate the interval before saving.' } });
    event({ type: 'content_block_stop', index: 0 });
    out({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'I found one issue. Validate the interval before saving.' }] }, session_id: sessionId });
    event({ type: 'message_stop' });
  } else if (prompt === 'subagent-long') {
    // A subagent long enough to pass the bound on its progress, with paths long enough to be cut at a step's width.
    const parentId = 'toolu_long';
    out({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'tool_use', id: parentId, name: 'Agent', input: { description: 'Read everything', subagent_type: 'Explore', prompt: 'Read everything' } }] }, session_id: sessionId });
    for (let index = 0; index < 200; index++) {
      out({ type: 'assistant', parent_tool_use_id: parentId, message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: `child-${index}`, name: 'Read', input: { file_path: `src/${String(index).padStart(3, '0')}/${'deep/'.repeat(40)}file.js` } }] }, session_id: sessionId });
    }
    out({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: parentId, content: 'LONG_REPORT' }] }, session_id: sessionId });
    say('Read it all.');
  } else if (prompt === 'browser-discovery') {
    say(offersBrowser(JSON.parse(valueOf('--mcp-config') ?? '{}').mcpServers?.jolo) ? 'Browser tools available' : 'Browser tools unavailable');
  } else if (prompt === 'browser-check') {
    if (!valueOf('--append-system-prompt')?.includes('Do not use computer use')) throw new Error('Jolo browser instructions missing');
    const config = JSON.parse(valueOf('--mcp-config') ?? '{}').mcpServers?.jolo;
    if (!offersBrowser(config)) say('Browser tools unavailable');
    else {
      const { browserMcpCheck } = await import('./browser-mcp-client.js');
      const outcome = await tool('mcp__jolo__browser_screenshot', {}, async () => ({ content: await browserMcpCheck(config) }));
      say(outcome.denied ? outcome.message : outcome.content);
    }
  } else if (prompt === 'schedule-check') {
    const config = JSON.parse(valueOf('--mcp-config') ?? '{}').mcpServers?.jolo;
    if (!config) throw new Error('jolo MCP was not configured');
    const { mcpCall } = await import('./browser-mcp-client.js');
    const created = await tool('mcp__jolo__schedule_create', { every: '15m', prompt: 'check the board' }, async () => ({ content: (await mcpCall(config, 'schedule_create', { every: '15m', prompt: 'check the board' })) }));
    if (created.denied) say(created.message);
    else {
      const listed = await tool('mcp__jolo__schedule_list', {}, async () => ({ content: (await mcpCall(config, 'schedule_list', {})) }));
      say(listed.denied ? listed.message : `Schedules on this task: ${listed.content?.schedules?.length ?? 0}`);
    }
  } else if (prompt === 'image-check') {
    say(`Images received: ${images.map(image => `${image.source.media_type}:${Buffer.from(image.source.data, 'base64').length}`).join(', ')}`);
  } else if ((match = prompt.match(/^run (.+)$/s)) || (match = prompt.match(/^run-described ([^\n]+)\n(.+)$/s))) {
    // "run <cmd>" asks for a Bash call with no description; "run-described <description>\n<cmd>" with one, as Claude Code
    // gives most of its commands.
    turns = 2;
    const described = prompt.startsWith("run-described ");
    const outcome = await tool("Bash", described ? { command: match[2], description: match[1] } : { command: match[1] }, async (input) => {
      // Spawned, not run synchronously, so an interrupt from the host can still be read and acted on.
      const proc = Bun.spawn(["/bin/sh", "-c", input.command], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
      state.child = proc;
      const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      await proc.exited;
      state.child = null;
      return { content: stdout.trim() || stderr.trim(), isError: proc.exitCode !== 0 };
    });
    if (!state.interrupted) say(outcome.denied ? `I could not run it: ${outcome.message}` : `The command printed: ${outcome.content}`);
  } else if ((match = prompt.match(/^write (\S+) (.+)$/s))) {
    turns = 2;
    const outcome = await tool("Write", { file_path: match[1], content: match[2] }, async (input) => { await Bun.write(input.file_path, input.content); return { content: `Wrote ${input.file_path}` }; });
    if (!state.interrupted) say(outcome.denied ? `I could not write it: ${outcome.message}` : "Written.");
  } else if ((match = prompt.match(/^read (\S+)$/))) {
    turns = 2;
    const outcome = await tool("Read", { file_path: match[1] }, async (input) => ({ content: await Bun.file(input.file_path).text() }));
    if (!state.interrupted) say(outcome.denied ? `I could not read it: ${outcome.message}` : `The file says: ${outcome.content.trim()}`);
  } else if ((match = prompt.match(/^ask-user-slow (\d+)$/))) {
    // Claude asks the person "tea or coffee?", then takes <ms> to act on the answer, so a Stop lands while it is in flight.
    turns = 2;
    const question = "tea or coffee?";
    const input = { questions: [{ question, header: "Choice", options: [{ label: "tea", description: "" }, { label: "coffee", description: "" }], multiSelect: false }] };
    const toolUseId = `toolu_${++counter}`;
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: toolUseId, name: "AskUserQuestion", input }] }, session_id: sessionId });
    const decision = await askPerson("AskUserQuestion", input, toolUseId);
    for (let waited = 0; waited < Number(match[1]) && !state.interrupted; waited += 20) await sleep(20);
    if (state.interrupted) return;
    say(`You answered: ${decision.updatedInput?.answers?.[question] ?? decision.message}`);
  } else if ((match = prompt.match(/^ask-user (.+)$/s))) {
    // Claude asks the person (AskUserQuestion). An allow carries the answers, keyed by the question's text; an allow
    // without them is a question nobody answered, as the real binary reports it; a deny is the person not answering.
    turns = 2;
    const question = match[1];
    const input = { questions: [{ question, header: "Choice", options: [{ label: "tea", description: "" }, { label: "coffee", description: "" }], multiSelect: false }] };
    const toolUseId = `toolu_${++counter}`;
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: toolUseId, name: "AskUserQuestion", input }] }, session_id: sessionId });
    const decision = await askPerson("AskUserQuestion", input, toolUseId);
    if (state.interrupted) return;
    const answer = decision.behavior === "allow" ? decision.updatedInput?.answers?.[question] : undefined;
    const unanswered = answer === undefined ? (decision.behavior === "allow" ? "The user did not answer the questions." : decision.message) : null;
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: unanswered ?? `Your questions have been answered: "${question}"="${answer}". You can now continue with these answers in mind.`, ...(decision.behavior === "allow" ? {} : { is_error: true }) }] }, session_id: sessionId });
    say(unanswered === null ? `You answered: ${answer}` : `No answer: ${unanswered}`);
  } else if ((match = prompt.match(/^exit-plan (.+)$/s))) {
    // Claude asks the person to approve its plan (ExitPlanMode). An allow approves it; a deny sends it back with the
    // person's feedback as its message.
    turns = 2;
    const title = match[1];
    const input = { plan: `# ${title}\n\n1. Do the thing.`, planFilePath: "/tmp/plan.md" };
    const toolUseId = `toolu_${++counter}`;
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: toolUseId, name: "ExitPlanMode", input }] }, session_id: sessionId });
    const decision = await askPerson("ExitPlanMode", input, toolUseId);
    if (state.interrupted) return;
    const approved = decision.behavior === "allow";
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: approved ? "User has approved your plan." : decision.message, ...(approved ? {} : { is_error: true }) }] }, session_id: sessionId });
    say(approved ? `Plan approved: ${title}` : `Plan sent back: ${decision.message}`);
  } else if ((match = prompt.match(/^ask-user-withdraw (\d+)$/))) {
    // Claude asks the person, then takes the question back <ms> later and answers without it.
    const input = { questions: [{ question: "tea or coffee?", header: "Choice", options: [{ label: "tea", description: "" }, { label: "coffee", description: "" }], multiSelect: false }] };
    const toolUseId = `toolu_${++counter}`;
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: toolUseId, name: "AskUserQuestion", input }] }, session_id: sessionId });
    void askPerson("AskUserQuestion", input, toolUseId);
    const asked = `req-${counter}`;
    await sleep(Number(match[1]));
    if (state.interrupted) return;
    takeBack(asked);
    say("Never mind the question.");
  } else if ((match = prompt.match(/^ask-user-exit (\d+)$/))) {
    // Claude asks the person, then its process ends <ms> later without an answer or a result (a crash).
    const input = { questions: [{ question: "tea or coffee?", header: "Choice", options: [{ label: "tea", description: "" }, { label: "coffee", description: "" }], multiSelect: false }] };
    const toolUseId = `toolu_${++counter}`;
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: toolUseId, name: "AskUserQuestion", input }] }, session_id: sessionId });
    void askPerson("AskUserQuestion", input, toolUseId);
    await sleep(Number(match[1]));
    process.exit(1);
  } else if (prompt === "history") {
    say(`${continuing ? "Resumed" : "Fresh agent"} context: ${received}`);
  } else if (prompt.startsWith("model")) {
    say(`Running ${chosenModel ?? "the default model"} at ${chosenEffort ?? "the default effort"}${fastMode ? " in fast mode" : ""}.`);
  } else if ((match = prompt.match(/^background (\d+) (.+)$/s))) {
    say("Background work started.");
    const [, delay, text] = match;
    out({ type: "system", subtype: "task_started", task_id: "fake-task", run_id: "fake-task-run", task_type: "local_bash", description: "background work", is_backgrounded: true, session_id: sessionId });
    inBackground(() => out({ type: "system", subtype: "task_progress", task_id: "fake-task", usage: { total_tokens: 1234, tool_uses: 1, duration_ms: Number(delay) / 2 }, session_id: sessionId }), Number(delay) / 2);
    inBackground(() => enqueue(() => selfStartedTurn(text)), Number(delay));
  } else if ((match = prompt.match(/^tasks (\d+) (\d+)$/))) {
    // <n> background tasks that move to a phase "review" and report their usage halfway through <ms>, with a progress line
    // "Running task <i>" and the tool Bash, and end together after it with the summary "task <i>", each on timers of its
    // own so that stop_task ends one alone. Those that completed are reported in a turn of their own, as "background" is;
    // when none did, there is nothing to report.
    const [count, ms] = [Number(match[1]), Number(match[2])];
    say(`Started ${count} tasks.`);
    let completed = 0;
    for (let i = 1; i <= count; i++) {
      const taskId = `task-${i}`;
      startTask(taskId);
      out({ type: "system", subtype: "task_started", task_id: taskId, run_id: `${taskId}-run`, tool_use_id: `toolu_task_${i}`, task_type: "local_bash", description: `task ${i}`, is_backgrounded: true, session_id: sessionId });
      inBackground(() => {
        out({ type: "system", subtype: "task_updated", task_id: taskId, patch: { workflow_phase: "review", description: `task ${i}, reviewing` }, session_id: sessionId });
        out({ type: "system", subtype: "task_progress", task_id: taskId, description: `Running task ${i}`, last_tool_name: "Bash", usage: { total_tokens: 1000 * i, tool_uses: i, duration_ms: ms / 2 }, session_id: sessionId });
      }, ms / 2, taskId);
      inBackground(() => { completed += 1; endTask(taskId, "completed", { summary: `task ${i}` }); }, ms, taskId);
    }
    inBackground(() => { if (completed) enqueue(() => selfStartedTurn(`${completed} of ${count} tasks done.`, [])); }, ms);
  } else if ((match = prompt.match(/^tasks-stubborn (\d+)$/))) {
    // <n> background tasks that never end by themselves and ignore stop_task: it is answered, and they go on. Only an
    // interrupt that does not spare background work, or the process's end, ends them.
    const count = Number(match[1]);
    say(`Started ${count} stubborn tasks.`);
    for (let i = 1; i <= count; i++) {
      startTask(`task-${i}`, { stubborn: true });
      out({ type: "system", subtype: "task_started", task_id: `task-${i}`, run_id: `task-${i}-run`, tool_use_id: `toolu_task_${i}`, task_type: "local_bash", description: `stubborn task ${i}`, is_backgrounded: true, session_id: sessionId });
    }
  } else if ((match = prompt.match(/^workflow (\S+) (\d+)$/))) {
    // A workflow named <name>, as Claude Code 2.1.304 reports one: ONE task of type local_workflow carrying its name,
    // with a run id of its own and no is_backgrounded field (the binary sets that only for agents and commands). Each of
    // its progress reports lists its phases and agents (workflow_progress) and names the current agent in its
    // description, with the running sum of the agents' tokens in usage: both agents of phase Say start at once, say:1 is
    // done halfway through <ms>, both are done at <ms>, when it completes with a summary and an output file, as the probe's
    // notice did; all on timers of its own so that stop_task ends it. A moment after it completes, a turn of its own
    // reports it, as "background" does. The turn calls the Workflow tool as Claude Code does, a script run inline whose
    // meta names the workflow, around the task's start, and the tool answers that it started in the background. The real
    // binary asks permission for the call first; this scenario does not (the permission path is covered elsewhere and is
    // not what it is about).
    const [name, ms] = [match[1], Number(match[2])];
    // Every task has an id of its own: the first workflow of a process is wf-1, the next wf-2, and so on.
    const n = ++workflows;
    const [taskId, runId, toolUseId] = [`wf-${n}`, `wf-${n}-run`, `toolu_wf_${n}`];
    say("Workflow started.");
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: toolUseId, name: "Workflow", input: { script: `export const meta = {\n  name: '${name}',\n  description: 'Workflow ${name}',\n  phases: [{ title: 'Say' }],\n}\nphase('Say')\nawait parallel([1, 2].map(index => () => agent(\`Reply with exactly: agent \${index} ok\`, { label: \`say:\${index}\` })))\n` } }] }, session_id: sessionId });
    startTask(taskId);
    out({ type: "system", subtype: "task_started", task_id: taskId, run_id: runId, tool_use_id: toolUseId, task_type: "local_workflow", workflow_name: name, description: `Workflow ${name}`, session_id: sessionId });
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: `Workflow started in the background (task ${taskId}).` }] }, session_id: sessionId });
    const agent = (index, state, done = {}) => ({ type: "workflow_agent", index, label: `say:${index}`, phaseIndex: 1, phaseTitle: "Say", agentId: `agent-${index}`, model: "claude-fable-5-1", state, attempt: 1, promptPreview: `Reply with exactly: agent ${index} ok`, ...done });
    const finished = (index) => ({ tokens: 20388, toolCalls: 0, durationMs: ms / 2, resultPreview: `agent ${index} ok` });
    const progress = (current, usage, agents) => out({ type: "system", subtype: "task_progress", task_id: taskId, run_id: runId, tool_use_id: toolUseId, description: `Say: ${current}`, last_tool_name: current, summary: `Workflow ${name}`, usage, workflow_progress: [{ type: "workflow_phase", index: 1, title: "Say" }, ...agents], session_id: sessionId });
    progress("say:1", { total_tokens: 0, tool_uses: 0, duration_ms: 42 }, [agent(1, "start"), agent(2, "start")]);
    // Halfway, say:2 is at work: Claude Code's `progress` state, with its tokens and tool calls so far.
    inBackground(() => progress("say:1", { total_tokens: 20388, tool_uses: 0, duration_ms: ms / 2 }, [agent(1, "done", finished(1)), agent(2, "progress", { tokens: 8000, toolCalls: 1 })]), ms / 2, taskId);
    inBackground(() => {
      progress("say:2", { total_tokens: 40776, tool_uses: 0, duration_ms: ms }, [agent(1, "done", finished(1)), agent(2, "done", finished(2))]);
      endTask(taskId, "completed", { summary: `Dynamic workflow "Workflow ${name}" completed`, output_file: `/tmp/${name}.output` });
      inBackground(() => enqueue(() => selfStartedTurn(`Workflow ${name} done.`, [])), WORKFLOW_REPORT_DELAY_MS);
    }, ms, taskId);
  } else if ((match = prompt.match(/^nested-agent (\d+)$/))) {
    // A background subagent and the command it runs, as Claude Code 2.1.304 reports them (the send-now probe): the
    // subagent agent-1 (local_agent, spawn_depth 1) says what it does now and the tool it last used; its command cmd-1
    // (local_bash, a foreground call of the subagent's) names it as its parent and is owned by it. At <ms> the command
    // ends, then the subagent, each with its description as its summary and the subagent with an output file, and a turn
    // of its own reports it. stop_task on the subagent kills it as an interrupt did in the probe: its command is stopped
    // first, then task_updated says killed and the notice says stopped.
    const ms = Number(match[1]);
    say("Agent started.");
    // As Claude Code 2.1.304 keeps it, the subagent's output file is a link to its transcript, JSON lines written as it
    // works (a message, or one content block of one, a line), whose last assistant message is its report; the file is
    // named only in the subagent's notice.
    const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-claude-"));
    const transcript = path.join(dir, "subagents", "agent-agent-1.jsonl");
    const report = path.join(dir, "tasks", "agent-1.output");
    fs.mkdirSync(path.dirname(transcript)); fs.mkdirSync(path.dirname(report));
    const said = (entry) => fs.appendFileSync(transcript, `${JSON.stringify({ ...entry, agentId: "agent-1-agent", sessionId })}\n`);
    said({ type: "user", message: { role: "user", content: "Run the checks with Bash, then reply: done" } });
    said({ type: "assistant", message: { id: "msg_agent_1", role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", id: "toolu_cmd_1", name: "Bash", input: { command: "bun test" } }] } });
    said({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_cmd_1", content: "12 pass, 0 fail" }] } });
    fs.symlinkSync(transcript, report);
    const ended = (status) => {
      endTask("cmd-1", status, { summary: "Run the checks command", output_file: "" });
      if (status === "stopped") out({ type: "system", subtype: "task_updated", task_id: "agent-1", patch: { status: "killed", end_time: Date.now() }, session_id: sessionId });
      if (status === "completed") said({ type: "assistant", message: { id: "msg_agent_2", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "The checks pass: 12 tests, no failures." }] } });
      endTask("agent-1", status, { summary: "Run the checks", output_file: report });
    };
    startTask("agent-1", { onStop: () => ended("stopped") });
    startTask("cmd-1");
    out({ type: "system", subtype: "task_started", task_id: "agent-1", run_id: "agent-1-run", tool_use_id: "toolu_agent_1", task_type: "local_agent", subagent_type: "general-purpose", description: "Run the checks", is_backgrounded: true, spawn_depth: 1, prompt: "Run the checks with Bash, then reply: done", session_id: sessionId });
    out({ type: "system", subtype: "task_progress", task_id: "agent-1", run_id: "agent-1-run", tool_use_id: "toolu_agent_1", subagent_type: "general-purpose", description: "Running Run the checks", last_tool_name: "Bash", usage: { total_tokens: 22304, tool_uses: 1, duration_ms: 4659 }, session_id: sessionId });
    out({ type: "system", subtype: "task_started", task_id: "cmd-1", run_id: "cmd-1-run", tool_use_id: "toolu_cmd_1", task_type: "local_bash", description: "Run the checks command", is_backgrounded: false, parent_task_id: "agent-1", owned_by_subagent: true, session_id: sessionId });
    // The subagent's own message, which alone names its model (agent_id and the call it runs under on the envelope).
    out({ type: "assistant", agent_id: "agent-1-agent", parent_tool_use_id: "toolu_agent_1", message: { id: "msg_agent_1", role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", id: "toolu_cmd_1", name: "Bash", input: { command: "bun test" } }] }, session_id: sessionId });
    inBackground(() => { ended("completed"); enqueue(() => selfStartedTurn("Agent agent-1 done.", [])); }, ms, "agent-1");
  } else if ((match = prompt.match(/^away-summary (.+)$/s))) {
    // The summary Claude Code gives when the person comes back after being away (its field unprobed; `summary` here), then a reply.
    out({ type: "system", subtype: "away_summary", summary: match[1], session_id: sessionId });
    say("Welcome back.");
  } else if (prompt === "notify-unknown") {
    // A task ends that was never seen to start, then the turn answers.
    out({ type: "system", subtype: "task_notification", task_id: "ghost", status: "failed", session_id: sessionId });
    say("A task nobody saw start has ended.");
  } else if (prompt === "tasks-malformed") {
    // Task notices with fields of the wrong type or far too long, and two that name no usable task; then the turn answers.
    out({ type: "system", subtype: "task_started", task_id: "odd", run_id: 7, tool_use_id: "u".repeat(300), description: 42, subagent_type: { name: "x" }, is_backgrounded: true, session_id: sessionId });
    out({ type: "system", subtype: "task_started", task_id: "long", description: "d".repeat(2000), is_backgrounded: true, session_id: sessionId });
    out({ type: "system", subtype: "task_progress", task_id: "odd", usage: { total_tokens: -5, tool_uses: 2.7, duration_ms: "soon" }, session_id: sessionId });
    out({ type: "system", subtype: "task_updated", task_id: "long", patch: { phase: "p".repeat(1000), description: { text: "x" } }, session_id: sessionId });
    out({ type: "system", subtype: "task_started", task_id: "", description: "no id", is_backgrounded: true, session_id: sessionId });
    out({ type: "system", subtype: "task_started", task_id: { id: 1 }, description: "an object for an id", is_backgrounded: true, session_id: sessionId });
    say("Malformed tasks reported.");
  } else if (prompt === "ask-user-unrecordable") {
    // Claude asks the person with an input that is not an object, which Jolo cannot record as a dialog; says what it was told.
    turns = 2;
    const toolUseId = `toolu_${++counter}`;
    const decision = await askPerson("AskUserQuestion", ["not", "an", "object"], toolUseId);
    if (state.interrupted) return;
    say(decision.behavior === "allow" ? "Allowed." : `No answer: ${decision.message}`);
  } else if (prompt === "task-updated-stop") {
    // A background task whose update names its phase and says it was stopped, with no notice of its end; then the turn answers.
    out({ type: "system", subtype: "task_started", task_id: "patched", description: "patched task", is_backgrounded: true, session_id: sessionId });
    out({ type: "system", subtype: "task_updated", task_id: "patched", patch: { phase: "build", status: "stopped" }, session_id: sessionId });
    say("A task was stopped.");
  } else if ((match = prompt.match(/^background-slow (\d+) (\d+) (.+)$/s))) {
    say("Background work started.");
    const [, delay, ms, text] = match;
    setTimeout(() => enqueue(async () => {
      out({ type: "system", subtype: "task_notification", task_id: "fake-task", status: "completed", session_id: sessionId });
      const self = { interrupted: false, child: null };
      current = self;
      out({ type: "system", subtype: "init", session_id: sessionId, mcp_servers: INIT_MCP, capabilities: CAPABILITIES, tools: ["Bash"], permissionMode: "default", cwd: process.cwd(), model: "fake", user_message_uuids: [] });
      out({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, session_id: sessionId });
      await sleep(Number(ms));
      if (self.interrupted) return;
      current = null;
      out({ type: "stream_event", event: { type: "content_block_stop", index: 0 }, session_id: sessionId });
      say(text);
      result(1);
    }), Number(delay));
  } else if ((match = prompt.match(/^background-withdraw (\d+) (\d+)$/))) {
    // The subagent asks, then takes the question back (it was stopped, or settled it another way) and reports later.
    say("Background agent started.");
    const [, delay, ms] = match;
    setTimeout(() => {
      void subagentAsks({ command: "echo background" });
      const asked = lastQuestion;
      setTimeout(() => {
        takeBack(asked);
        setTimeout(() => enqueue(() => selfStartedTurn("Background agent finished: withdrawn")), 100);
      }, Number(ms));
    }, Number(delay));
  } else if ((match = prompt.match(/^background-chatter (\d+) (\d+)$/))) {
    // The subagent asks; while nobody answers, the main thread answers something else at length, by itself.
    say("Background agent started.");
    const [, delay, size] = match;
    setTimeout(async () => {
      const decision = subagentAsks({ command: "echo background" });
      // Once a run is waiting on the question: what the main thread says now must still be read.
      await sleep(500);
      enqueue(() => selfStartedTurn("x".repeat(Number(size))));
      const answered = await decision;
      enqueue(() => selfStartedTurn(`Background agent finished: ${answered.behavior}`));
    }, Number(delay));
  } else if ((match = prompt.match(/^background-two (\d+)$/))) {
    // Two subagents ask at once, and report back together once both have their answers.
    say("Background agents started.");
    setTimeout(async () => {
      const answers = await Promise.all([subagentAsks({ command: "echo one" }), subagentAsks({ command: "echo two" })]);
      setTimeout(() => enqueue(() => selfStartedTurn(`Background agents finished: ${answers.map((answer) => answer.behavior).join(", ")}`)), 100);
    }, Number(match[1]));
  } else if ((match = prompt.match(/^background-permission (\d+) (\d+)$/))) {
    say("Background agent started.");
    const [, delay, work] = match;
    setTimeout(async () => {
      const decision = await subagentAsks({ command: "echo background" });
      setTimeout(() => enqueue(() => selfStartedTurn(`Background agent finished: ${decision.behavior}`)), Number(work));
    }, Number(delay));
  } else if ((match = prompt.match(/^background-dialog (\d+) (\d+)$/))) {
    // As background-permission, but the background subagent asks the person "tea or coffee?" (AskUserQuestion) and
    // reports the answer, or why there was none.
    say("Background agent started.");
    const [, delay, work] = match;
    const question = "tea or coffee?";
    const input = { questions: [{ question, header: "Choice", options: [{ label: "tea", description: "" }, { label: "coffee", description: "" }], multiSelect: false }] };
    setTimeout(async () => {
      const decision = await subagentAsks(input, { tool: "AskUserQuestion", toolUseId: "toolu_bg_ask", person: true });
      const answer = decision.behavior === "allow" ? decision.updatedInput?.answers?.[question] : decision.message;
      setTimeout(() => enqueue(() => selfStartedTurn(`Background agent finished: ${answer}`)), Number(work));
    }, Number(delay));
  } else if ((match = prompt.match(/^race-self (.+)$/s))) {
    say(`You said: ${match[1]}`);
  } else if ((match = prompt.match(/^zero-result (.+)$/s))) {
    out({ type: "result", subtype: "success", is_error: false, result: "", session_id: sessionId, num_turns: 0, duration_ms: 1, stop_reason: null, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } });
    say(`You said: ${match[1]}`);
  } else if ((match = prompt.match(/^zero-result-slow (\d+) (.+)$/s))) {
    // An empty result, then an answer that starts at once and takes <ms> to finish.
    out({ type: "result", subtype: "success", is_error: false, result: "", session_id: sessionId, num_turns: 0, duration_ms: 1, stop_reason: null, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } });
    const [, ms, text] = match;
    out({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, session_id: sessionId });
    out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Partly " } }, session_id: sessionId });
    await sleep(Number(ms));
    if (state.interrupted) return;
    out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }, session_id: sessionId });
    out({ type: "stream_event", event: { type: "content_block_stop", index: 0 }, session_id: sessionId });
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `Partly ${text}` }] }, session_id: sessionId });
    out({ type: "stream_event", event: { type: "message_stop" }, session_id: sessionId });
  } else if ((match = prompt.match(/^zero-result-late (\d+) (.+)$/s))) {
    // An empty result, then nothing for <ms>, then the answer.
    out({ type: "result", subtype: "success", is_error: false, result: "", session_id: sessionId, num_turns: 0, duration_ms: 1, stop_reason: null, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } });
    await sleep(Number(match[1]));
    if (!state.interrupted) say(`You said: ${match[2]}`);
  } else if (prompt === "zero-result-only" || prompt === "zero-result-ask") {
    // The empty result is the whole turn. A notice about the session follows it; or a background subagent asks.
    out({ type: "result", subtype: "success", is_error: false, result: "", session_id: sessionId, num_turns: 0, duration_ms: 1, stop_reason: null, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } });
    if (prompt === "zero-result-only") out({ type: "rate_limit_event", rate_limit_info: { status: "allowed" }, session_id: sessionId });
    else void subagentAsks({ command: "echo background" }).then((answer) => setTimeout(() => enqueue(() => selfStartedTurn(`Background agent finished: ${answer.behavior}`)), 100));
    current = null;
    return;
  } else if ((match = prompt.match(/^ask-then-turn (\d+)$/))) {
    // A subagent asks during the turn and is still unanswered when the turn ends; then the process begins a turn of its
    // own (another background task reporting back) that takes <ms> to finish.
    void subagentAsks({ command: "echo background" });
    say("Launched.");
    setTimeout(() => enqueue(async () => {
      out({ type: "system", subtype: "task_notification", task_id: "fake-task", status: "completed", session_id: sessionId });
      const self = { interrupted: false, child: null };
      current = self;
      out({ type: "system", subtype: "init", session_id: sessionId, mcp_servers: INIT_MCP, capabilities: CAPABILITIES, tools: ["Bash"], permissionMode: "default", cwd: process.cwd(), model: "fake", user_message_uuids: [] });
      out({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, session_id: sessionId });
      out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Report part one, " } }, session_id: sessionId });
      await sleep(Number(match[1]));
      if (self.interrupted) return;
      out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "part two." } }, session_id: sessionId });
      out({ type: "stream_event", event: { type: "content_block_stop", index: 0 }, session_id: sessionId });
      out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Report part one, part two." }] }, session_id: sessionId });
      current = null;
      result(1);
    }), 100);
  } else if (prompt === "nested-background-jolo") {
    // A background agent runs one of its own, which uses one of Jolo's tools after the turn.
    out({ type: "system", subtype: "task_started", task_id: "bg-outer", tool_use_id: "toolu_bg_agent", description: "background", is_backgrounded: true, session_id: sessionId });
    say("Background agent started.");
    setTimeout(() => {
      out({ type: "assistant", parent_tool_use_id: "toolu_bg_agent", agent_id: "bg-outer", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_bg_inner", name: "Agent", input: { description: "deeper" } }] }, session_id: sessionId });
      out({ type: "system", subtype: "task_started", task_id: "bg-inner", tool_use_id: "toolu_bg_inner", description: "deeper", is_backgrounded: false, session_id: sessionId });
      const requestId = `req-${++counter}`;
      pending.set(requestId, (answer) => setTimeout(() => {
        if (forwardsNested) out({ type: "user", parent_tool_use_id: "toolu_bg_inner", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_deep_jolo", content: answer.behavior }] }, session_id: sessionId });
        out({ type: "system", subtype: "task_notification", task_id: "bg-inner", tool_use_id: "toolu_bg_inner", status: "completed", session_id: sessionId });
        out({ type: "system", subtype: "task_notification", task_id: "bg-outer", tool_use_id: "toolu_bg_agent", status: "completed", session_id: sessionId });
      }, 300));
      out({ type: "control_request", request_id: requestId, request: { subtype: "can_use_tool", tool_name: "mcp__jolo__browser_open", display_name: "browser_open", input: {}, tool_use_id: "toolu_deep_jolo", agent_id: "bg-inner" } });
      if (forwardsNested) out({ type: "assistant", parent_tool_use_id: "toolu_bg_inner", agent_id: "bg-inner", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_deep_jolo", name: "mcp__jolo__browser_open", input: {} }] }, session_id: sessionId });
    }, 100);
  } else if ((match = prompt.match(/^background-jolo (\d+)$/))) {
    // A background subagent uses one of Jolo's own tools after the turn: it asks, then the call takes <ms> to report back.
    say("Background agent started.");
    setTimeout(() => {
      const requestId = `req-${++counter}`;
      out({ type: "assistant", parent_tool_use_id: "toolu_bg_agent", agent_id: "fake-agent", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_bg_jolo", name: "mcp__jolo__browser_open", input: {} }] }, session_id: sessionId });
      pending.set(requestId, (answer) => {
        setTimeout(() => {
          out({ type: "user", parent_tool_use_id: "toolu_bg_agent", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_bg_jolo", content: answer.behavior }] }, session_id: sessionId });
          setTimeout(() => enqueue(() => selfStartedTurn(`Background agent finished: ${answer.behavior}`)), 100);
        }, Number(match[1]));
      });
      out({ type: "control_request", request_id: requestId, request: { subtype: "can_use_tool", tool_name: "mcp__jolo__browser_open", display_name: "browser_open", input: {}, tool_use_id: "toolu_bg_jolo", agent_id: "fake-agent" } });
    }, 100);
  } else if (prompt === "two-background") {
    // Two background tasks: A reports in a long turn of its own; B finishes while A's report still streams.
    say("Background work started.");
    out({ type: "system", subtype: "task_started", task_id: "task-a", description: "A", is_backgrounded: true, session_id: sessionId });
    out({ type: "system", subtype: "task_started", task_id: "task-b", description: "B", is_backgrounded: true, session_id: sessionId });
    inBackground(() => enqueueNotice(async () => {
      out({ type: "system", subtype: "task_notification", task_id: "task-a", status: "completed", session_id: sessionId });
      const self = { interrupted: false, child: null };
      current = self;
      out({ type: "system", subtype: "init", session_id: sessionId, mcp_servers: INIT_MCP, capabilities: CAPABILITIES, tools: ["Bash"], permissionMode: "default", cwd: process.cwd(), model: "fake", user_message_uuids: [] });
      out({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, session_id: sessionId });
      for (let waited = 0; waited < 2000 && !self.interrupted; waited += 50) await sleep(50);
      if (self.interrupted) return;
      current = null;
      out({ type: "stream_event", event: { type: "content_block_stop", index: 0 }, session_id: sessionId });
      say("report A");
      result(1);
    }), 100);
    inBackground(() => enqueueNotice(async () => {
      out({ type: "system", subtype: "task_notification", task_id: "task-b", status: "completed", session_id: sessionId });
      const self = { interrupted: false, child: null };
      current = self;
      out({ type: "system", subtype: "init", session_id: sessionId, mcp_servers: INIT_MCP, capabilities: CAPABILITIES, tools: ["Bash"], permissionMode: "default", cwd: process.cwd(), model: "fake", user_message_uuids: [] });
      say("report B");
      current = null;
      result(1);
    }), 600);
  } else if (prompt === "background-agent-turn") {
    // Background work reports in a turn of its own that calls a subagent in the foreground before answering.
    say("Background work started.");
    setTimeout(() => enqueue(async () => {
      out({ type: "system", subtype: "task_notification", task_id: "fake-task", status: "completed", session_id: sessionId });
      out({ type: "system", subtype: "init", session_id: sessionId, mcp_servers: INIT_MCP, capabilities: CAPABILITIES, tools: ["Agent"], permissionMode: "default", cwd: process.cwd(), model: "fake", user_message_uuids: [] });
      out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_fg", name: "Agent", input: { description: "Check it", subagent_type: "Explore", prompt: "Check it" } }] }, session_id: sessionId });
      out({ type: "assistant", parent_tool_use_id: "toolu_fg", message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", id: "child-read", name: "Read", input: { file_path: "notes.txt" } }] }, session_id: sessionId });
      out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_fg", content: "checked" }] }, session_id: sessionId });
      say("All checked.");
      result(1);
    }), 50);
  } else if (prompt === "hook-blocked" || prompt === "race-self-blocked") {
    // The user's own UserPromptSubmit hook blocks the message: no model call, and the reason is the result.
    out({ type: "system", subtype: "informational", level: "warning", content: "UserPromptSubmit operation blocked by hook", session_id: sessionId });
    out({ type: "result", subtype: "success", is_error: false, result: "Blocked by your hook: the message contains a secret.", ...(uuid ? { user_message_uuid: uuid } : {}), session_id: sessionId, num_turns: 0, duration_ms: 1, stop_reason: null, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } });
    current = null;
    return;
  } else if (prompt === "background-read") {
    // Background work reads a file in the workspace after the turn: Jolo's policy answers it, nobody is asked.
    say("Background agent started.");
    setTimeout(async () => {
      const requestId = `req-${++counter}`;
      const answer = new Promise((resolve) => pending.set(requestId, resolve));
      out({ type: "control_request", request_id: requestId, request: { subtype: "can_use_tool", tool_name: "Read", display_name: "Read", input: { file_path: "notes.txt" }, tool_use_id: "toolu_bg_read", agent_id: "fake-agent" } });
      await answer;
    }, 100);
  } else if (prompt === "background-net") {
    // A command left running in the background reaches for the network: the sandbox asks, naming no agent.
    say("Server started.");
    setTimeout(() => {
      const requestId = `req-${++counter}`;
      pending.set(requestId, (answer) => setTimeout(() => enqueue(() => selfStartedTurn(`Network access: ${answer.behavior}`)), 100));
      out({ type: "control_request", request_id: requestId, request: { subtype: "can_use_tool", tool_name: "SandboxNetworkAccess", display_name: "Network access", input: { host: "example.com" }, tool_use_id: `toolu_net_${counter}` } });
    }, 100);
  } else if ((match = prompt.match(/^background-chatty (\d+)$/))) {
    // Background work reports in a turn of its own that streams <n> pieces before its answer.
    say("Background work started.");
    setTimeout(() => enqueue(async () => {
      out({ type: "system", subtype: "task_notification", task_id: "fake-task", status: "completed", session_id: sessionId });
      out({ type: "system", subtype: "init", session_id: sessionId, mcp_servers: INIT_MCP, capabilities: CAPABILITIES, tools: ["Bash"], permissionMode: "default", cwd: process.cwd(), model: "fake", user_message_uuids: [] });
      out({ type: "stream_event", event: { type: "message_start", message: { role: "assistant" } }, session_id: sessionId });
      out({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, session_id: sessionId });
      for (let i = 0; i < Number(match[1]); i++) out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "." } }, session_id: sessionId });
      out({ type: "stream_event", event: { type: "content_block_stop", index: 0 }, session_id: sessionId });
      out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `${Number(match[1])} pieces` }] }, session_id: sessionId });
      out({ type: "stream_event", event: { type: "message_stop" }, session_id: sessionId });
      result(1);
    }), 50);
  } else if (prompt === "ask-then-quiet") {
    // A subagent asks during the turn; the main thread answers and goes quiet with the question still open. All of it
    // arrives together, so nothing can be judged between the question and the result.
    batch = [];
    void subagentAsks({ command: "echo background" }).then((answer) => setTimeout(() => enqueue(() => selfStartedTurn(`Background agent finished: ${answer.behavior}`)), 100));
    say("Launched.");
    current = null;
    result(turns, uuid);
    flush();
    return;
  } else if (prompt === "foreground-agent-asks") {
    // The turn runs a subagent in the foreground, which asks; the main thread waits for it.
    batch = [];
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_fg", name: "Agent", input: { description: "Check it" } }] }, session_id: sessionId });
    taskStarted("fake-fg", "toolu_fg");
    const answer = subagentAsks({ command: "echo foreground" }, { call: "toolu_fg", agent: "fake-fg", toolUseId: "toolu_fg_bash" });
    flush();
    const decision = await answer;
    if (state.interrupted) return;
    taskDone("fake-fg", "toolu_fg");
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_fg", content: decision.behavior }] }, session_id: sessionId });
    say(`Subagent: ${decision.behavior}`);
  } else if (prompt === "nested-agent-asks") {
    // A foreground subagent runs one of its own, which asks before its call is forwarded; the main thread waits for it.
    batch = [];
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_fg", name: "Agent", input: { description: "Check it" } }] }, session_id: sessionId });
    taskStarted("fake-outer", "toolu_fg");
    out({ type: "assistant", parent_tool_use_id: "toolu_fg", agent_id: "fake-outer", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_inner", name: "Agent", input: { description: "Deeper" } }] }, session_id: sessionId });
    taskStarted("fake-inner", "toolu_inner");
    const answer = subagentAsks({ command: "echo nested" }, { call: "toolu_inner", agent: "fake-inner", toolUseId: "toolu_deep", forwarded: false });
    flush();
    const decision = await answer;
    if (state.interrupted) return;
    taskDone("fake-inner", "toolu_inner");
    taskDone("fake-outer", "toolu_fg");
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_fg", content: decision.behavior }] }, session_id: sessionId });
    say(`Nested: ${decision.behavior}`);
  } else if (prompt === "fg-ask-twice") {
    // A foreground subagent asks to run a command; then the main thread, beside it, asks to run the same one.
    const n = turnsAnswered;
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: `toolu_fg_${n}`, name: "Agent", input: { description: "Check it" } }, { type: "tool_use", id: `toolu_main_${n}`, name: "Bash", input: { command: "echo again" } }] }, session_id: sessionId });
    taskStarted(`fake-fg-${n}`, `toolu_fg_${n}`);
    const first = await subagentAsks({ command: "echo again" }, { call: `toolu_fg_${n}`, agent: `fake-fg-${n}`, toolUseId: `toolu_fg_a_${n}` });
    if (state.interrupted) return;
    const second = await ask("Bash", { command: "echo again" }, { toolUseId: `toolu_main_${n}` });
    if (state.interrupted) return;
    taskDone(`fake-fg-${n}`, `toolu_fg_${n}`);
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_fg_${n}`, content: "done" }, { type: "tool_result", tool_use_id: `toolu_main_${n}`, content: "again" }] }, session_id: sessionId });
    say(`Asked: ${first.behavior}, ${second.behavior}`);
  } else if (prompt === "launch-bg-agent") {
    // A background agent is launched and starts on its first command; it asks for its next one only later.
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_bg_old", name: "Agent", input: { description: "Build", run_in_background: true } }] }, session_id: sessionId });
    out({ type: "system", subtype: "task_started", task_id: "old-agent", tool_use_id: "toolu_bg_old", description: "Build", is_backgrounded: true, session_id: sessionId });
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_bg_old", content: "Async agent launched" }] }, session_id: sessionId });
    out({ type: "assistant", parent_tool_use_id: "toolu_bg_old", agent_id: "old-agent", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_old_1", name: "Bash", input: { command: "echo build" } }, { type: "tool_use", id: "toolu_old_2", name: "Bash", input: { command: "echo publish" } }] }, session_id: sessionId });
    say("Launched.");
  } else if (prompt === "fg-work-then-old-bg-asks") {
    // A foreground subagent works for a while; meanwhile the background agent launched in an earlier turn asks.
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_fg", name: "Agent", input: { description: "Work" } }] }, session_id: sessionId });
    taskStarted("fake-fg", "toolu_fg");
    void subagentAsks({ command: "echo publish" }, { call: "toolu_bg_old", agent: "old-agent", toolUseId: "toolu_old_2", forwarded: false });
    for (let waited = 0; waited < 4000 && !state.interrupted; waited += 50) await sleep(50);
    if (state.interrupted) return;
    taskDone("fake-fg", "toolu_fg");
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_fg", content: "worked" }] }, session_id: sessionId });
    say("Done.");
  } else if ((match = prompt.match(/^bg-ask-beside-fg-work( nested)?$/))) {
    // A foreground subagent works for a while without asking; meanwhile background work asks, or (nested) a subagent of
    // background work asks before its call is forwarded.
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_fg", name: "Agent", input: { description: "Work" } }] }, session_id: sessionId });
    taskStarted("fake-fg", "toolu_fg");
    if (match[1]) {
      out({ type: "assistant", parent_tool_use_id: "toolu_bg_agent", agent_id: "fake-agent", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_bg_inner", name: "Agent", input: { description: "deeper" } }] }, session_id: sessionId });
      taskStarted("bg-inner", "toolu_bg_inner");
      void subagentAsks({ command: "echo background" }, { call: "toolu_bg_inner", agent: "bg-inner", toolUseId: "toolu_bg_deep", forwarded: false });
    } else void subagentAsks({ command: "echo background" });
    for (let waited = 0; waited < 4000 && !state.interrupted; waited += 50) await sleep(50);
    if (state.interrupted) return;
    taskDone("fake-fg", "toolu_fg");
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_fg", content: "worked" }] }, session_id: sessionId });
    say("Done.");
  } else if (prompt === "fg-ask-beside-fg-work") {
    // Two foreground subagents: one asks, the other works on for a while without asking.
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_agent_one", name: "Agent", input: { description: "one" } }, { type: "tool_use", id: "toolu_agent_two", name: "Agent", input: { description: "two" } }] }, session_id: sessionId });
    taskStarted("fake-one", "toolu_agent_one");
    taskStarted("fake-two", "toolu_agent_two");
    const asked = subagentAsks({ command: "echo one" }, { call: "toolu_agent_one", agent: "fake-one", toolUseId: "toolu_one_bash" });
    for (let waited = 0; waited < 4000 && !state.interrupted; waited += 50) await sleep(50);
    if (state.interrupted) return;
    taskDone("fake-two", "toolu_agent_two");
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_agent_two", content: "worked" }] }, session_id: sessionId });
    const decision = await asked;
    if (state.interrupted) return;
    taskDone("fake-one", "toolu_agent_one");
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_agent_one", content: decision.behavior }] }, session_id: sessionId });
    say(`One: ${decision.behavior}`);
  } else if (prompt === "background-scopes") {
    // Background agent A asks; then a helper A runs of its own asks the same; then another background agent B does.
    say("Launched.");
    setTimeout(async () => {
      const first = await subagentAsks({ command: "echo same" }, { call: "toolu_bg_a", agent: "agent-a", toolUseId: "toolu_a_1" });
      out({ type: "assistant", parent_tool_use_id: "toolu_bg_a", agent_id: "agent-a", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_helper", name: "Agent", input: { description: "Help" } }] }, session_id: sessionId });
      out({ type: "system", subtype: "task_started", task_id: "helper-a", tool_use_id: "toolu_helper", description: "Help", is_backgrounded: false, session_id: sessionId });
      const helped = await subagentAsks({ command: "echo same" }, { call: "toolu_helper", agent: "helper-a", toolUseId: "toolu_h_1", forwarded: false });
      const other = await subagentAsks({ command: "echo same" }, { call: "toolu_bg_b", agent: "agent-b", toolUseId: "toolu_b_1" });
      setTimeout(() => enqueue(() => selfStartedTurn(`Agents finished: ${first.behavior}, ${helped.behavior}, ${other.behavior}`)), 100);
    }, 100);
  } else if (prompt === "two-tools-one-asks") {
    // Two commands in one step; the first asks and the second waits its turn behind it.
    batch = [];
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_a", name: "Bash", input: { command: "echo a" } }, { type: "tool_use", id: "toolu_b", name: "Bash", input: { command: "echo b" } }] }, session_id: sessionId });
    const first = ask("Bash", { command: "echo a" }, { toolUseId: "toolu_a" });
    flush();
    const decision = await first;
    if (state.interrupted) return;
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_a", content: decision.behavior }, { type: "tool_result", tool_use_id: "toolu_b", content: "skipped" }] }, session_id: sessionId });
    say(`First: ${decision.behavior}`);
  } else if (prompt === "ask-while-streaming") {
    // A command asks as soon as its call is complete, while the model is still streaming the rest of the response.
    out({ type: "stream_event", event: { type: "message_start", message: { role: "assistant" } }, session_id: sessionId });
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_s", name: "Bash", input: { command: "echo s" } }] }, session_id: sessionId });
    void ask("Bash", { command: "echo s" }, { toolUseId: "toolu_s" });
    out({ type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }, session_id: sessionId });
    for (let waited = 0; waited < 3000 && !state.interrupted; waited += 100) { out({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "." } }, session_id: sessionId }); await sleep(100); }
    if (state.interrupted) return;
  } else if (prompt === "tool-loop") {
    // Three model calls that only use tools (reads Jolo allows), then an answer.
    for (let call = 0; call < 3 && !state.interrupted; call++) {
      out({ type: "stream_event", event: { type: "message_start", message: { role: "assistant" } }, session_id: sessionId });
      out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: `toolu_r${call}`, name: "Read", input: { file_path: "notes.txt" } }] }, session_id: sessionId });
      await ask("Read", { file_path: "notes.txt" }, { toolUseId: `toolu_r${call}` });
      out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_r${call}`, content: "alpha" }] }, session_id: sessionId });
      out({ type: "stream_event", event: { type: "message_stop" }, session_id: sessionId });
    }
    if (!state.interrupted) say("Read it three times.");
  } else if (prompt === "ask-mid-call") {
    // One model call: background work asks while it thinks, and once answered the call's text begins.
    out({ type: "stream_event", event: { type: "message_start", message: { role: "assistant" } }, session_id: sessionId });
    await subagentAsks({ command: "echo background" });
    if (!state.interrupted) say("One call.");
  } else if (prompt === "lost-tool") {
    // A call the binary drops (a fallback after a failed stream) never reports; the next model call goes on for a while.
    out({ type: "stream_event", event: { type: "message_start", message: { role: "assistant" } }, session_id: sessionId });
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_lost", name: "Read", input: { file_path: "notes.txt" } }] }, session_id: sessionId });
    out({ type: "stream_event", event: { type: "message_start", message: { role: "assistant" } }, session_id: sessionId });
    out({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, session_id: sessionId });
    for (let waited = 0; waited < 2500 && !state.interrupted; waited += 100) { out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "." } }, session_id: sessionId }); await sleep(100); }
    if (state.interrupted) return;
    out({ type: "stream_event", event: { type: "content_block_stop", index: 0 }, session_id: sessionId });
    out({ type: "stream_event", event: { type: "message_stop" }, session_id: sessionId });
  } else if (prompt === "background-multicall") {
    // Background work reports in a turn of its own that makes three model calls, all said at once.
    say("Background work started.");
    setTimeout(() => enqueue(async () => {
      batch = [];
      out({ type: "system", subtype: "task_notification", task_id: "fake-task", status: "completed", session_id: sessionId });
      out({ type: "system", subtype: "init", session_id: sessionId, mcp_servers: INIT_MCP, capabilities: CAPABILITIES, tools: ["Read"], permissionMode: "default", cwd: process.cwd(), model: "fake", user_message_uuids: [] });
      for (let call = 0; call < 3; call++) {
        out({ type: "stream_event", event: { type: "message_start", message: { role: "assistant" } }, session_id: sessionId });
        out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: `toolu_m${call}`, name: "Read", input: { file_path: "notes.txt" } }] }, session_id: sessionId });
        out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_m${call}`, content: "alpha" }] }, session_id: sessionId });
        out({ type: "stream_event", event: { type: "message_stop" }, session_id: sessionId });
      }
      out({ type: "stream_event", event: { type: "message_start", message: { role: "assistant" } }, session_id: sessionId });
      out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Read it three times." }] }, session_id: sessionId });
      out({ type: "stream_event", event: { type: "message_stop" }, session_id: sessionId });
      result(4);
      flush();
    }), 50);
  } else if (prompt === "background-asks-twice") {
    // Background work asks for the same command twice, a while apart, each time with the main thread idle.
    say("Background agent started.");
    setTimeout(async () => {
      const first = await subagentAsks({ command: "echo again" });
      await sleep(400);
      const second = await subagentAsks({ command: "echo again" });
      setTimeout(() => enqueue(() => selfStartedTurn(`Background agent finished: ${first.behavior}, ${second.behavior}`)), 100);
    }, 100);
  } else if (prompt === "ask-then-main-turn-asks") {
    // Background work asks and the turn ends with that open; then the process begins a turn whose own command asks.
    batch = [];
    void subagentAsks({ command: "echo background" });
    say("Launched.");
    current = null;
    result(turns, uuid);
    flush();
    setTimeout(() => enqueue(async () => {
      const self = { interrupted: false, child: null };
      current = self;
      out({ type: "system", subtype: "init", session_id: sessionId, mcp_servers: INIT_MCP, capabilities: CAPABILITIES, tools: ["Bash"], permissionMode: "default", cwd: process.cwd(), model: "fake", user_message_uuids: [] });
      out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_own", name: "Bash", input: { command: "echo own" } }] }, session_id: sessionId });
      const decision = await ask("Bash", { command: "echo own" }, { toolUseId: "toolu_own" });
      if (self.interrupted) return;
      current = null;
      say(`Own: ${decision.behavior}`);
      result(1);
    }), 100);
    return;
  } else if (prompt === "main-then-background-asks") {
    // The main thread's own command asks; then background work asks too, while the first is open.
    // The model streams on until both are open, so nothing waits on the user before the background question is newest.
    batch = [];
    out({ type: "stream_event", event: { type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 0 } } }, session_id: sessionId });
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_main", name: "Bash", input: { command: "echo main" } }] }, session_id: sessionId });
    const mine = ask("Bash", { command: "echo main" }, { toolUseId: "toolu_main" });
    flush();
    await sleep(100);
    void subagentAsks({ command: "echo background" });
    await sleep(50);
    out({ type: "stream_event", event: { type: "message_stop" }, session_id: sessionId });
    const decision = await mine;
    if (!state.interrupted) say(`Main: ${decision.behavior}`);
  } else if (prompt === "two-main-asks") {
    // The main thread calls two tools that may run side by side, each asking first; the first is done quickly once allowed.
    batch = [];
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_one", name: "WebFetch", input: { url: "https://one.example" } }, { type: "tool_use", id: "toolu_two", name: "WebFetch", input: { url: "https://two.example" } }] }, session_id: sessionId });
    const first = ask("WebFetch", { url: "https://one.example" }, { toolUseId: "toolu_one" });
    const second = ask("WebFetch", { url: "https://two.example" }, { toolUseId: "toolu_two" });
    flush();
    const one = await first;
    if (state.interrupted) return;
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_one", content: "fetched one" }] }, session_id: sessionId });
    const two = await second;
    if (state.interrupted) return;
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_two", content: "fetched two" }] }, session_id: sessionId });
    say(`Fetched: ${one.behavior}, ${two.behavior}`);
  } else if (prompt === "work-then-bg-ask") {
    // The main thread runs a long command it may run without asking; meanwhile a background subagent asks.
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_long", name: "Read", input: { file_path: "notes.txt" } }] }, session_id: sessionId });
    await ask("Read", { file_path: "notes.txt" }, { toolUseId: "toolu_long" });
    void subagentAsks({ command: "echo background" });
    for (let waited = 0; waited < 4000 && !state.interrupted; waited += 50) await sleep(50);
    if (state.interrupted) return;
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_long", content: "alpha" }] }, session_id: sessionId });
    say("Done.");
  } else if (prompt === "ask-then-slow-turn") {
    // A subagent asks and the turn ends with the question open; then the process begins a turn of its own that thinks
    // for a long while before it says anything.
    batch = [];
    void subagentAsks({ command: "echo background" });
    say("Launched.");
    current = null;
    result(turns, uuid);
    flush();
    setTimeout(() => enqueue(async () => {
      out({ type: "system", subtype: "task_notification", task_id: "fake-task", status: "completed", session_id: sessionId });
      const self = { interrupted: false, child: null };
      current = self;
      out({ type: "system", subtype: "init", session_id: sessionId, mcp_servers: INIT_MCP, capabilities: CAPABILITIES, tools: ["Bash"], permissionMode: "default", cwd: process.cwd(), model: "fake", user_message_uuids: [] });
      out({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }, session_id: sessionId });
      for (let waited = 0; waited < 4000 && !self.interrupted; waited += 50) await sleep(50);
      if (self.interrupted) return;
      current = null;
      say("Thought it over.");
      result(1);
    }), 100);
    return;
  } else if (prompt === "ask-and-work") {
    // A subagent asks during the turn while the main thread goes on working for a long while.
    void subagentAsks({ command: "echo background" });
    out({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, session_id: sessionId });
    for (let waited = 0; waited < 5000 && !state.interrupted; waited += 100) {
      out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "." } }, session_id: sessionId });
      await sleep(100);
    }
    if (state.interrupted) return;
    out({ type: "stream_event", event: { type: "content_block_stop", index: 0 }, session_id: sessionId });
  } else if (prompt === "ask-then-main-asks") {
    // A subagent asks and waits; then the main thread asks too, and once allowed runs its command for a long while.
    void subagentAsks({ command: "echo background" });
    const decision = await ask("Bash", { command: "sleep 5" }, { toolUseId: "toolu_main" });
    for (let waited = 0; waited < 5000 && !state.interrupted && decision.behavior === "allow"; waited += 50) await sleep(50);
    if (!state.interrupted) say(`Main command: ${decision.behavior}`);
  } else if ((match = prompt.match(/^background-ask (\d+)$/))) {
    // Background work finishes and the process begins a turn of its own, in which the main thread asks permission.
    say("Background work started.");
    setTimeout(() => enqueue(async () => {
      out({ type: "system", subtype: "task_notification", task_id: "fake-task", status: "completed", session_id: sessionId });
      const self = { interrupted: false, child: null };
      current = self;
      out({ type: "system", subtype: "init", session_id: sessionId, mcp_servers: INIT_MCP, capabilities: CAPABILITIES, tools: ["Bash"], permissionMode: "default", cwd: process.cwd(), model: "fake", user_message_uuids: [] });
      const decision = await ask("Bash", { command: "echo later" });
      if (self.interrupted) return;
      say(`Background step: ${decision.behavior}`);
      current = null;
      result(1);
    }), Number(match[1]));
  } else if (prompt === "zero-result-then-self") {
    // The empty result is the whole turn, and background work reports back in a turn of its own a moment later.
    out({ type: "result", subtype: "success", is_error: false, result: "", session_id: sessionId, num_turns: 0, duration_ms: 1, stop_reason: null, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } });
    setTimeout(() => enqueue(() => selfStartedTurn("Background report.")), 100);
    current = null;
    return;
  } else if (prompt === "two-in-turn") {
    // The turn runs two subagents in the foreground; both ask together, and the turn waits for both.
    batch = [];
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_agent_one", name: "Agent", input: { description: "one" } }, { type: "tool_use", id: "toolu_agent_two", name: "Agent", input: { description: "two" } }] }, session_id: sessionId });
    taskStarted("fake-one", "toolu_agent_one");
    taskStarted("fake-two", "toolu_agent_two");
    const both = Promise.all([subagentAsks({ command: "echo one" }, { call: "toolu_agent_one", agent: "fake-one", toolUseId: "toolu_one_bash" }), subagentAsks({ command: "echo two" }, { call: "toolu_agent_two", agent: "fake-two", toolUseId: "toolu_two_bash" })]);
    flush();
    const answers = await both;
    if (state.interrupted) return;
    taskDone("fake-one", "toolu_agent_one");
    taskDone("fake-two", "toolu_agent_two");
    say(`Both answered: ${answers.map((answer) => answer.behavior).join(", ")}`);
  } else if (prompt === "ask-withdraw-in-turn") {
    // A subagent asks during the turn; the main thread goes on talking, then the subagent takes the question back.
    void subagentAsks({ command: "echo background" });
    const asked = lastQuestion;
    await sleep(300);
    say("Still working. ");
    await sleep(300);
    takeBack(asked);
    await sleep(200);
    say("Done.");
  } else if ((match = prompt.match(/^zero-result-compact (\d+) (.+)$/s))) {
    // An empty result, then a compaction that takes <ms> and says so only when it starts and ends, then the answer.
    out({ type: "result", subtype: "success", is_error: false, result: "", session_id: sessionId, num_turns: 0, duration_ms: 1, stop_reason: null, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } });
    out({ type: "system", subtype: "status", status: "compacting", session_id: sessionId });
    for (let waited = 0; waited < Number(match[1]) && !state.interrupted; waited += 50) await sleep(50);
    if (state.interrupted) return;
    out({ type: "system", subtype: "status", status: null, session_id: sessionId });
    out({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto" }, session_id: sessionId });
    say(`You said: ${match[2]}`);
  } else if (prompt === "compact-then-answer") {
    // Compacting before the model call, as the real binary does: a boundary, then what it kept replayed as plain
    // messages (a summary, an earlier answer), then the model streams the answer.
    out({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 160000 }, session_id: sessionId });
    out({ type: "user", isCompactSummary: true, message: { role: "user", content: "This session is being continued from a previous conversation that ran out of context." }, session_id: sessionId });
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "An earlier answer, kept through compaction." }] }, session_id: sessionId });
    say("The fresh answer.");
  } else if (prompt === "ask-on-stop") {
    state.lateQuestion = true;
    say("Working on it.");
    for (let waited = 0; waited < 10_000 && !state.interrupted; waited += 50) await sleep(50); // an interrupt ends it at once
    if (!state.interrupted) say("not stopped");
  } else if (prompt === "stop-race") {
    state.lateTool = true;
    say("Working on it.");
    for (let waited = 0; waited < 10_000 && !state.interrupted; waited += 50) await sleep(50); // an interrupt ends it at once
    if (!state.interrupted) say("not stopped");
  } else if ((match = prompt.match(/^slow (\d+) (.+)$/s))) {
    await sleep(Number(match[1]));
    if (!state.interrupted) say(match[2]);
  } else if (prompt === "exit-after-turn") {
    say("Leaving now.");
    result(turns);
    current = null;
    process.stdout.write('', () => process.exit(0));
    return;
  } else if (prompt.startsWith("fail")) {
    out({ type: "result", subtype: "error_during_execution", is_error: true, result: "scripted failure", ...(uuid ? { user_message_uuid: uuid } : {}), session_id: sessionId, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } });
    current = null;
    return;
  } else {
    say(continuing ? `Continuing session ${sessionId}: ${prompt}` : `You said: ${prompt}`);
  }
  if (state.interrupted) return; // the interrupt already ended this turn with a result
  current = null;
  result(turns, uuid);
}

/** The requests the host has answered, by request id. */
const answered = new Set();
let buffered = "";
const decoder = new TextDecoder();
for await (const chunk of Bun.stdin.stream()) {
  buffered += decoder.decode(chunk, { stream: true });
  let newline;
  while ((newline = buffered.indexOf("\n")) >= 0) {
    const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.type === "control_request" && message.request?.subtype === "initialize") { sparesBackground = message.request.perTaskStopAffordance === true && !NO_STOP_TASK; forwardsNested = message.request.forwardNestedSubagentToolCalls === true; }
    if (message.type === "control_request" && message.request?.subtype === "initialize") out({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: { commands: COMMANDS, models: MODELS } } });
    else if (message.type === "control_request" && message.request?.subtype === "get_usage") answerUsage(message.request_id);
    else if (message.type === "control_request" && message.request?.subtype === "interrupt") interrupt(message.request_id, message.request.cancel_queued === true, message.request.for_user_message_uuids ?? null);
    else if (message.type === "control_request" && message.request?.subtype === "stop_task") stopTask(message.request_id, message.request.task_id);
    else if (message.type === "control_request" && message.request?.subtype === "get_task_output") answerTaskOutput(message.request_id, message.request.task_id);
    else if (message.type === "control_request" && message.request?.subtype === "mcp_status") out({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: { mcpServers: MCP_SERVERS } } });
    else if (message.type === "control_request" && message.request?.subtype === "cancel_async_message") {
      // Withdraw one queued message by its id; one already taken up is not withdrawn.
      const entry = waiting.find((candidate) => candidate.uuid === message.request.message_uuid && !candidate.cancelled);
      if (entry) entry.cancelled = true;
      if (entry) lifecycle(entry.uuid, "cancelled");
      out({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: { cancelled: Boolean(entry) } } });
    }
    else if (message.type === "control_response") {
      // Each request is answered once: a second answer is a host bug, and leaving makes the test that caused it fail.
      const requestId = message.response?.request_id;
      if (answered.has(requestId)) { process.stderr.write(`fake-claude: second control response for ${requestId}\n`); process.exit(70); }
      if (withdrawn.has(requestId)) { process.stderr.write(`fake-claude: control response for ${requestId}, which was taken back\n`); process.exit(70); }
      answered.add(requestId);
      const resolve = pending.get(requestId); if (resolve) { pending.delete(requestId); resolve(message.response.response); }
    }
    // The turn must run alongside this loop: it will block on a permission answer that only this loop can read.
    else if (message.type === "user") { const entry = { cancelled: false, uuid: message.uuid ?? null }; waiting.push(entry); lifecycle(entry.uuid, "queued"); enqueue(async () => { waiting.splice(waiting.indexOf(entry), 1); if (entry.cancelled) return; lifecycle(entry.uuid, "started"); await turn(typeof message.message?.content === "string" ? message.message.content : (message.message?.content ?? []).filter(part => part.type === "text").map(part => part.text).join(""), (Array.isArray(message.message?.content) ? message.message.content : []).filter(part => part.type === "image"), message.uuid ?? null).catch((error) => { process.stderr.write(`fake-claude: ${error?.stack ?? error}\n`); process.exit(70); }); lifecycle(entry.uuid, stoppedMessages.delete(entry.uuid) ? "cancelled" : "completed"); }); }
  }
}
// stdin closed: the host is done with this process. Large echoed attachments can fill the pipe; flush first.
process.stdout.write('', () => process.exit(0));
