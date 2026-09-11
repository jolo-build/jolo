// OpenAI Responses API adapter: streaming, function calls, stateless reasoning continuation (§7.1, §7.3).
// Provider-native items (reasoning, function_call) are preserved verbatim for the next request.
import { streamSse, incompleteStream, parseArguments, providerError } from './transport.js';
import { portableItems } from './transcript.js';

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

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

/**
 * The token limits are the resolved capabilities this adapter reports back, and the key belongs to
 * endpoints that authenticate, so an adapter can be built without either.
 * @param {{ apiKey?: string, model: string, baseUrl?: string, contextWindowTokens?: number, maxOutputTokens?: number, reasoningEffort?: string, fetchImpl?: import('./transport.js').FetchLike }} options
 */
export function createOpenAIProvider(options) {
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
        input: toInput(portableItems(request.items, { ...options, protocol: 'openai-responses' })),
        tools: request.tools.map((tool) => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.parameters, strict: false })),
        stream: true,
        store: false,
        max_output_tokens: request.maxOutputTokens,
        include: ["reasoning.encrypted_content"],
      };
      const effort = request.reasoningEffort ?? options.reasoningEffort;
      if (effort) body.reasoning = { effort, ...(effort !== 'none' ? { summary: 'auto' } : {}) };
      return body;
    },
    async *stream(request, signal) {
      const functionCalls = new Map();
      let finished = false;
      for await (const incoming of streamSse(options, `${baseUrl}/responses`, this.body(request), signal)) {
        if (incoming.error) { yield incoming.error; return; }
        const { event, data } = incoming;
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
              case "response.reasoning_text.delta":
                yield { type: 'reasoning_delta', itemId: data.item_id, blockId: `${data.item_id}:${data.content_index ?? 0}`, kind: 'thinking', text: data.delta ?? '' };
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
                  yield { type: "reasoning_complete", itemId: item.id, blockId: `${item.id}:0`, status: item.encrypted_content || item.content?.length || item.summary?.length ? "complete" : "unavailable" };
                  yield { type: "continuation_item", native: item };
                } else if (item?.type === "function_call") {
                  // A compatible endpoint may send the finished call without having announced it.
                  const call = functionCalls.get(item.id) ?? { callId: item.call_id, name: item.name, arguments: "" };
                  if (!call.done) { call.done = true; yield { type: "tool_call_complete", callId: item.call_id, name: item.name, arguments: parseArguments(item.arguments ?? call.arguments) }; }
                  yield { type: "continuation_item", native: { type: "function_call", id: item.id, call_id: item.call_id, name: item.name } };
                }
                break;
              case "response.completed":
                if (data.response?.usage) yield { type: "usage", inputTokens: data.response.usage.input_tokens, outputTokens: data.response.usage.output_tokens, cachedInputTokens: data.response.usage.input_tokens_details?.cached_tokens };
                yield { type: "finished", reason: "completed" };
                finished = true;
                break;
              case "response.incomplete":
                if (data.response?.usage) yield { type: "usage", inputTokens: data.response.usage.input_tokens, outputTokens: data.response.usage.output_tokens, cachedInputTokens: data.response.usage.input_tokens_details?.cached_tokens };
                yield { type: "finished", reason: `incomplete:${data.response?.incomplete_details?.reason ?? "unknown"}` };
                finished = true;
                break;
              case "response.failed":
                yield providerError(400, data.response?.error?.message ?? "response failed", options.apiKey);
                finished = true;
                break;
              case "error":
                yield providerError(data?.code === "rate_limit_exceeded" ? 429 : 400, data?.message ?? "provider error", options.apiKey);
                finished = true;
                break;
              default:
                break;
            }
        if (finished) return;
      }
      yield incompleteStream();
    },
  };
}
