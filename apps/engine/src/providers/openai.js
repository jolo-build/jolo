// OpenAI Responses API adapter: streaming, function calls, stateless reasoning continuation (§7.1, §7.3).
// Provider-native items (reasoning, function_call) are preserved verbatim for the next request.
import { createSseParser } from "./sse.js";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const RESPONSE_MAX_BYTES = 8 * 1024 * 1024;

function toInput(items) {
  const input = [];
  for (const item of items) {
    switch (item.kind) {
      case "user_message": input.push({ role: "user", content: item.payload.images?.length
        ? [{ type: 'input_text', text: item.payload.text }, ...item.payload.images.map(image => ({ type: 'input_image', image_url: `data:${image.mimeType};base64,${image.data}`, detail: 'auto' }))]
        : item.payload.text }); break;
      case "assistant_message": input.push({ role: "assistant", content: item.payload.text }); break;
      case "system_note": input.push({ role: "developer", content: item.payload.text }); break;
      case "reasoning": input.push(item.payload.native); break;
      case "tool_call": input.push({ type: "function_call", call_id: item.payload.callId, name: item.payload.name, arguments: JSON.stringify(item.payload.arguments ?? {}), ...(item.payload.native?.id ? { id: item.payload.native.id } : {}) }); break;
      case "tool_result": input.push({ type: "function_call_output", call_id: item.payload.callId, output: item.payload.output }); break;
      default: break;
    }
  }
  return input;
}

function categorize(status) {
  if (status === 429) return { category: "rate_limit", retryable: true };
  if (status === 401 || status === 403) return { category: "auth", retryable: false };
  if (status === 400 || status === 404 || status === 422) return { category: "invalid_request", retryable: false };
  if (status >= 500) return { category: "provider", retryable: true };
  return { category: "provider", retryable: false };
}

/**
 * @param {{ apiKey: string, model: string, baseUrl?: string, contextWindowTokens: number, maxOutputTokens: number, reasoningEffort?: string, fetchImpl?: typeof fetch }} options
 */
export function createOpenAIProvider(options) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  return {
    name: "openai",
    capabilities() {
      return { contextWindowTokens: options.contextWindowTokens, maxOutputTokens: options.maxOutputTokens, supportsTools: true, supportsReasoning: true };
    },
    /** Build the exact request body (exposed for tests and diagnostics; never includes the key). */
    body(request) {
      const body = {
        model: options.model,
        instructions: request.instructions,
        input: toInput(request.items),
        tools: request.tools.map((tool) => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.parameters, strict: false })),
        stream: true,
        store: false,
        max_output_tokens: request.maxOutputTokens,
        include: ["reasoning.encrypted_content"],
      };
      const effort = request.reasoningEffort ?? options.reasoningEffort;
      if (effort && effort !== "none") body.reasoning = { effort, summary: "auto" };
      return body;
    },
    async *stream(request, signal) {
      let response;
      try {
        response = await fetchImpl(`${baseUrl}/responses`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` },
          body: JSON.stringify(this.body(request)),
          signal,
        });
      } catch (error) {
        yield { type: "error", category: signal.aborted ? "cancelled" : "network", retryable: !signal.aborted, message: String(error?.message ?? error) };
        return;
      }
      if (!response.ok) {
        const text = (await response.text().catch(() => "")).slice(0, 500);
        const { category, retryable } = categorize(response.status);
        yield { type: "error", category, retryable, message: `provider returned HTTP ${response.status}${text ? `: ${text}` : ""}`, status: response.status };
        return;
      }
      const events = [];
      const parser = createSseParser((event) => events.push(event));
      const functionCalls = new Map(); // item id -> { callId, name, arguments }
      const reader = response.body.getReader();
      let bytes = 0;
      let finished = false;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) { parser.end(); }
          else {
            bytes += value.length;
            if (bytes > RESPONSE_MAX_BYTES) { yield { type: "error", category: "limit", retryable: false, message: "provider response exceeded 8 MiB" }; return; }
            parser.push(value);
          }
          while (events.length) {
            const { event, data } = events.shift();
            const item = data?.item;
            switch (event) {
              case "response.output_item.added":
                if (item?.type === "function_call") functionCalls.set(item.id, { callId: item.call_id, name: item.name, arguments: "" });
                break;
              case "response.output_text.delta":
                yield { type: "text_delta", itemId: data.item_id, text: data.delta ?? "" };
                break;
              case "response.reasoning_summary_text.delta":
                yield { type: "reasoning_delta", itemId: data.item_id, blockId: `${data.item_id}:${data.summary_index ?? 0}`, kind: "summary", text: data.delta ?? "" };
                break;
              case "response.function_call_arguments.delta": {
                const call = functionCalls.get(data.item_id);
                if (call) { call.arguments += data.delta ?? ""; yield { type: "tool_call_delta", callId: call.callId, fragment: data.delta ?? "" }; }
                break;
              }
              case "response.function_call_arguments.done": {
                const call = functionCalls.get(data.item_id);
                if (call) { call.arguments = data.arguments ?? call.arguments; call.done = true; yield { type: "tool_call_complete", callId: call.callId, name: call.name, arguments: parseArguments(call.arguments) }; }
                break;
              }
              case "response.output_item.done":
                if (item?.type === "reasoning") {
                  yield { type: "reasoning_complete", itemId: item.id, blockId: `${item.id}:0`, status: item.encrypted_content ? "complete" : "unavailable" };
                  yield { type: "continuation_item", native: { type: "reasoning", id: item.id, summary: item.summary ?? [], ...(item.encrypted_content ? { encrypted_content: item.encrypted_content } : {}) } };
                } else if (item?.type === "function_call") {
                  const call = functionCalls.get(item.id);
                  if (call && !call.done) { call.done = true; yield { type: "tool_call_complete", callId: item.call_id, name: item.name, arguments: parseArguments(item.arguments ?? call.arguments) }; }
                  yield { type: "continuation_item", native: { type: "function_call", id: item.id, call_id: item.call_id, name: item.name } };
                }
                break;
              case "response.completed":
                if (data.response?.usage) yield { type: "usage", inputTokens: data.response.usage.input_tokens, outputTokens: data.response.usage.output_tokens };
                yield { type: "finished", reason: "completed" };
                finished = true;
                break;
              case "response.incomplete":
                if (data.response?.usage) yield { type: "usage", inputTokens: data.response.usage.input_tokens, outputTokens: data.response.usage.output_tokens };
                yield { type: "finished", reason: `incomplete:${data.response?.incomplete_details?.reason ?? "unknown"}` };
                finished = true;
                break;
              case "response.failed":
                yield { type: "error", category: "provider", retryable: false, message: data.response?.error?.message ?? "response failed" };
                finished = true;
                break;
              case "error":
                yield { type: "error", category: data?.code === "rate_limit_exceeded" ? "rate_limit" : "provider", retryable: data?.code === "rate_limit_exceeded", message: data?.message ?? "provider error" };
                finished = true;
                break;
              default:
                break;
            }
            if (finished) return;
          }
          if (done) break;
        }
      } catch (error) {
        yield { type: "error", category: signal.aborted ? "cancelled" : "network", retryable: !signal.aborted, message: String(error?.message ?? error) };
        return;
      } finally {
        reader.cancel().catch(() => {});
      }
      if (!finished) yield { type: "error", category: "network", retryable: true, message: "stream ended without a completion event" };
    },
  };
}

function parseArguments(raw) {
  if (typeof raw !== "string") return raw ?? {};
  try { return JSON.parse(raw); } catch { return { __invalid_json: raw.slice(0, 1000) }; }
}
