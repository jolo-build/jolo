import { expect, test } from 'bun:test';
import { ProviderPresetSchema } from '@jolo/protocol';
import { BUILTIN_PRESETS } from '../../apps/engine/src/providers/presets.js';
import { createChatProvider, chatMessages } from '../../apps/engine/src/providers/openai-chat.js';
import { createChatReasoningCollector } from '../../apps/engine/src/providers/chat-reasoning.js';
import { createOpenAIProvider } from '../../apps/engine/src/providers/openai.js';
import { wireTurn } from '../fixtures/mock-providers.js';

const options = { protocol: 'openai-chat', preset: 'custom', model: 'any-model', baseUrl: 'http://localhost/v1' };
const request = { instructions: 'System', items: [], tools: [], maxOutputTokens: 4096 };
const nativeItem = (chat, tag = options) => ({ kind: 'reasoning', groupId: 'g', payload: { native: { type: 'reasoning', chat }, nativeRef: tag } });

test('chat reasoning controls are preset data, independent of provider or model names', () => {
  for (const effortParameter of ['reasoning_effort', 'reasoning.effort']) {
    const provider = createChatProvider({ ...options, chatReasoning: { effortParameter, thinkingToggle: true } });
    const enabled = provider.body({ ...request, reasoningEffort: 'high' });
    expect(enabled.thinking).toEqual({ type: 'enabled' });
    expect(effortParameter === 'reasoning_effort' ? enabled.reasoning_effort : enabled.reasoning.effort).toBe('high');
    const disabled = provider.body({ ...request, reasoningEffort: 'none' });
    expect(disabled.thinking).toEqual({ type: 'disabled' });
    expect(disabled.reasoning_effort).toBeUndefined(); expect(disabled.reasoning).toBeUndefined();
    expect(provider.body(request).thinking).toBeUndefined();
  }
  expect(createChatProvider(options).body({ ...request, reasoningEffort: 'none' }).reasoning_effort).toBe('none');
  const deepseek = BUILTIN_PRESETS.find(p => p.id === 'deepseek');
  expect(deepseek).toMatchObject({ protocol: 'openai-chat', baseUrl: 'https://api.deepseek.com', auth: { env: 'DEEPSEEK_API_KEY' }, chatReasoning: { thinkingToggle: true, requireReasoningContent: true } });
  expect(ProviderPresetSchema.safeParse({ ...deepseek, chatReasoning: { effortParameter: 'unrecognized.path' } }).success).toBe(false);
});

test('chat replay attaches reasoning to its own assistant turn and isolates native data', () => {
  const details = [{ type: 'reasoning.encrypted', data: 'opaque', signature: 'signature' }];
  const items = [
    nativeItem({ reasoning_content: 'first', reasoning: 'alias', reasoning_details: details, content: 'must not replace answer', role: 'system' }),
    { kind: 'assistant_message', groupId: 'g', payload: { text: 'Answer.' } },
    ...['one', 'two'].map(callId => ({ kind: 'tool_call', groupId: 'g', payload: { callId, name: 'read_file', arguments: { path: callId } } })),
    ...['one', 'two'].map(callId => ({ kind: 'tool_result', groupId: 'g', payload: { callId, output: callId } })),
  ];
  const before = JSON.stringify(items);
  const messages = chatMessages({ ...request, items }, options);
  expect(messages[1]).toMatchObject({ role: 'assistant', content: 'Answer.', reasoning_content: 'first', reasoning: 'alias', reasoning_details: details });
  expect(messages[1].tool_calls).toHaveLength(2);
  expect(messages.slice(2).map(m => m.role)).toEqual(['tool', 'tool']);
  for (const changed of [{ model: 'other' }, { preset: 'other' }, { baseUrl: 'https://elsewhere.example/v1' }]) {
    const foreign = chatMessages({ ...request, items }, { ...options, ...changed });
    expect(foreign[1].reasoning_content).toBeUndefined(); expect(foreign[1].reasoning_details).toBeUndefined();
    expect(foreign[1].content).toBe('Answer.'); expect(foreign[1].tool_calls).toHaveLength(2);
  }
  expect(JSON.stringify(items)).toBe(before);
  expect(chatMessages({ ...request, items: [nativeItem({ reasoning_content: 'reasoning only' })] }, options)[1].reasoning_content).toBe('reasoning only');
});

test('empty reasoning is explicit only when an endpoint requires that field', () => {
  const items = [{ kind: 'assistant_message', groupId: 'g', payload: { text: 'Imported answer' } }];
  expect(chatMessages({ ...request, items }, options)[1].reasoning_content).toBeUndefined();
  expect(chatMessages({ ...request, items }, { ...options, chatReasoning: { requireReasoningContent: true } })[1].reasoning_content).toBe('');
});

test('structured reasoning preserves signed chunks and hides opaque data from display', () => {
  const collector = createChatReasoningCollector();
  const first = { type: 'reasoning.text', text: 'Inspect ', index: 0, id: 'r', signature: null };
  const second = { type: 'reasoning.text', text: 'files.', index: 0, id: 'r', signature: 'signed', format: 'custom' };
  const opaque = { type: 'reasoning.encrypted', data: 'SECRET-OPAQUE', index: 1, futureMetadata: { version: 2 } };
  expect(collector.add({ reasoning: 'Inspect ', reasoning_details: [first] })).toBe('Inspect ');
  expect(collector.add({ reasoning: 'files.', reasoning_details: [second, opaque] })).toBe('files.');
  expect(collector.native().chat).toEqual({ reasoning: 'Inspect files.', reasoning_details: [first, second, opaque] });
  const structured = createChatReasoningCollector();
  expect(structured.add({ reasoning_details: [first, second, opaque] })).toBe('Inspect files.');
});

test('failed or incomplete chat attempts cannot contribute reasoning to later requests', async () => {
  for (const raw of [wireTurn('openai-chat', { incomplete: true, reasoningChunks: [{ reasoning_content: 'partial' }] }), 'data: {"choices":[{"index":0,"delta":{"reasoning_content":"partial"}}]}\n\n']) {
    const provider = createChatProvider({ ...options, fetchImpl: async () => new Response(raw) });
    const events = await Array.fromAsync(provider.stream(request, new AbortController().signal));
    expect(events.some(e => e.type === 'continuation_item')).toBe(false);
    expect(events.some(e => e.type === 'error' || e.reason?.startsWith('incomplete'))).toBe(true);
  }
});

test('Responses preserves plaintext continuation content as well as encrypted reasoning', async () => {
  const item = { type: 'reasoning', id: 'r', content: [{ type: 'reasoning_text', text: 'Inspect files.' }], summary: [], provider_metadata: { signature: 'opaque' } };
  const wire = [
    { type: 'response.reasoning_text.delta', item_id: 'r', delta: 'Inspect files.' },
    { type: 'response.output_item.done', item },
    { type: 'response.completed', response: {} },
  ].map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const provider = createOpenAIProvider({ ...options, fetchImpl: async () => new Response(wire) });
  const events = await Array.fromAsync(provider.stream(request, new AbortController().signal));
  expect(events.find(e => e.type === 'reasoning_delta').text).toBe('Inspect files.');
  const native = events.find(e => e.type === 'continuation_item').native;
  expect(native).toEqual(item);
  const body = provider.body({ ...request, reasoningEffort: 'none', items: [{ kind: 'reasoning', payload: { native, nativeRef: { ...options, protocol: 'openai-responses' } } }] });
  expect(body.input[0]).toEqual(item); expect(body.reasoning).toEqual({ effort: 'none' });
});
