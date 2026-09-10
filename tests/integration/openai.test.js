import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { startEngine, tempHome, waitFor, removeHome } from "./helpers.js";

const engines = [];
const homes = [];
const servers = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
  for (const server of servers.splice(0)) server.stop(true);
  for (const dir of homes.splice(0)) removeHome(dir);
});

const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");

/** Minimal Responses API double: records requests, streams scripted SSE, can fail once. */
function mockOpenAI({ turns, failFirstWith = null }) {
  const requests = [];
  let failed = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/responses" || request.method !== "POST") return new Response("not found", { status: 404 });
      const body = await request.json();
      requests.push({ authorization: request.headers.get("authorization"), body });
      if (failFirstWith && !failed) { failed = true; return new Response(JSON.stringify({ error: { message: "slow down" } }), { status: failFirstWith }); }
      const turn = turns[Math.min(requests.length - 1 - (failed ? 1 : 0), turns.length - 1)];
      return new Response(sse(turn), { headers: { "content-type": "text/event-stream" } });
    },
  });
  servers.push(server);
  return { server, requests, baseUrl: `http://127.0.0.1:${server.port}` };
}

const usage = { input_tokens: 42, output_tokens: 7 };
const toolTurn = [
  { type: "response.created", response: { id: "resp_1" } },
  { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1", summary: [] } },
  { type: "response.reasoning_summary_text.delta", item_id: "rs_1", summary_index: 0, delta: "Listing files first." },
  { type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "Listing files first." }], encrypted_content: "ENCRYPTED-BLOB" } },
  { type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "list_files", arguments: "" } },
  { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 1, delta: "{\"path\":" },
  { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 1, delta: "\"src\"}" },
  { type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 1, arguments: "{\"path\":\"src\"}" },
  { type: "response.output_item.done", output_index: 1, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "list_files", arguments: "{\"path\":\"src\"}" } },
  { type: "response.completed", response: { id: "resp_1", status: "completed", usage } },
];
const answerTurn = [
  { type: "response.created", response: { id: "resp_2" } },
  { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant" } },
  { type: "response.output_text.delta", item_id: "msg_1", delta: "src has " },
  { type: "response.output_text.delta", item_id: "msg_1", delta: "one file.\n" },
  { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_1" } },
  { type: "response.completed", response: { id: "resp_2", status: "completed", usage } },
];

async function runWithMock({ home, mock, prompt = "what is in src?", image = null }) {
  const engine = await startEngine({ home, env: { OPENAI_API_KEY: "sk-test-secret", JOLO_CREDENTIALS: "session" } });
  engines.push(engine);
  const client = await engine.connect();
  await client.call("settings.update", { provider: { name: "openai", model: "test-model", baseUrl: mock.baseUrl, contextWindowTokens: 200_000, maxOutputTokens: 4_000, reasoningEffort: "low" } });
  const repo = path.join(home, "repo");
  mkdirSync(path.join(repo, "src"), { recursive: true });
  writeFileSync(path.join(repo, "src", "index.js"), "export default 1;\n");
  const project = await client.call("project.open", { path: repo });
  const { session, cursor } = await client.call("session.create", { projectId: project.projectId, workspaceId: project.workspaceId, title: "openai" });
  const events = [];
  await client.subscribe({ after: cursor, sessionId: session.id }, { onEvent: (e) => events.push(e) });
  const attachments = [];
  if (image) {
    const { artifactId } = await client.call('attachment.create', { sessionId: session.id, mimeType: 'image/png' });
    await client.call('attachment.write', { sessionId: session.id, artifactId, offset: 0, data: image.toString('base64'), final: true });
    attachments.push({ artifactId, name: 'Screenshot.png', mimeType: 'image/png', bytes: image.length });
  }
  const { run } = await client.call("run.start", { sessionId: session.id, requestId: "req_o", prompt, ...(attachments.length ? { attachments } : {}) });
  await waitFor(() => events.some((e) => e.type === "run.state" && ["completed", "failed"].includes(e.payload.state)), { label: "run finished", timeoutMs: 15_000 });
  const snapshot = await client.call("run.snapshot", { runId: run.id });
  return { client, events, run: snapshot.run, messages: snapshot.messages, read: async (m) => (await client.call("artifact.read", { artifactId: m.artifactId })).text };
}

describe("openai responses adapter against a local double", () => {
  test('sends uploaded images as vision inputs and preserves them across tool turns without putting base64 in events', async () => {
    const home = tempHome(); homes.push(home);
    const mock = mockOpenAI({ turns: [toolTurn, answerTurn] });
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
    const { run, events } = await runWithMock({ home, mock, image, prompt: 'Inspect this screenshot.' });
    expect(run.state).toBe('completed');
    expect(run.attachments).toHaveLength(1);
    for (const request of mock.requests) expect(request.body.input.find(item => item.role === 'user').content).toEqual([
      { type: 'input_text', text: 'Inspect this screenshot.' },
      { type: 'input_image', image_url: `data:image/png;base64,${image.toString('base64')}`, detail: 'auto' },
    ]);
    expect(JSON.stringify(events)).not.toContain(image.toString('base64'));
  });

  test("streams a function call, replays reasoning and results statelessly, and records usage", async () => {
    const home = tempHome(); homes.push(home);
    const mock = mockOpenAI({ turns: [toolTurn, answerTurn] });
    const { events, run, messages, read } = await runWithMock({ home, mock });
    expect(run.state).toBe("completed");
    expect(mock.requests).toHaveLength(2);
    const first = mock.requests[0];
    expect(first.authorization).toBe("Bearer sk-test-secret");
    expect(first.body.stream).toBe(true);
    expect(first.body.store).toBe(false);
    expect(first.body.model).toBe("test-model");
    expect(first.body.reasoning).toEqual({ effort: "low", summary: "auto" });
    expect(first.body.tools.map((t) => t.name)).toContain("read_file");
    expect(first.body.tools[0]).toMatchObject({ type: "function", strict: false });
    expect(first.body.input.at(-1)).toEqual({ role: "user", content: "what is in src?" });
    expect(first.body.instructions).toContain("Workspace root");

    const second = mock.requests[1].body.input;
    const reasoning = second.find((i) => i.type === "reasoning");
    expect(reasoning).toEqual({ type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "Listing files first." }], encrypted_content: "ENCRYPTED-BLOB" });
    const call = second.find((i) => i.type === "function_call");
    expect(call).toMatchObject({ call_id: "call_1", name: "list_files", arguments: JSON.stringify({ path: "src" }), id: "fc_1" });
    const output = second.find((i) => i.type === "function_call_output");
    expect(output.call_id).toBe("call_1");
    expect(JSON.parse(output.output)).toMatchObject({ ok: true, entries: [{ name: "index.js", type: "file" }] });
    expect(second.indexOf(reasoning)).toBeLessThan(second.indexOf(call));
    expect(second.indexOf(call)).toBeLessThan(second.indexOf(output));

    const assistant = messages.filter((m) => m.role === "assistant" && m.kind === "text");
    expect(await read(assistant.at(-1))).toBe("src has one file.\n");
    expect(await read(messages.find((m) => m.kind === "reasoning"))).toBe("Listing files first.");
    const usageEvent = events.filter((e) => e.type === "run.usage").at(-1).payload;
    expect(usageEvent).toMatchObject({ inputTokens: 84, outputTokens: 14, iterations: 2 });
    expect(JSON.stringify(events)).not.toContain("sk-test-secret");
  });

  test("retries once on HTTP 429 and never leaks the key into events or failures", async () => {
    const home = tempHome(); homes.push(home);
    const mock = mockOpenAI({ turns: [answerTurn], failFirstWith: 429 });
    const { events, run } = await runWithMock({ home, mock });
    expect(run.state).toBe("completed");
    expect(mock.requests).toHaveLength(2);
    const statuses = events.filter((e) => e.type === "provider.attempt").map((e) => e.payload.status);
    expect(statuses).toEqual(["started", "retrying", "started", "completed"]);
    expect(events.find((e) => e.type === "provider.attempt" && e.payload.status === "retrying").payload.reason).toContain("rate_limit");
  });

  test("an authentication failure fails the run without retry", async () => {
    const home = tempHome(); homes.push(home);
    const mock = mockOpenAI({ turns: [answerTurn], failFirstWith: 401 });
    const { run } = await runWithMock({ home, mock });
    expect(run.state).toBe("failed");
    expect(run.failure).toContain("auth");
    expect(mock.requests).toHaveLength(1);
  });
});
