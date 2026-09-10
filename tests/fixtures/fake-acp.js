#!/usr/bin/env bun
// A stand-in for an agent that speaks the Agent Client Protocol over stdio, so the ACP client is tested end
// to end without any vendor's CLI or account. Shapes follow schema/v1 and what Grok's `agent stdio` sent in
// live sessions. Behaviour is scripted by the prompt text: "run <cmd>" asks permission for a command,
// "write <file> <text>" asks permission for an edit and then writes through the client's file system,
// "twice <cmd>" asks for the same command twice, "always <cmd>" offers only a standing approval, "noisy <text>"
// floods stderr before replying, "read <file>" reads through it, "sneak <file> <text>" writes through it
// without asking, "fail" answers the
// prompt with an error, "sleep" waits to be cancelled, "model" reports the model in force,
// and anything else answers in prose after a thought. Sessions persist under $FAKE_ACP_STATE so a later
// process can session/load them.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
if (!argv.includes("--acp")) {
  process.stderr.write(`fake-acp: unexpected argv ${JSON.stringify(argv)}\n`);
  process.exit(64);
}
const stateDir = process.env.FAKE_ACP_STATE ?? null;
const valueOf = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] ?? null : null);
let chosenModel = valueOf("-m") ?? valueOf("--model");
const chosenEffort = valueOf("--reasoning-effort");
const MODEL_OPTIONS = [
  { value: "fake-fast", name: "Fake Fast", description: "the quick one" },
  { value: "fake-deep", name: "Fake Deep", description: "the thorough one" },
];
const configOptions = () => [
  { id: "model", name: "Model", category: "model", type: "select", value: chosenModel ?? "fake-fast", options: MODEL_OPTIONS },
  { id: "effort", name: "Reasoning effort", category: "thought_level", type: "select", currentValue: "low", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] },
];
const out = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const notify = (method, params) => out({ method, params });
const pending = new Map();
let counter = 0;
let client = null; // what the client said it can do
let cancelled = null; // resolver for a "sleep" prompt
const sessions = new Map();
const ask = (method, params) => new Promise((resolve) => { const id = ++counter; pending.set(id, resolve); out({ id, method, params }); });
const stateFile = (sessionId) => (stateDir ? path.join(stateDir, `${sessionId}.json`) : null);
const persist = (sessionId) => { const file = stateFile(sessionId); if (file) { mkdirSync(stateDir, { recursive: true }); writeFileSync(file, JSON.stringify(sessions.get(sessionId))); } };

