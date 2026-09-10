#!/usr/bin/env bun
// A stand-in for `codex app-server` that speaks its JSON-RPC protocol, so the adapter is tested end to end
// without the real CLI or its account. Shapes mirror what the real binary sent in live sessions (0.153.3).
// Behaviour is scripted by the prompt text: "run <cmd>" asks approval for a command, "patch <file> <text>"
// asks approval for a file change, "fail" ends the turn in an error, "model" reports the model and effort the
// thread and turn were started with, and anything else answers in prose, after a short reasoning summary.
const argv = process.argv.slice(2);
if (argv.at(-1) !== "app-server") {
  process.stderr.write(`fake-codex: unexpected argv ${JSON.stringify(argv)}\n`);
  process.exit(64);
}
const out = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method, params) => out({ method, params, emittedAtMs: Date.now() });
const pending = new Map();
let counter = 0;
let initialized = false;
let ready = false;
const threads = new Map();
let current = null;
const ask = (method, params) => new Promise((resolve) => { const id = counter++; pending.set(id, resolve); out({ method, id, params }); });
const MODELS = [
  { id: "fake-large", displayName: "Fake Large", description: "the capable one", isDefault: true, hidden: false, supportedReasoningEfforts: [{ reasoningEffort: "low", description: "quick" }, { reasoningEffort: "high", description: "thorough" }], defaultReasoningEffort: "low" },
  { id: "fake-small", displayName: "Fake Small", description: "the quick one", isDefault: false, hidden: false, supportedReasoningEfforts: [{ reasoningEffort: "low", description: "quick" }], defaultReasoningEffort: "low" },
  { id: "fake-hidden", displayName: "Hidden", description: "not offered", isDefault: false, hidden: true, supportedReasoningEfforts: [] },
];
const usage = (input, output) => ({ totalTokens: input + output, inputTokens: input, cachedInputTokens: Math.floor(input / 2), cacheWriteInputTokens: 0, outputTokens: output, reasoningOutputTokens: 0 });

const makeThread = (cwd, id = `fake-thread-${Math.random().toString(36).slice(2, 10)}`, resumed = false, model = null) => {
  const thread = { id, sessionId: id, cwd, ephemeral: false, preview: "", modelProvider: "fake", model: "fake", cliVersion: "0.0.0-fake", createdAt: Date.now(), updatedAt: Date.now(), projectId: null, turns: [], status: { type: "idle" }, source: "fake" };
  threads.set(id, { thread, cwd, resumed, model });
  return thread;
};

