import { streamSse, incompleteStream, parseArguments, providerError } from './transport.js';
import { itemGroups, nativeFor } from './transcript.js';
import { applyChatReasoning, chatReasoningFields, createChatReasoningCollector } from './chat-reasoning.js';

export function chatMessages(request, options = {}) {
  const messages = [{ role: 'system', content: request.instructions }];
  for (const group of itemGroups(request.items)) {
    let assistant = null;
    const reasoning = group.items.reduce((fields, item) => {
      const native = nativeFor(item, { ...options, protocol: 'openai-chat' });
      return Object.assign(fields, chatReasoningFields(native?.chat));
    }, {});
    for (const item of group.items) {
      const p = item.payload;
      if (item.kind === 'user_message') messages.push({ role: 'user', content: p.images?.length ? [{ type: 'text', text: p.text }, ...p.images.map(image => ({ type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.data}` } }))] : p.text });
      // Notes arrive mid-conversation; a second system message is rejected or misrendered by several chat
      // endpoints and templates, so they travel as user content, as they do for Messages and GenerateContent.
      else if (item.kind === 'system_note') messages.push({ role: 'user', content: p.text });
      else if (item.kind === 'assistant_message' || item.kind === 'tool_call' || (item.kind === 'reasoning' && Object.keys(reasoning).length)) {
        if (!assistant) {
          assistant = { role: 'assistant', content: null, ...(options.chatReasoning?.requireReasoningContent ? { reasoning_content: '' } : {}), ...reasoning };
          messages.push(assistant);
        }
        if (item.kind === 'assistant_message') assistant.content = (assistant.content ?? '') + p.text;
        else if (item.kind === 'tool_call') (assistant.tool_calls ??= []).push({ id: p.callId, type: 'function', function: { name: p.name, arguments: JSON.stringify(p.arguments ?? {}) } });
      } else if (item.kind === 'tool_result') messages.push({ role: 'tool', tool_call_id: p.callId, content: p.output });
    }
  }
  return messages;
}
export function createChatProvider(options) {
  return {
    name: 'openai-chat',
    capabilities: () => ({ contextWindowTokens: options.contextWindowTokens, maxOutputTokens: options.maxOutputTokens, supportsTools: options.supportsTools ?? true, supportsReasoning: options.supportsReasoning ?? true }),
    body(request) {
      const body = { model: options.model, messages: chatMessages(request, options), stream: true, stream_options: { include_usage: true }, [options.outputTokenField ?? 'max_tokens']: request.maxOutputTokens };
      if (request.tools.length) body.tools = request.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
      const effort = request.reasoningEffort ?? options.reasoningEffort;
      applyChatReasoning(body, effort, options);
      return body;
    },
    async *stream(request, signal) {
      const calls = new Map();
      const reasoning = createChatReasoningCollector();
      let reason = null, usage = null, lastCallKey = null;
      for await (const event of streamSse(options, `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`, this.body(request), signal)) {
        if (event.error) { yield event.error; return; }
        const data = event.data;
        if (data?.error) { yield providerError(Number(data.error.code) || 400, data.error.message ?? 'provider error', options.apiKey); return; }
        if (data?.usage) usage = data.usage;
        const choice = data?.choices?.find(c => (c.index ?? 0) === 0);
        if (choice) {
          const delta = choice.delta ?? {};
          if (delta.content) yield { type: 'text_delta', itemId: 'text', text: delta.content };
          const thinking = reasoning.add(delta);
          if (thinking) yield { type: 'reasoning_delta', itemId: 'reasoning', blockId: 'reasoning:0', kind: 'summary', text: thinking };
          for (const fragment of delta.tool_calls ?? []) {
            // Some endpoints omit `index`: a fragment with an ID then begins a call and later ones continue it.
            const key = fragment.index ?? fragment.id ?? lastCallKey ?? 0;
            lastCallKey = key;
            const call = calls.get(key) ?? { callId: '', name: '', arguments: '' };
            if (fragment.id) call.callId = fragment.id;
            call.name += fragment.function?.name ?? '';
            call.arguments += fragment.function?.arguments ?? '';
            calls.set(key, call);
            if (fragment.function?.arguments) yield { type: 'tool_call_delta', callId: call.callId, fragment: fragment.function.arguments };
          }
          if (choice.finish_reason) reason = choice.finish_reason;
        }
        if (event.event === 'done') break;
      }
      if (!reason) { yield incompleteStream(); return; }
      if (usage) yield { type: 'usage', inputTokens: usage.prompt_tokens ?? 0, outputTokens: usage.completion_tokens ?? 0, cachedInputTokens: usage.prompt_tokens_details?.cached_tokens };
      if (!['stop', 'tool_calls', 'length'].includes(reason)) { yield { type: 'error', category: 'provider', retryable: false, message: `provider stopped: ${reason}` }; return; }
      if (reason !== 'length' && reasoning.native()) yield { type: 'continuation_item', native: reasoning.native() };
      if (reason !== 'length') for (const call of calls.values()) {
        if (!call.callId || !call.name) { yield { type: 'error', category: 'invalid_response', retryable: false, message: 'provider returned an incomplete tool call' }; return; }
        yield { type: 'tool_call_complete', ...call, arguments: parseArguments(call.arguments) };
      }
      yield { type: 'finished', reason: reason === 'length' ? 'incomplete:max_output_tokens' : reason === 'tool_calls' ? 'tool_calls' : 'completed' };
    },
  };
}
