import { streamSse, incompleteStream, parseArguments, providerError } from './transport.js';
import { appendContent, portableItems } from './transcript.js';

export function anthropicMessages(request, options) {
  const messages = [];
  for (const item of portableItems(request.items, { ...options, protocol: 'anthropic' })) {
    const p = item.payload;
    if (item.kind === 'user_message' || item.kind === 'system_note') appendContent(messages, 'user', [
      { type: 'text', text: p.text || '(empty message)' },
      ...(p.images ?? []).map(image => ({ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data } })),
    ]);
    else if (item.kind === 'assistant_message') appendContent(messages, 'assistant', p.text ? [{ type: 'text', text: p.text }] : []);
    else if (item.kind === 'reasoning' && p.native?.block) appendContent(messages, 'assistant', [p.native.block]);
    else if (item.kind === 'tool_call') appendContent(messages, 'assistant', [{ type: 'tool_use', id: p.callId, name: p.name, input: p.arguments ?? {} }]);
    else if (item.kind === 'tool_result') appendContent(messages, 'user', [{ type: 'tool_result', tool_use_id: p.callId, content: p.output }]);
  }
  return messages;
}
export function createAnthropicProvider(options) {
  return {
    name: 'anthropic',
    capabilities: () => ({ contextWindowTokens: options.contextWindowTokens, maxOutputTokens: options.maxOutputTokens, supportsTools: true, supportsReasoning: options.supportsReasoning ?? true }),
    body(request) {
      const body = { model: options.model, system: [{ type: 'text', text: request.instructions, cache_control: { type: 'ephemeral' } }], messages: anthropicMessages(request, options), max_tokens: request.maxOutputTokens, stream: true };
      if (request.tools.length) body.tools = request.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }));
      const effort = request.reasoningEffort ?? options.reasoningEffort;
      // With thinking on, the API requires the newest tool-use turn to begin with its thinking block. After a
      // model change or an interrupted batch that block is gone, so this one request runs without thinking.
      const last = body.messages.findLast(m => m.role === 'assistant');
      const bareToolTurn = Boolean(last?.content.some(b => b.type === 'tool_use')) && !['thinking', 'redacted_thinking'].includes(last.content[0]?.type);
      if (effort === 'none') body.thinking = { type: 'disabled' };
      else if (effort && !bareToolTurn) {
        if (options.thinkingMode === 'adaptive') { body.thinking = { type: 'adaptive' }; body.output_config = { effort }; }
        else {
          const budget = options.thinkingBudgets?.[effort === 'minimal' ? 'low' : effort];
          if (!budget) throw new Error(`This preset needs a thinking budget for effort ${effort}`);
          if (request.maxOutputTokens <= 1024) throw new Error('Thinking requires max output above 1024 tokens');
          body.thinking = { type: 'enabled', budget_tokens: Math.min(budget, request.maxOutputTokens - 1) };
        }
      }
      return body;
    },
    async *stream(request, signal) {
      const blocks = new Map();
      let reason = null, usage = {};
      for await (const e of streamSse(options, `${options.baseUrl.replace(/\/+$/, '')}/messages`, this.body(request), signal)) {
        if (e.error) { yield e.error; return; }
        const d = e.data, index = d?.index;
        if (e.event === 'message_start') usage = { ...d.message?.usage };
        else if (e.event === 'content_block_start') {
          const block = { ...d.content_block }; blocks.set(index, { block, json: '' });
          if (block.type === 'text' && block.text) yield { type: 'text_delta', itemId: String(index), text: block.text };
          if (block.type === 'thinking' && block.thinking) yield { type: 'reasoning_delta', itemId: String(index), blockId: String(index), kind: 'summary', text: block.thinking };
        } else if (e.event === 'content_block_delta') {
          const entry = blocks.get(index);
          if (!entry) { yield { type: 'error', category: 'invalid_response', retryable: false, message: 'delta for unknown content block' }; return; }
          const delta = d.delta;
          if (delta.type === 'text_delta') { entry.block.text += delta.text; yield { type: 'text_delta', itemId: String(index), text: delta.text }; }
          else if (delta.type === 'thinking_delta') { entry.block.thinking += delta.thinking; yield { type: 'reasoning_delta', itemId: String(index), blockId: String(index), kind: 'summary', text: delta.thinking }; }
          else if (delta.type === 'signature_delta') entry.block.signature = (entry.block.signature ?? '') + delta.signature;
          else if (delta.type === 'input_json_delta') { entry.json += delta.partial_json; yield { type: 'tool_call_delta', callId: entry.block.id, fragment: delta.partial_json }; }
        } else if (e.event === 'content_block_stop') {
          const entry = blocks.get(index);
          if (!entry) continue;
          entry.stopped = true;
          const b = entry.block;
          if (b.type === 'tool_use') yield { type: 'tool_call_complete', callId: b.id, name: b.name, arguments: entry.json ? parseArguments(entry.json) : b.input };
          else if (b.type === 'thinking' || b.type === 'redacted_thinking') {
            yield { type: 'reasoning_complete', itemId: String(index), blockId: String(index), status: b.type === 'redacted_thinking' ? 'redacted' : 'complete' };
            yield { type: 'continuation_item', native: { type: 'reasoning', block: b } };
          }
        } else if (e.event === 'message_delta') { reason = d.delta?.stop_reason ?? reason; usage = { ...usage, ...d.usage }; }
        else if (e.event === 'message_stop') {
          if (!reason || [...blocks.values()].some(b => !b.stopped)) { yield incompleteStream(); return; }
          yield { type: 'usage', inputTokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0), outputTokens: usage.output_tokens ?? 0, cachedInputTokens: usage.cache_read_input_tokens };
          if (!['end_turn', 'stop_sequence', 'tool_use', 'max_tokens'].includes(reason)) { yield { type: 'error', category: 'provider', retryable: false, message: `provider stopped: ${reason}` }; return; }
          yield { type: 'finished', reason: reason === 'max_tokens' ? 'incomplete:max_output_tokens' : reason === 'tool_use' ? 'tool_calls' : 'completed' }; return;
        } else if (e.event === 'error') {
          yield providerError(d.error?.type === 'overloaded_error' ? 529 : d.error?.type === 'rate_limit_error' ? 429 : 400, d.error?.message ?? 'provider error', options.apiKey); return;
        }
      }
      yield incompleteStream();
    },
  };
}