async function runTurn(entry, turn, prompt, resumed, images = []) {
  const received = prompt;
  prompt = prompt.split("\n\nCurrent request:\n").at(-1);
  const effort = turn.effort ?? null;
  const { thread, cwd } = entry;
  const threadId = thread.id;
  const turnId = turn.id;
  const item = (type, fields) => ({ type, id: `${type}-${++counter}`, ...fields });
  const started = (value) => notify("item/started", { item: value, threadId, turnId, startedAtMs: Date.now() });
  const completed = (value) => notify("item/completed", { item: value, threadId, turnId, completedAtMs: Date.now() });
  // Real Codex reports a running total for the thread and the last request separately; they diverge as soon
  // as a thread has more than one request, so the fixture keeps them apart on purpose.
  const tokens = (input, output) => {
    thread.spent = { input: (thread.spent?.input ?? 0) + input, output: (thread.spent?.output ?? 0) + output };
    notify("thread/tokenUsage/updated", { threadId, turnId, tokenUsage: { total: usage(thread.spent.input, thread.spent.output), last: usage(input, output), modelContextWindow: 100_000 } });
  };
  const say = (text, phase = "final_answer") => {
    const message = item("agentMessage", { text: "", phase, memoryCitation: null, delivery: null, questions: null });
    started(message);
    for (const piece of text.match(/.{1,12}/gs) ?? []) notify("item/agentMessage/delta", { threadId, turnId, itemId: message.id, delta: piece });
    completed({ ...message, text });
    turn.items.push({ ...message, text });
  };
  const think = (text) => {
    const reasoning = item("reasoning", { summary: [], content: [] });
    started(reasoning);
    notify("item/reasoning/summaryPartAdded", { threadId, turnId, itemId: reasoning.id, summaryIndex: 0 });
    for (const piece of text.match(/.{1,10}/gs) ?? []) notify("item/reasoning/summaryTextDelta", { threadId, turnId, itemId: reasoning.id, summaryIndex: 0, delta: piece });
    completed({ ...reasoning, summary: [text] });
  };
  const end = (status, error = null) => {
    if (current?.id === turnId) current = null;
    notify("turn/completed", { threadId, turn: { ...turn, status, error, completedAt: Date.now(), durationMs: 5 } });
  };
  if (prompt === 'image-check') {
    const sizes = await Promise.all(images.map(async image => (await Bun.file(image.path).arrayBuffer()).byteLength));
    say(`Images received: ${sizes.join(', ')}`);
    end('completed');
    return;
  }
  let match;
  if (prompt === 'browser-check') {
    if (!entry.developerInstructions?.includes('Do not use computer use')) throw new Error('Jolo browser instructions missing');
    const settings = Bun.TOML.parse(argv.flatMap((arg, index) => arg === '-c' ? [argv[index + 1]] : []).join('\n'));
    if (!settings.mcp_servers?.jolo_browser) { say('Browser tools unavailable'); end('completed'); return; }
    const { browserMcpCheck } = await import('./browser-mcp-client.js');
    const tool = item('mcpToolCall', { server: 'jolo_browser', tool: 'browser_screenshot', arguments: {}, status: 'inProgress' });
    started(tool);
    const approval = { threadId, turnId, serverName: 'jolo_browser', mode: 'form', _meta: { codex_approval_kind: 'mcp_tool_call' }, message: 'Allow browser_screenshot?', requestedSchema: { type: 'object', properties: {} } };
    for (const change of [{ serverName: 'external' }, { threadId: 'other' }, { turnId: 'other' }, { mode: 'url' }, { _meta: {} }, { requestedSchema: { type: 'object', properties: { secret: { type: 'string' } } } }]) {
      const denied = await ask('mcpServer/elicitation/request', { ...approval, ...change });
      if (denied?.action === 'accept') throw new Error('unrelated approval was accepted');
    }
    const accepted = await ask('mcpServer/elicitation/request', approval);
    if (accepted?.action !== 'accept' || Object.keys(accepted.content ?? {}).length || accepted._meta) throw new Error('Jolo browser approval did not reach its dispatcher');
    const text = await browserMcpCheck(settings.mcp_servers?.jolo_browser, result => completed({ ...tool, status: 'completed', result }));
    say(text);
  } else if ((match = prompt.match(/^tool-deadline (reasoning|commentary|foreground|poll)$/))) {
    const mode = match[1];
    const exec = item("commandExecution", { command: "fixture-dev-server", cwd, processId: "1", status: "inProgress" });
    started(exec);
    if (mode === "commentary") say("The server is ready; checking it now.", "commentary");
    else if (mode !== "foreground") think("Checking the running server.");
    // Longer than the test's one-second tool deadline, including monitor jitter.
    await Bun.sleep(1800);
    if (turn.interrupted) return;
    if (mode === "poll") {
      notify("item/commandExecution/terminalInteraction", { threadId, turnId, itemId: exec.id, processId: "1", stdin: "" });
      await Bun.sleep(1800);
      if (turn.interrupted) return;
    }
    notify("item/commandExecution/outputDelta", { threadId, turnId, itemId: exec.id, delta: "server output after yielding\n" });
    completed({ ...exec, status: "completed", exitCode: 0 });
    say("Checked the server.");
  } else if ((match = prompt.match(/^run (.+)$/s))) {
    const command = match[1];
    tokens(6, 3); // the request that decided to run a command, before the one that reports on its output
    const exec = item("commandExecution", { command: `/bin/sh -lc '${command}'`, cwd, processId: null, source: "agent", status: "inProgress", commandActions: [{ type: "unknown", command }], aggregatedOutput: null, exitCode: null, durationMs: null, pluginId: null, scriptPath: null });
    started(exec);
    const { decision } = await ask("item/commandExecution/requestApproval", { kind: "command", threadId, turnId, itemId: exec.id, startedAtMs: Date.now(), environmentId: "local", command: exec.command, cwd, commandActions: exec.commandActions, availableDecisions: ["accept", "decline", "cancel"] });
    if (decision === "cancel" || turn.interrupted) { completed({ ...exec, status: "declined" }); end("interrupted"); return; }
    if (decision !== "accept") {
      completed({ ...exec, status: "declined", exitCode: null });
      tokens(10, 7);
      say("I could not run it: command rejected by user");
      end("completed"); return;
    }
    const proc = Bun.spawnSync(["/bin/sh", "-c", command], { cwd });
    const output = proc.stdout.toString() || proc.stderr.toString();
    if (output) notify("item/commandExecution/outputDelta", { threadId, turnId, itemId: exec.id, delta: output });
    completed({ ...exec, status: proc.exitCode === 0 ? "completed" : "failed", exitCode: proc.exitCode, aggregatedOutput: output, durationMs: 1, processId: "1" });
    tokens(10, 7);
    say(`The command printed: ${output.trim()}`);
  } else if ((match = prompt.match(/^patch (\S+) (.+)$/s))) {
    const change = item("fileChange", { changes: [{ path: match[1], kind: { type: "add" }, diff: match[2] }], status: "inProgress" });
    started(change);
    const { decision } = await ask("item/fileChange/requestApproval", { threadId, turnId, itemId: change.id, startedAtMs: Date.now(), reason: null, grantRoot: null });
    if (decision === "accept") {
      await Bun.write(match[1], match[2]);
      completed({ ...change, status: "completed" });
      tokens(10, 7);
      say("Written.");
    } else {
      completed({ ...change, status: "declined" });
      tokens(10, 7);
      say("I could not write it: patch rejected by user");
    }
  } else if (prompt.startsWith("fail")) {
    notify("error", { threadId, turnId, error: { message: "scripted failure" }, willRetry: false });
    end("failed", { message: "scripted failure" }); return;
  } else if (prompt === "history") {
    say(`${resumed ? "Resumed" : "Fresh agent"} context: ${received}`);
  } else if (prompt.startsWith("model")) {
    tokens(15, 12);
    say(`Running ${entry.model ?? "the default model"} at ${effort ?? "the default effort"}.`);
  } else {
    think("Answering plainly.");
    tokens(15, 12);
    say(resumed ? `Continuing thread ${threadId}: ${prompt}` : `You said: ${prompt}`);
  }
  end("completed");
}