async function prompt(id, params) {
  const sessionId = params.sessionId;
  const session = sessions.get(sessionId);
  if (!session) return out({ id, error: { code: -32602, message: "unknown session" } });
  const received = (params.prompt ?? []).map((block) => (block?.type === "text" ? block.text : `[${block?.type}]`)).join("");
  const text = received.split("\n\nCurrent request:\n").at(-1);
  const update = (value) => notify("session/update", { sessionId, update: value });
  const say = (reply) => { for (const piece of reply.match(/.{1,12}/gs) ?? []) update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: piece } }); };
  const finish = (reply, stopReason = "end_turn") => {
    if (reply) say(reply);
    session.history.push({ prompt: text, reply });
    persist(sessionId);
    update({ sessionUpdate: "usage_update", used: 100 * session.history.length, size: 100_000 });
    out({ id, result: { stopReason } });
  };
  const permission = async (toolCall, options) => {
    const answer = await ask("session/request_permission", { sessionId, toolCall, options });
    const outcome = answer?.outcome ?? {};
    if (outcome.outcome === "cancelled") return "cancelled";
    return options.find((option) => option.optionId === outcome.optionId)?.kind ?? "reject_once";
  };
  const tool = (fields) => { const toolCallId = `call-${++counter}`; update({ sessionUpdate: "tool_call", toolCallId, status: "pending", ...fields }); return toolCallId; };
  update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking about it." } });
  if (text.startsWith('image-check')) return finish(`Images received: ${(params.prompt ?? []).filter(part => part.type === 'image').map(image => `${image.mimeType}:${Buffer.from(image.data, 'base64').length}`).join(', ')}`);
  let match;
  if ((match = text.match(/^run (.+)$/s))) {
    const command = match[1];
    const toolCallId = tool({ title: `Execute \`${command}\``, kind: "execute", rawInput: { command } });
    const verdict = await permission({ toolCallId, title: `Execute \`${command}\``, kind: "execute", rawInput: { command } }, [
      { optionId: "allow", name: "Allow once", kind: "allow_once" }, { optionId: "allow-always", name: "Always allow", kind: "allow_always" }, { optionId: "reject", name: "Reject", kind: "reject_once" },
    ]);
    if (verdict === "cancelled") return finish(null, "cancelled");
    if (!verdict.startsWith("allow")) { update({ sessionUpdate: "tool_call_update", toolCallId, status: "failed", content: [{ type: "content", content: { type: "text", text: "rejected" } }] }); return finish("I could not run it: the command was rejected"); }
    update({ sessionUpdate: "tool_call_update", toolCallId, status: "in_progress" });
    const proc = Bun.spawnSync(["/bin/sh", "-c", command], { cwd: session.cwd });
    const output = (proc.stdout.toString() || proc.stderr.toString()).trim();
    update({ sessionUpdate: "tool_call_update", toolCallId, status: proc.exitCode === 0 ? "completed" : "failed", content: [{ type: "content", content: { type: "text", text: output } }], rawOutput: { exit_code: proc.exitCode } });
    return finish(`The command printed: ${output}`);
  }
  if ((match = text.match(/^twice (.+)$/s))) {
    // The same command asked for twice in one turn: a single-use approval must not cover the second ask.
    const command = match[1];
    const verdicts = [];
    for (const attempt of [1, 2]) {
      const toolCallId = tool({ title: `Execute \`${command}\``, kind: "execute", rawInput: { command } });
      const verdict = await permission({ toolCallId, title: `Execute \`${command}\``, kind: "execute", rawInput: { command } }, [
        { optionId: "allow", name: "Allow once", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" },
      ]);
      if (verdict === "cancelled") return finish(null, "cancelled");
      verdicts.push(`${attempt}:${verdict}`);
      update({ sessionUpdate: "tool_call_update", toolCallId, status: verdict.startsWith("allow") ? "completed" : "failed" });
    }
    return finish(`Asked twice and heard ${verdicts.join(" ")}`);
  }
  if ((match = text.match(/^always (.+)$/s))) {
    // An agent that offers no single-use approval; Jolo must not answer with a standing one.
    const command = match[1];
    const toolCallId = tool({ title: `Execute \`${command}\``, kind: "execute", rawInput: { command } });
    const verdict = await permission({ toolCallId, title: `Execute \`${command}\``, kind: "execute", rawInput: { command } }, [
      { optionId: "allow-always", name: "Always allow", kind: "allow_always" }, { optionId: "reject", name: "Reject", kind: "reject_once" },
    ]);
    if (verdict === "cancelled") return finish(null, "cancelled");
    update({ sessionUpdate: "tool_call_update", toolCallId, status: verdict.startsWith("allow") ? "completed" : "failed" });
    return finish(`The agent was told ${verdict}`);
  }
  if ((match = text.match(/^noisy (.+)$/s))) {
    // More diagnostics than a pipe holds, written before the reply: the client must be reading them already.
    process.stderr.write(`${"warning: something to say\n".repeat(6_000)}`);
    return finish(`Said a lot and still answered: ${match[1]}`);
  }
  if ((match = text.match(/^write (\S+) (.+)$/s))) {
    const [, file, content] = match;
    const toolCallId = tool({ title: `Write ${file}`, kind: "edit", locations: [{ path: file }], content: [{ type: "diff", path: file, oldText: null, newText: content }], rawInput: { path: file, content } });
    const verdict = await permission({ toolCallId, title: `Write ${file}`, kind: "edit", locations: [{ path: file }], rawInput: { path: file, content } }, [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }]);
    if (verdict === "cancelled") return finish(null, "cancelled");
    if (!verdict.startsWith("allow")) { update({ sessionUpdate: "tool_call_update", toolCallId, status: "failed" }); return finish("I could not write it: the edit was rejected"); }
    if (!client?.fs?.writeTextFile) { update({ sessionUpdate: "tool_call_update", toolCallId, status: "failed" }); return finish("I could not write it: the client offers no file system"); }
    const written = await ask("fs/write_text_file", { sessionId, path: file, content });
    if (written?.error) { update({ sessionUpdate: "tool_call_update", toolCallId, status: "failed", content: [{ type: "content", content: { type: "text", text: written.error.message } }] }); return finish(`I could not write it: ${written.error.message}`); }
    update({ sessionUpdate: "tool_call_update", toolCallId, status: "completed" });
    return finish("Written.");
  }
  if ((match = text.match(/^read (\S+)$/))) {
    const file = match[1];
    const toolCallId = tool({ title: `Read ${file}`, kind: "read", locations: [{ path: file }], rawInput: { path: file } });
    const verdict = await permission({ toolCallId, title: `Read ${file}`, kind: "read", locations: [{ path: file }], rawInput: { path: file } }, [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }]);
    if (verdict === "cancelled") return finish(null, "cancelled");
    if (!verdict.startsWith("allow")) { update({ sessionUpdate: "tool_call_update", toolCallId, status: "failed" }); return finish("I could not read it: the read was rejected"); }
    const read = await ask("fs/read_text_file", { sessionId, path: file });
    if (read?.error) { update({ sessionUpdate: "tool_call_update", toolCallId, status: "failed", content: [{ type: "content", content: { type: "text", text: read.error.message } }] }); return finish(`I could not read it: ${read.error.message}`); }
    update({ sessionUpdate: "tool_call_update", toolCallId, status: "completed", content: [{ type: "content", content: { type: "text", text: read.content } }] });
    return finish(`The file says: ${read.content.trim()}`);
  }
  if ((match = text.match(/^sneak (\S+) (.+)$/s))) { // an agent that writes without asking: only the client's file system stands in the way
    const [, file, content] = match;
    const toolCallId = tool({ title: `Write ${file}`, kind: "edit", locations: [{ path: file }], rawInput: { path: file, content } });
    const written = await ask("fs/write_text_file", { sessionId, path: file, content });
    if (written?.error) { update({ sessionUpdate: "tool_call_update", toolCallId, status: "failed" }); return finish(`I could not write it: ${written.error.message}`); }
    update({ sessionUpdate: "tool_call_update", toolCallId, status: "completed" });
    return finish("Written.");
  }
  if (text === "history") return finish(`${session.loaded ? "Resumed" : "Fresh agent"} context: ${received}`);
  if (text.startsWith("model")) return finish(`Running ${chosenModel ?? "the default model"} at ${chosenEffort ?? "the default effort"}.`);
  if (text.startsWith("fail")) return out({ id, error: { code: -32000, message: "scripted failure" } });
  if (text.startsWith("sleep")) {
    await new Promise((resolve) => { cancelled = resolve; });
    return finish(null, "cancelled");
  }
  finish(session.loaded ? `Continuing session ${sessionId}: ${text}` : `You said: ${text}`);
}

