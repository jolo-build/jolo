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
const offersBrowser = config => config?.args?.at(-1)?.split(',').includes('browser');
const valueOf = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] ?? null : null);
const chosenModel = valueOf("--model");
const chosenEffort = valueOf("--effort");
const MODELS = [
  { value: "default", resolvedModel: "fake-default", displayName: "Default (recommended)", description: "the everyday choice", supportsEffort: true, supportedEffortLevels: ["low", "high"] },
  { value: "fable", resolvedModel: "fake-fable-5-1", displayName: "Fable", description: "the capable one", supportsEffort: true, supportedEffortLevels: ["low", "high", "xhigh", "max"] },
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
const sessionId = resumed ?? `fake-${Math.random().toString(36).slice(2, 10)}`;
const out = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const pending = new Map();
let counter = 0;
const ask = (toolName, input, extra = {}) => new Promise((resolve) => {
  const requestId = `req-${++counter}`;
  pending.set(requestId, resolve);
  out({ type: "control_request", request_id: requestId, request: { subtype: "can_use_tool", tool_name: toolName, display_name: toolName, input, description: extra.description ?? toolName, permission_suggestions: [], tool_use_id: extra.toolUseId } });
});

async function turn(prompt, images = [], requestUuid = null) {
  const received = prompt;
  prompt = prompt.split("\n\nCurrent request:\n").at(-1);
  out({ type: "system", subtype: "init", session_id: sessionId, tools: ["Bash", "Read", "Write"], permissionMode: "default", cwd: process.cwd(), model: "fake" });
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
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: result.content, is_error: Boolean(result.isError) }] }, tool_use_result: result.fileResult, session_id: sessionId });
    return { denied: false, content: result.content };
  };
  let turns = 1;
  let match;
  if (prompt === 'mention-background') {
    const result = (text, uuid, turns = 1) => out({ type: 'result', subtype: 'success', is_error: false, result: text, user_message_uuid: uuid, session_id: sessionId, num_turns: turns, usage: { input_tokens: turns * 10, output_tokens: turns * 7 } });
    // A resumed Claude session flushes old task results before the new request.
    result('', 'old-notification', 0);
    result('Old task completed.', 'old-request');
    await Bun.sleep(100);
    out({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'reviewer', task_type: 'local_agent', description: 'Review' }] });
    out({ type: 'system', subtype: 'task_started', task_id: 'reviewer' });
    say('Review in progress.');
    result('Review in progress.', requestUuid);
    // Wait beyond the host transport's two-second termination grace period.
    await Bun.sleep(2300);
    out({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
    out({ type: 'system', subtype: 'task_notification', task_id: 'reviewer', status: 'completed' });
    // Empty coalesced notification results must not cut off the final synthesis.
    result('', 'notification', 0);
    await Bun.sleep(100);
    say('Final review: the requested design is consistent.');
    result('Final review: the requested design is consistent.', 'notification-final');
    return;
  }
  if (prompt === 'result-only'  || prompt === 'empty-result') {
    out({ type: 'result', subtype: 'success', is_error: false, result: prompt === 'result-only' ? 'Final review delivered only in the result.' : '', session_id: sessionId, num_turns: 1, usage: { input_tokens: 10, output_tokens: 7 } });
    return;
  }
  if (prompt === 'subagent-review') {
    const parentId = 'toolu_reviewer';
    const child = message => out({ ...message, parent_tool_use_id: parentId, session_id: sessionId });
    const event = value => out({ type: 'stream_event', event: value, parent_tool_use_id: null, session_id: sessionId });
    const report = '[{"file":"app.js","line":10,"summary":"INTERNAL_REVIEW","failure_scenario":"internal details"}]';
    out({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'tool_use', id: parentId, name: 'Agent', input: { prompt: 'Review the code' } }] }, session_id: sessionId });
    // Two overlapping streams use the same block index. A child stop must not clear the parent's block.
    event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'I found one issue. ' } });
    child({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
    child({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: report } } });
    child({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
    child({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: report }, { type: 'tool_use', id: 'child-bash', name: 'Bash', input: { command: 'echo child-review' } }] } });
    // Child permissions still go through the host policy even though their transcript stays internal.
    const decision = await new Promise(resolve => {
      pending.set('child-permission', resolve);
      child({ type: 'control_request', request_id: 'child-permission', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'echo child-review' }, tool_use_id: 'child-bash' } });
    });
    child({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'child-bash', content: decision.behavior }] } });
    child({ type: 'stream_event', event: { type: 'message_stop' } });
    child({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'SECOND_INTERNAL_REVIEW' }] } });
    out({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: parentId, content: report }] }, session_id: sessionId });
    event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Validate the interval before saving.' } });
    event({ type: 'content_block_stop', index: 0 });
    out({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'I found one issue. Validate the interval before saving.' }] }, session_id: sessionId });
    event({ type: 'message_stop' });
  } else if (prompt === 'browser-discovery') {
    say(offersBrowser(JSON.parse(valueOf('--mcp-config') ?? '{}').mcpServers?.jolo) ? 'Browser tools available' : 'Browser tools unavailable');
  } else if (prompt === 'browser-check') {
    if (!valueOf('--append-system-prompt')?.includes('dedicated browser tools')) throw new Error('Jolo browser instructions missing');
    const config = JSON.parse(valueOf('--mcp-config') ?? '{}').mcpServers?.jolo;
    if (!offersBrowser(config)) say('Browser tools unavailable');
    else {
      const { browserMcpCheck } = await import('./browser-mcp-client.js');
      const result = await tool('mcp__jolo__browser_screenshot', {}, async () => ({ content: await browserMcpCheck(config) }));
      say(result.denied ? result.message : result.content);
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
  } else if ((match = prompt.match(/^run (.+)$/s))) {
    turns = 2;
    const outcome = await tool("Bash", { command: match[1] }, async (input) => {
      const proc = Bun.spawnSync(["/bin/sh", "-c", input.command], { cwd: process.cwd() });
      return { content: proc.stdout.toString().trim() || proc.stderr.toString().trim(), isError: proc.exitCode !== 0 };
    });
    say(outcome.denied ? `I could not run it: ${outcome.message}` : `The command printed: ${outcome.content}`);
  } else if ((match = prompt.match(/^write (\S+) (.+)$/s))) {
    turns = 2;
    const outcome = await tool("Write", { file_path: match[1], content: match[2] }, async (input) => { const file = Bun.file(input.file_path); const originalFile = await file.exists() ? await file.text() : null; await Bun.write(input.file_path, input.content); return { content: `Wrote ${input.file_path}`, fileResult: { type: originalFile === null ? 'create' : 'update', originalFile } }; });
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
  out({ type: "result", subtype: "success", is_error: false, result: "done", session_id: sessionId, num_turns: turns, duration_ms: 5, stop_reason: "end_turn", total_cost_usd: 0.001, usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 20, output_tokens: 7 }, modelUsage: { fake: { contextWindow: 1_000_000, maxOutputTokens: 64_000 } } });
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
    else if (message.type === "control_request" && message.request?.subtype === "get_usage") answerUsage(message.request_id);
    else if (message.type === "control_response") { const resolve = pending.get(message.response?.request_id); if (resolve) { pending.delete(message.response.request_id); resolve(message.response.response); } }
    // The turn must run alongside this loop: it will block on a permission answer that only this loop can read.
    else if (message.type === "user") void turn(typeof message.message?.content === "string" ? message.message.content : (message.message?.content ?? []).filter(part => part.type === "text").map(part => part.text).join(""), (Array.isArray(message.message?.content) ? message.message.content : []).filter(part => part.type === "image"), message.uuid).then(() => {
      // Large echoed attachments can fill the pipe; flush the result before exiting.
      process.stdout.write('', () => process.exit(0));
    }, (error) => { process.stderr.write(`fake-claude: ${error?.stack ?? error}\n`); process.exit(70); });
  }
}