async function handle(message) {
  if (message.id !== undefined && message.method === undefined) {
    const resolve = pending.get(message.id);
    if (resolve) { pending.delete(message.id); resolve(message.result ?? { error: message.error }); }
    return;
  }
  const { id, method, params = {} } = message;
  const reply = (result) => out({ id, result });
  const fail = (code, text) => out({ id, error: { code, message: text } });
  if (method === "initialize") { initialized = true; reply({ userAgent: `${params.clientInfo?.name ?? "?"}/fake-codex`, codexHome: "/nowhere", platformFamily: "unix", platformOs: "test" }); return; }
  if (!initialized) return fail(-32002, "initialize first");
  if (method === "initialized") { ready = true; return; }
  if (!ready) return fail(-32002, "send initialized first");
  switch (method) {
    case "thread/start": {
      if (params.approvalPolicy !== "untrusted" || params.sandbox !== "workspace-write" || !params.cwd) return fail(-32602, `unexpected thread/start params ${JSON.stringify(params)}`);
      const thread = makeThread(params.cwd, undefined, false, params.model ?? null);
      threads.get(thread.id).developerInstructions = params.developerInstructions;
      reply({ thread, approvalPolicy: "untrusted", sandbox: { type: "workspaceWrite" }, cwd: params.cwd, model: "fake", modelProvider: "fake" });
      notify("thread/started", { thread });
      return;
    }
    case "thread/resume": {
      if (typeof params.threadId !== "string" || !params.threadId.startsWith("fake-thread-")) return fail(-32602, "unknown thread");
      if (params.approvalPolicy !== "untrusted" || params.sandbox !== "workspace-write") return fail(-32602, "unexpected thread/resume params");
      const thread = makeThread(params.cwd, params.threadId, true, params.model ?? null);
      threads.get(thread.id).developerInstructions = params.developerInstructions;
      reply({ thread, approvalPolicy: "untrusted", sandbox: { type: "workspaceWrite" }, cwd: params.cwd, model: "fake", modelProvider: "fake" });
      return;
    }
    case "turn/start": {
      const entry = threads.get(params.threadId);
      if (!entry) return fail(-32602, "unknown thread");
      if (current) return fail(-32002, "a turn is already running");
      const text = (params.input ?? []).map((part) => part?.text ?? "").join("");
      if (params.model) entry.model = params.model; // a turn may name a model of its own
      const turn = { id: `turn-${++counter}`, items: [], status: "inProgress", error: null, startedAt: Date.now(), completedAt: null, durationMs: null, interrupted: false, effort: params.effort ?? null };
      current = turn;
      reply({ turn: { ...turn, interrupted: undefined } });
      notify("turn/started", { threadId: entry.thread.id, turn: { ...turn, interrupted: undefined } });
      // The turn runs alongside this loop: it will block on an approval that only this loop can read.
      void runTurn(entry, turn, text, entry.resumed, (params.input ?? []).filter(part => part.type === "localImage")).catch((error) => { process.stderr.write(`fake-codex: ${error?.stack ?? error}\n`); process.exit(70); });
      return;
    }
    case "model/list": {
      const cursor = params.cursor ?? null;
      if (cursor === "page-2") return reply({ data: MODELS.slice(1), nextCursor: null });
      return reply({ data: MODELS.slice(0, 1), nextCursor: "page-2" }); // paginated, so the client has to follow it
    }
    case "turn/interrupt": {
      if (current && current.id === params.turnId) current.interrupted = true;
      reply({});
      return;
    }
    default: return fail(-32601, `fake-codex does not implement ${method}`);
  }
}

let buffered = "";
const decoder = new TextDecoder();
for await (const chunk of Bun.stdin.stream()) {
  buffered += decoder.decode(chunk, { stream: true });
  let newline;
  while ((newline = buffered.indexOf("\n")) >= 0) {
    const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
    if (!line.trim()) continue;
    await handle(JSON.parse(line));
  }
}
process.exit(0);
