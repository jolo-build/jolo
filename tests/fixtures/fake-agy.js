#!/usr/bin/env bun
// A stand-in for the Antigravity CLI (agy) that speaks its print-mode stream-json, so the adapter is tested end to
// end without the real CLI or its account. Shapes mirror what agy 1.3.5 sent in live sessions.
// `--output-format json models` lists models the way agy does, once per thinking level, and `--print=/usage` reports
// the plan's limits per model group (FAKE_AGY_USAGE=error refuses instead).
// Like agy, it runs the PreToolUse hooks found in .agents/hooks.json of every --add-dir directory before each tool
// call, gives them the call on stdin, and blocks the call when a hook denies it, fails, or prints nothing usable;
// a blocked call ends in an ERROR step and the turn carries on. A turn is scripted by the prompt text:
// "write <file> <text>" writes a file, "read <file>" reads one, "run <cmd>" runs a command (echo prints its words),
// "subagent <cmd>" has a subagent run the command, "model" reports the model and effort it was started with, "fail"
// ends in an error result, "hang" never answers, and anything else answers in prose.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const valueOf = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] ?? null : null);
const out = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

if (argv.at(-1) === "models") {
  if (valueOf("--output-format") !== "json") { process.stderr.write(`fake-agy: unexpected argv ${JSON.stringify(argv)}\n`); process.exit(64); }
  const models = [
    { id: "gemini-4-argon-medium", label: "Gemini 4 Argon (Medium)" },
    { id: "gemini-4-argon-high", label: "Gemini 4 Argon (High)" },
    { id: "gemini-4-argon-low", label: "Gemini 4 Argon (Low)" },
    { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)" },
    { id: "custom-model", label: "Custom Model" },
  ];
  out({ conversation_id: "", status: "SUCCESS", response: models.map((m) => `${m.id}\t${m.label}`).join("\n"), duration_seconds: 0, num_turns: 0, command: { name: "models", data: { models } } });
  process.exit(0);
}

if (argv.at(-1) === "--print=/usage") {
  if (valueOf("--output-format") !== "json") { process.stderr.write(`fake-agy: unexpected argv ${JSON.stringify(argv)}\n`); process.exit(64); }
  if (process.env.FAKE_AGY_USAGE === "error") { out({ conversation_id: "", status: "ERROR", response: "", error: "fake-agy: quota service unavailable" }); process.exit(1); }
  const bucket = (id, name, window, remaining_fraction, reset_time) => ({ id, name, window, remaining_fraction, reset_time });
  const groups = [
    { name: "Gemini Models", description: "Models within this group: Gemini Flash, Gemini Pro", buckets: [bucket("gemini-weekly", "Weekly Limit Remaining", "weekly", 0.9670023322105408, "2026-10-22T12:23:55Z"), bucket("gemini-5h", "Five Hour Limit Remaining", "5h", 0.8680092692375183, "2026-10-15T17:23:55Z")] },
    { name: "Claude and GPT models", description: "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS", buckets: [bucket("3p-weekly", "Weekly Limit Remaining", "weekly", 1, "2026-10-22T16:04:01Z"), bucket("3p-5h", "Five Hour Limit Remaining", "5h", 1, "2026-10-15T21:04:01Z")] },
  ];
  out({ conversation_id: "", status: "SUCCESS", response: "", duration_seconds: 0, num_turns: 0, command: { name: "usage", data: { description: "Within each group, models share a weekly limit and a 5-hour limit.", groups } } });
  process.exit(0);
}

