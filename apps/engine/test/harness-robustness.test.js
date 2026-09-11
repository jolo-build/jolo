import { expect, test } from 'bun:test';
import { buildRequest } from '../src/context/builder.js';
import { compactionEffort } from '../src/context/compaction.js';
import { providerError, streamSse } from '../src/providers/transport.js';
import { completeToolCalls } from '../src/providers/transcript.js';
import { createChatProvider, chatMessages } from '../src/providers/openai-chat.js';
import { createOpenAIProvider } from '../src/providers/openai.js';
import { createAnthropicProvider } from '../src/providers/anthropic.js';
import { geminiSchema } from '../src/providers/gemini.js';
import { BUILTIN_PRESETS, createProviderCatalog } from '../src/providers/presets.js';
import { ProviderFactory } from '../src/providers/index.js';

const options = { protocol: 'openai-chat', preset: 'custom', model: 'm', baseUrl: 'http://localhost/v1', apiKey: 'k' };
const base = { instructions: 'System', items: [], tools: [], maxOutputTokens: 4096 };
const chatSse = chunks => new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n');
const silentStream = () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(': waiting\n\n')); } }), { headers: { 'content-type': 'text/event-stream' } });

test('an interrupted batch is answered in the request and left alone in the stored transcript', () => {
  const items = [
    { kind: 'user_message', groupId: 'u', payload: { text: 'go' } },
    { kind: 'tool_call', groupId: 't', payload: { callId: 'a', name: 'read_file', arguments: { path: 'a' } } },
    { kind: 'tool_call', groupId: 't', payload: { callId: 'b', name: 'read_file', arguments: { path: 'b' } } },
    { kind: 'tool_result', groupId: 't', payload: { callId: 'a', output: 'A' } },
    { kind: 'user_message', groupId: 'u2', payload: { text: 'again' } },
  ];
  const completed = completeToolCalls(items);
  expect(completed.map(i => `${i.kind}:${i.payload.callId ?? i.groupId}`)).toEqual(['user_message:u', 'tool_call:a', 'tool_call:b', 'tool_result:a', 'tool_result:b', 'user_message:u2']);
  expect(completed[4].groupId).toBe('t');
  expect(JSON.parse(completed[4].payload.output)).toMatchObject({ ok: false });
  expect(items).toHaveLength(5);
  const { request } = buildRequest({ capabilities: { contextWindowTokens: 64000, maxOutputTokens: 4096 }, items, tools: [], instructions: 'sys', sessionId: 's', runId: 'r' });
  expect(request.items.filter(i => i.kind === 'tool_result').map(i => i.payload.callId)).toEqual(['a', 'b']);
  // Every protocol sees a complete exchange: chat pairs each call with a tool message.
  const messages = chatMessages(request, options);
  expect(messages.filter(m => m.role === 'tool').map(m => m.tool_call_id)).toEqual(['a', 'b']);
});

test('rejections describing the prompt as too long are context errors even without a stated maximum', () => {
  expect(providerError(400, 'Prompt contains 40000 tokens, too large for model with maximum context length')).toMatchObject({ category: 'context_length', retryable: false });
  expect(providerError(400, 'Prompt contains 40000 tokens, too large for model with maximum context length').contextWindowTokens).toBeUndefined();
  expect(providerError(400, 'prompt is too long: 30000 tokens > 16000 maximum')).toMatchObject({ category: 'context_length', contextWindowTokens: 16000 });
  expect(providerError(400, 'max_tokens is too large: 100000. This model supports at most 32768 completion tokens').category).toBe('invalid_request');
  expect(providerError(400, 'max_tokens: 100000 > 64000, which is the maximum allowed number of output tokens').category).toBe('invalid_request');
  expect(providerError(500, 'context length service unavailable')).toMatchObject({ category: 'provider', retryable: true });
});

test('a silent stream is abandoned as a retryable network error while cancellation still reports cancelled', async () => {
  const url = 'http://localhost/v1/chat/completions';
  const events = await Array.fromAsync(streamSse({ ...options, fetchImpl: async () => silentStream(), idleTimeoutMs: 50 }, url, {}, new AbortController().signal));
  expect(events.at(-1).error).toMatchObject({ category: 'network', retryable: true });
  expect(events.at(-1).error.message).toContain('sent nothing');
  const controller = new AbortController();
  const pending = Array.fromAsync(streamSse({ ...options, fetchImpl: async () => silentStream(), idleTimeoutMs: 10_000 }, url, {}, controller.signal));
  setTimeout(() => controller.abort(), 20);
  expect((await pending).at(-1).error.category).toBe('cancelled');
  const never = Array.fromAsync(streamSse({ ...options, fetchImpl: () => new Promise(() => {}), idleTimeoutMs: 50 }, url, {}, new AbortController().signal));
  expect((await never).at(-1).error.category).toBe('network');
});

test('an oversized error body is truncated instead of hiding the status', async () => {
  const fetchImpl = async () => new Response('x'.repeat(70 * 1024), { status: 503 });
  const events = await Array.fromAsync(streamSse({ ...options, fetchImpl }, 'http://localhost/v1/chat/completions', {}, new AbortController().signal));
  expect(events[0].error).toMatchObject({ category: 'provider', retryable: true, status: 503 });
});