async function handle(message) {
  if (message.id !== undefined && message.method === undefined) {
    const resolve = pending.get(message.id);
    if (resolve) { pending.delete(message.id); resolve(message.error ? { error: message.error } : message.result); }
    return;
  }
  const { id, method, params = {} } = message;
  const reply = (result) => out({ id, result });
  const fail = (code, text) => out({ id, error: { code, message: text } });
  switch (method) {
    case "initialize":
      if (params.protocolVersion !== 1) return fail(-32602, "unsupported protocol version");
      client = params.clientCapabilities ?? {};
      return reply({ protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: process.env.FAKE_ACP_IMAGES === "1", audio: false, embeddedContext: false } }, authMethods: [], agentInfo: { name: "fake-acp", version: "0.0.0" } });
    case "session/new": {
      if (!client) return fail(-32002, "initialize first");
      const sessionId = `acp-${Math.random().toString(36).slice(2, 10)}`;
      sessions.set(sessionId, { cwd: params.cwd, history: [], loaded: false });
      persist(sessionId);
      return reply({ sessionId, configOptions: configOptions() });
    }
    case "session/load": {
      const file = stateFile(params.sessionId);
      if (!file || !existsSync(file)) return fail(-32602, "unknown session");
      const saved = JSON.parse(readFileSync(file, "utf8"));
      sessions.set(params.sessionId, { ...saved, cwd: params.cwd, loaded: true });
      // history comes back as replayed updates before the response
      for (const entry of saved.history) { // history comes back as replayed updates before the response
        notify("session/update", { sessionId: params.sessionId, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: entry.prompt } }, _meta: { isReplay: true } });
        if (entry.reply) notify("session/update", { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: entry.reply } }, _meta: { isReplay: true } });
      }
      return reply({ configOptions: configOptions() });
    }
    case "session/set_config_option": {
      if (params.configId !== "model") return fail(-32602, `unknown config option ${params.configId}`);
      if (!MODEL_OPTIONS.some((option) => option.value === params.value)) return fail(-32602, `unknown model ${params.value}`);
      chosenModel = params.value;
      return reply({ configOptions: configOptions() });
    }
    case "session/prompt":
      // The turn runs alongside this loop: it will block on a permission answer that only this loop can read.
      void prompt(id, params).catch((error) => { process.stderr.write(`fake-acp: ${error?.stack ?? error}\n`); process.exit(70); });
      return;
    case "session/cancel":
      if (cancelled) { cancelled(); cancelled = null; }
      return;
    default: return fail(-32601, `fake-acp does not implement ${method}`);
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
