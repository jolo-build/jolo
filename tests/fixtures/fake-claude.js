#!/usr/bin/env bun
// A stand-in for the Claude Code binary that speaks its stream-json host protocol, so the adapter is tested
// end to end without the real CLI or its API. Shapes mirror what the real binary sent in a live session.
// Behaviour is scripted by the prompt text: "run <cmd>" asks permission for a Bash call, "write <file>" for a
// Write, "read <file>" for a Read, "fail" ends in an error result, "model" reports the model and effort it was
// started with, and anything else just answers in prose.
const argv = process.argv.slice(2);
const flags = new Set(argv);
const resumed = argv.includes("--resume") ? argv[argv.indexOf("--resume") + 1] : null;
if (!flags.has("--print") || !flags.has("--output-format") || !argv.includes("stream-json") || !flags.has("--permission-prompt-tool") || argv[argv.indexOf("--permission-prompt-tool") + 1] !== "stdio") {
  process.stderr.write(`fake-claude: unexpected argv ${JSON.stringify(argv)}\n`);
  process.exit(64);
}
const valueOf = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] ?? null : null);
const chosenModel = valueOf("--model");
const chosenEffort = valueOf("--effort");
const MODELS = [
  { value: "default", resolvedModel: "fake-default", displayName: "Default (recommended)", description: "the everyday choice", supportsEffort: true, supportedEffortLevels: ["low", "high"] },
  { value: "fable", resolvedModel: "fake-fable-5-1", displayName: "Fable", description: "the capable one", supportsEffort: true, supportedEffortLevels: ["low", "high", "max"] },
  { value: "haiku", resolvedModel: "fake-haiku", displayName: "Haiku", description: "the quick one" },
];
const sessionId = resumed ?? `fake-${Math.random().toString(36).slice(2, 10)}`;
const out = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const pending = new Map();
let counter = 0;
const ask = (toolName, input, extra = {}) => new Promise((resolve) => {
  const requestId = `req-${++counter}`;
  pending.set(requestId, resolve);
  out({ type: "control_request", request_id: requestId, request: { subtype: "can_use_tool", tool_name: toolName, display_name: toolName, input, description: extra.description ?? toolName, permission_suggestions: [], tool_use_id: extra.toolUseId } });
});

async function turn(prompt, images = []) {
  const received = prompt;
  prompt = prompt.split("\n\nCurrent request:\n").at(-1);
  out({ type: "system", subtype: "init", session_id: sessionId, tools: ["Bash", "Read", "Write"], permissionMode: "default", cwd: process.cwd(), model: "fake" });
  const say = (text) => {
    out({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, session_id: sessionId });
    for (const piece of text.match(/.{1,12}/gs) ?? []) out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } }, session_id: sessionId });
    out({ type: "stream_event", event: { type: "content_block_stop", index: 0 }, session_id: sessionId });
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] }, session_id: sessionId });
    out({ type: "stream_event", event: { type: "message_stop" }, session_id: sessionId });
  };
  const tool = async (name, input, produce) => {
    const toolUseId = `toolu_${++counter}`;
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: toolUseId, name, input }] }, session_id: sessionId });
    const decision = await ask(name, input, { toolUseId });
    if (decision.behavior !== "allow") {
      out({ type: "system", subtype: "permission_denied", tool_name: name, tool_use_id: toolUseId, message: decision.message, session_id: sessionId });
      out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: decision.message, is_error: true }] }, session_id: sessionId });
      return { denied: true, message: decision.message };
    }
    const result = await produce(decision.updatedInput ?? input);
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: result.content, is_error: Boolean(result.isError) }] }, session_id: sessionId });
    return { denied: false, content: result.content };
  };
  let turns = 1;
  let match;
  if (prompt === 'image-check') {
    say(`Images received: ${images.map(image => `${image.source.media_type}:${Buffer.from(image.source.data, 'base64').length}`).join(', ')}`);
  } else if ((match = prompt.match(/^run (.+)$/s))) {
    turns = 2;
    const outcome = await tool("Bash", { command: match[1] }, async (input) => {
      const proc = Bun.spawnSync(["/bin/sh", "-c", input.command], { cwd: process.cwd() });
      return { content: proc.stdout.toString().trim() || proc.stderr.toString().trim(), isError: proc.exitCode !== 0 };
    });
    say(outcome.denied ? `I could not run it: ${outcome.message}` : `The command printed: ${outcome.content}`);
  } else if ((match = prompt.match(/^write (\S+) (.+)$/s))) {
    turns = 2;
    const outcome = await tool("Write", { file_path: match[1], content: match[2] }, async (input) => { await Bun.write(input.file_path, input.content); return { content: `Wrote ${input.file_path}` }; });
    say(outcome.denied ? `I could not write it: ${outcome.message}` : "Written.");
  } else if ((match = prompt.match(/^read (\S+)$/))) {
    turns = 2;
    const outcome = await tool("Read", { file_path: match[1] }, async (input) => ({ content: await Bun.file(input.file_path).text() }));
    say(outcome.denied ? `I could not read it: ${outcome.message}` : `The file says: ${outcome.content.trim()}`);
  } else if (prompt === "history") {
    say(`${resumed ? "Resumed" : "Fresh agent"} context: ${received}`);
  } else if (prompt.startsWith("model")) {
    say(`Running ${chosenModel ?? "the default model"} at ${chosenEffort ?? "the default effort"}.`);
  } else if (prompt.startsWith("fail")) {
    out({ type: "result", subtype: "error_during_execution", is_error: true, result: "scripted failure", session_id: sessionId, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } });
    return;
  } else {
    say(resumed ? `Continuing session ${sessionId}: ${prompt}` : `You said: ${prompt}`);
  }
  out({ type: "result", subtype: "success", is_error: false, result: "done", session_id: sessionId, num_turns: turns, duration_ms: 5, stop_reason: "end_turn", total_cost_usd: 0.001, usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 20, output_tokens: 7 } });
}

let buffered = "";
const decoder = new TextDecoder();
for await (const chunk of Bun.stdin.stream()) {
  buffered += decoder.decode(chunk, { stream: true });
  let newline;
  while ((newline = buffered.indexOf("\n")) >= 0) {
    const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.type === "control_request" && message.request?.subtype === "initialize") out({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: { commands: [], models: MODELS } } });
    else if (message.type === "control_response") { const resolve = pending.get(message.response?.request_id); if (resolve) { pending.delete(message.response.request_id); resolve(message.response.response); } }
    // The turn must run alongside this loop: it will block on a permission answer that only this loop can read.
    else if (message.type === "user") void turn(typeof message.message?.content === "string" ? message.message.content : (message.message?.content ?? []).filter(part => part.type === "text").map(part => part.text).join(""), (Array.isArray(message.message?.content) ? message.message.content : []).filter(part => part.type === "image")).then(() => process.exit(0), (error) => { process.stderr.write(`fake-claude: ${error?.stack ?? error}\n`); process.exit(70); });
  }
}