test('chat tool call fragments without an index still assemble separate calls', async () => {
  const provider = createChatProvider({ ...options, fetchImpl: async () => chatSse([
    { choices: [{ index: 0, delta: { tool_calls: [{ id: 'one', function: { name: 'read_file', arguments: '{"path":' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ function: { arguments: '"a"}' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ id: 'two', function: { name: 'list_files', arguments: '{"path":"."}' } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ]) });
  const events = await Array.fromAsync(provider.stream(base, new AbortController().signal));
  expect(events.filter(e => e.type === 'tool_call_complete')).toEqual([
    { type: 'tool_call_complete', callId: 'one', name: 'read_file', arguments: { path: 'a' } },
    { type: 'tool_call_complete', callId: 'two', name: 'list_files', arguments: { path: '.' } },
  ]);
});

test('chat notes travel as user content after the instructions', () => {
  const items = [
    { kind: 'system_note', groupId: 'n', payload: { text: 'Checkpoint of earlier work.' } },
    { kind: 'user_message', groupId: 'u', payload: { text: 'go' } },
  ];
  expect(chatMessages({ ...base, items }, options).map(m => m.role)).toEqual(['system', 'user', 'user']);
});

test('Responses accepts a finished function call that was never announced', async () => {
  const wire = [
    { type: 'response.output_item.done', item: { type: 'function_call', id: 'f1', call_id: 'c1', name: 'list_files', arguments: '{"path":"."}' } },
    { type: 'response.completed', response: {} },
  ].map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const provider = createOpenAIProvider({ ...options, fetchImpl: async () => new Response(wire) });
  const events = await Array.fromAsync(provider.stream(base, new AbortController().signal));
  expect(events.find(e => e.type === 'tool_call_complete')).toEqual({ type: 'tool_call_complete', callId: 'c1', name: 'list_files', arguments: { path: '.' } });
  expect(events.at(-1)).toEqual({ type: 'finished', reason: 'completed' });
});

test('Gemini schema encoding drops unsupported keywords but keeps parameters that share their names', () => {
  const schema = { type: 'object', additionalProperties: false, properties: { default: { type: 'string', default: 'x' }, items: { type: 'array', items: { $ref: '#/x' } } }, required: ['default'] };
  expect(geminiSchema(schema)).toEqual({ type: 'object', properties: { default: { type: 'string' }, items: { type: 'array', items: {} } }, required: ['default'] });
});

test('Anthropic omits thinking only for a newest tool-use turn that lost its thinking block', () => {
  const preset = BUILTIN_PRESETS.find(p => p.id === 'anthropic');
  const provider = createAnthropicProvider({ ...preset, preset: 'anthropic', model: 'm', reasoningEffort: 'low' });
  const user = { kind: 'user_message', groupId: 'u', payload: { text: 'go' } };
  const call = { kind: 'tool_call', groupId: 't', payload: { callId: 'c', name: 'read_file', arguments: { path: 'a' } } };
  const result = { kind: 'tool_result', groupId: 't', payload: { callId: 'c', output: 'A' } };
  const thinking = { kind: 'reasoning', groupId: 't', payload: { native: { type: 'reasoning', block: { type: 'thinking', thinking: 'hm', signature: 's' } }, nativeRef: { protocol: 'anthropic', preset: 'anthropic', model: 'm' } } };
  const enabled = { type: 'enabled', budget_tokens: 1024 };
  expect(provider.body({ ...base, items: [user, call, result] }).thinking).toBeUndefined();
  expect(provider.body({ ...base, items: [user, thinking, call, result] }).thinking).toEqual(enabled);
  const answered = { kind: 'assistant_message', groupId: 'a', payload: { text: 'done' } };
  expect(provider.body({ ...base, items: [user, call, result, answered, { ...user, groupId: 'u2' }] }).thinking).toEqual(enabled);
  expect(provider.body({ ...base, items: [user, call, result], reasoningEffort: 'none' }).thinking).toEqual({ type: 'disabled' });
});

test('compaction lowers effort but never adds reasoning to a run without it', () => {
  expect(compactionEffort(null)).toBeUndefined();
  expect(compactionEffort(undefined)).toBeUndefined();
  expect(compactionEffort('none')).toBe('none');
  expect(compactionEffort('minimal')).toBe('minimal');
  expect(compactionEffort('high')).toBe('low');
  expect(compactionEffort('max')).toBe('low');
});

test('an effort without a thinking budget is rejected before any request is made', async () => {
  const factory = new ProviderFactory({ credentials: { get: async () => ({ value: 'k' }) }, catalog: createProviderCatalog(), fetchImpl: async () => Response.json({ data: [] }) });
  await expect(factory.resolve({ preset: 'anthropic', model: 'm', effort: 'xhigh' })).rejects.toThrow('thinking budget');
  await expect(factory.resolve({ preset: 'gemini', model: 'm', effort: 'max' })).rejects.toThrow('thinking budget');
  expect((await factory.resolve({ preset: 'anthropic', model: 'm', effort: 'minimal' })).reasoningEffort).toBe('minimal');
  expect((await factory.resolve({ preset: 'anthropic', model: 'm', effort: 'none' })).reasoningEffort).toBe('none');
});
