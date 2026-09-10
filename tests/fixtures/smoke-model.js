// Local Responses API fixture for exercising production artifacts without paid API calls.
// This is a test server; it is never included in the application bundle.
export const SMOKE_MODEL_KEY = "sk-jolo-smoke-placeholder";
export function startSmokeModel() {
  const requests = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname !== "/responses" || request.method !== "POST") return new Response("not found", { status: 404 });
    if (request.headers.get("authorization") !== `Bearer ${SMOKE_MODEL_KEY}`) return new Response("unauthorized", { status: 401 });
    requests.push(await request.json());
    const events = [
      { type: "response.created", response: { id: "smoke-response" } },
      { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "smoke-message", role: "assistant" } },
      { type: "response.output_text.delta", item_id: "smoke-message", delta: "Jolo smoke model responded.\n" },
      { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "smoke-message" } },
      { type: "response.completed", response: { id: "smoke-response", status: "completed", usage: { input_tokens: 10, output_tokens: 6 } } },
    ];
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  } });
  return { baseUrl: `http://127.0.0.1:${server.port}`, requests, stop: () => server.stop(true) };
}