const addedDirs = argv.flatMap((arg, i) => (arg === "--add-dir" ? [argv[i + 1]] : []));
// Jolo's gate replaces agy's own checks, which must be off; no permission mode of agy's may be asked for either.
if (valueOf("--input-format") !== "stream-json" || valueOf("--output-format") !== "stream-json" || argv.includes("--mode") || !argv.includes("--dangerously-skip-permissions") || addedDirs.length !== 2 || argv.at(-1) !== "--print=") {
  process.stderr.write(`fake-agy: unexpected argv ${JSON.stringify(argv)}\n`);
  process.exit(64);
}
const resumed = valueOf("--conversation");
const conversationId = resumed ?? `agy-${Math.random().toString(36).slice(2, 10)}`;
let stepIndex = resumed ? 4 : 0; // a resumed conversation keeps counting its steps
const step = (fields) => out({ event: "step_update", step_update: { conversation_id: conversationId, step_index: stepIndex, ...fields } });
const STEP_USAGE = { input_tokens: 40, output_tokens: 6, thinking_tokens: 2, cache_read_tokens: 100, total_tokens: 46 };
const say = (text) => {
  stepIndex += 1;
  const pieces = text.match(/.{1,12}/gsu) ?? [];
  for (const piece of pieces) step({ state: "ACTIVE", step_type: "agent_response", text_delta: piece });
  step({ state: "DONE", step_type: "agent_response", text_delta: "\n", duration_seconds: 0.1, usage: STEP_USAGE });
};
// The PreToolUse hooks of the added directories, each run from its own .agents directory as agy runs them.
const hooks = addedDirs.flatMap((dir) => {
  const file = path.join(dir, ".agents", "hooks.json");
  if (!existsSync(file)) return [];
  return Object.values(JSON.parse(readFileSync(file, "utf8"))).flatMap((spec) => (spec.PreToolUse ?? []).flatMap((group) => group.hooks.map((hook) => ({ ...hook, cwd: path.dirname(file) }))));
});
/** Ask every hook about one call: null when all allow it, otherwise why it is blocked. */
const blockedBy = async (name, args) => {
  for (const hook of hooks) {
    const child = Bun.spawn(["sh", "-c", hook.command], { cwd: hook.cwd, stdin: new Blob([JSON.stringify({ toolCall: { name, args }, stepIdx: stepIndex, conversationId, workspacePaths: [process.cwd(), ...addedDirs] })]), stdout: "pipe", stderr: "pipe" });
    const [code, text] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    if (code !== 0) return `JSON hook "jsonhook__jolo-permissions_PreToolUse_0_0" failed: command failed: exit status ${code}`;
    let reply;
    try { reply = JSON.parse(text); } catch { return "failed to unmarshal result from hook"; }
    if (reply.decision !== "allow") return `tool call denied by pre-tool hook: ${reply.reason ?? reply.decision}`;
  }
  return null;
};
/** One tool call: the model's step that asked for it, the hooks, then the tool, which `run` performs when allowed. */
const callTool = async (name, parameters, run, stepType = "tool") => {
  stepIndex += 1;
  step({ state: "DONE", step_type: "agent_response", duration_seconds: 0.1, usage: STEP_USAGE }); // the step that decided to call it
  stepIndex += 1;
  step({ state: "ACTIVE", step_type: "tool", tool_name: name, tool_info: { name, parameters } });
  const blocked = await blockedBy(name, parameters);
  if (blocked) {
    step({ state: "ERROR", step_type: stepType, tool_name: name, duration_seconds: 0.01, tool_info: { name, parameters, error: { type: "TOOL_ERROR", message: blocked } } });
    return { blocked };
  }
  const output = run();
  step({ state: "DONE", step_type: stepType, tool_name: name, duration_seconds: 0.01, tool_info: { name, parameters, output } });
  return { output };
};
const runCommand = (command) => callTool("run_command", { CommandLine: command, Cwd: process.cwd() }, () => (command.startsWith("echo ") ? command.slice(5) : ""));
// The result counts the whole conversation, so a resumed turn reports more than its own steps.
const result = (fields) => out({ event: "result", result: { conversation_id: conversationId, status: "SUCCESS", response: "", duration_seconds: 0.2, num_turns: resumed ? 2 : 1, usage: { input_tokens: 9_000, output_tokens: 900, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 9_900 }, ...fields } });

async function turn(received) {
  const prompt = received.split("\n\nCurrent request:\n").at(-1);
  out({ event: "init", init: { cwd: process.cwd(), permission_mode: "request-review", tools: ["run_command", "view_file", "write_to_file"] } });
  stepIndex += 1;
  step({ state: "DONE", step_type: "user_input" });
  if (prompt === "hang") return false;
  if (prompt === "fail") { result({ status: "ERROR", error: "scripted failure" }); return true; }
  if (prompt.startsWith("write ")) {
    const [, file, ...words] = prompt.split(" ");
    const { blocked } = await callTool("write_to_file", { TargetFile: file, CodeContent: words.join(" ") }, () => { writeFileSync(file, words.join(" ")); return ""; });
    say(blocked ? `I could not write ${file}: ${blocked}` : `Created ${file}.`);
  } else if (prompt.startsWith("read ")) {
    const file = prompt.slice(5);
    const { blocked, output } = await callTool("view_file", { AbsolutePath: file }, () => readFileSync(file, "utf8"));
    say(blocked ? `I could not read ${file}: ${blocked}` : `It says: ${output.trim()}`);
  } else if (prompt.startsWith("run ")) {
    const { blocked, output } = await runCommand(prompt.slice(4));
    say(blocked ? `I could not run it: ${blocked}` : `The command printed: ${output}`);
  } else if (prompt.startsWith("subagent ")) {
    // A subagent's call starts as a tool step and ends as a "subagent" step; its own tool calls meet the hooks too.
    const started = await callTool("invoke_subagent", { Subagents: [{ Prompt: `Run ${prompt.slice(9)}` }] }, () => "", "subagent");
    const { blocked, output } = started.blocked ? started : await runCommand(prompt.slice(9));
    say(blocked ? `The subagent could not run it: ${blocked}` : `The subagent's command printed: ${output}`);
  } else if (prompt === "model") {
    say(`Running ${valueOf("--model") ?? "the default model"} at ${valueOf("--effort") ?? "the default effort"} with ${addedDirs.join(" and ")} added.`);
  } else {
    say(resumed ? `Continuing conversation ${conversationId}: ${prompt}` : `You said: ${prompt}`);
  }
  result({});
  return true;
}

// agy reads one message per line and answers each; with its input closed it leaves.
let buffered = "";
const decoder = new TextDecoder();
for await (const chunk of Bun.stdin.stream()) {
  buffered += decoder.decode(chunk, { stream: true });
  let newline;
  while ((newline = buffered.indexOf("\n")) >= 0) {
    const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.event !== "user" || typeof message.message?.content !== "string") { process.stderr.write(`fake-agy: unexpected input ${line}\n`); process.exit(65); }
    await turn(message.message.content);
  }
}
