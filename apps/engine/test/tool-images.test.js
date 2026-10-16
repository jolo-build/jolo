import { expect, test } from 'bun:test';
import { IMAGE_RESULTS_KEPT, hydrateRequestImages, imageResultsKept } from '../src/attachments.js';
import { buildRequest } from '../src/context/builder.js';
import { resultText } from '../src/providers/transcript.js';
import { anthropicMessages, createAnthropicProvider } from '../src/providers/anthropic.js';
import { createOpenAIProvider } from '../src/providers/openai.js';
import { chatMessages } from '../src/providers/openai-chat.js';
import { geminiContents } from '../src/providers/gemini.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { ToolDispatcher } from '../src/tools/dispatcher.js';

const PNG = 'iVBORw0KGgo=';
const image = (n) => ({ artifactId: `art_${n}`, mimeType: 'image/png', width: 640, height: 400, bytes: 8 });
const storage = { getArtifact: id => ({ id, sessionId: 's', finalizedHash: 'h', committedBytes: 8 }), readArtifact: () => ({ buffer: Buffer.from(PNG, 'base64') }) };
/** A model turn that called one tool and its result, so groups stay whole. */
const turn = (n, images = true) => [
  { kind: 'tool_call', groupId: `g${n}`, payload: { callId: `c${n}`, name: 'browser_screenshot', arguments: {} } },
  { kind: 'tool_result', groupId: `g${n}`, payload: { callId: `c${n}`, output: JSON.stringify({ ok: true, artifactId: `art_${n}` }), ...(images ? { images: [image(n)] } : {}) } },
];
const items = [{ kind: 'user_message', groupId: 'u', payload: { text: 'look' } }, ...[1, 2, 3, 4, 5].flatMap(n => turn(n))];

test('only the newest tool screenshots are hydrated; older ones keep their text and say what was pruned', () => {
  const kept = imageResultsKept(items);
  expect([...kept].map(item => item.payload.callId)).toEqual(['c5', 'c4', 'c3']);
  expect(kept.size).toBe(IMAGE_RESULTS_KEPT);
  const { items: hydrated } = hydrateRequestImages(storage, { sessionId: 's', items });
  const results = hydrated.filter(item => item.kind === 'tool_result');
  expect(results.slice(-3).every(item => item.payload.images[0].data === PNG)).toBe(true);
  expect(results.slice(0, 2).every(item => !item.payload.images && item.payload.imagesOmitted === 1)).toBe(true);
  expect(resultText(results[0].payload)).toContain('removed from the context');
  expect(resultText(results[4].payload)).toBe(results[4].payload.output);
  expect(() => hydrateRequestImages({ ...storage, getArtifact: () => null }, { sessionId: 's', items })).toThrow('missing');
  expect(() => hydrateRequestImages(storage, { sessionId: 'other', items })).toThrow('another task');
});

test('the context builder reserves vision tokens only for the screenshots that will be sent', () => {
  const capabilities = { contextWindowTokens: 200_000, maxOutputTokens: 1_000 };
  const withImages = buildRequest({ capabilities, items, tools: [], instructions: 'sys', sessionId: 's', runId: 'r' }).accounting.estimatedInputTokens;
  const without = buildRequest({ capabilities, items: items.map(item => ({ ...item, payload: { ...item.payload, images: undefined } })), tools: [], instructions: 'sys', sessionId: 's', runId: 'r' }).accounting.estimatedInputTokens;
  expect(withImages - without).toBeGreaterThanOrEqual(IMAGE_RESULTS_KEPT * 4096);
  expect(withImages - without).toBeLessThan((IMAGE_RESULTS_KEPT + 1) * 4096);
});

test('the dispatcher separates result images from the JSON the transcript and clients read', () => {
  const dispatcher = new ToolDispatcher({ registry: new ToolRegistry(), permissions: {}, storage: { transaction: fn => fn(), updateInvocation() {}, appendEvent() {} }, log: {}, env: { path: '', ripgrep: null, git: null } });
  const result = dispatcher.complete({ run: { id: 'r', sessionId: 's' }, call: { callId: 'c' }, tool: { name: 'browser_screenshot' }, result: { artifactId: 'art_1', width: 1, height: 1, bytes: 8, mimeType: 'image/png', images: [image(1), { bogus: true }] }, startedAt: Date.now(), invocation: { id: 'inv' } });
  expect(result.images).toEqual([image(1)]);
  expect(JSON.parse(result.output)).toEqual({ ok: true, artifactId: 'art_1', width: 1, height: 1, bytes: 8, mimeType: 'image/png' });
  expect(result.resultArtifactId).toBe('art_1');
});

const hydrated = hydrateRequestImages(storage, { sessionId: 's', items }).items;
const tools = new ToolRegistry().declarations({ browserAvailable: true });
const request = { instructions: 'sys', items: hydrated, tools, maxOutputTokens: 1000 };
const options = { model: 'm', preset: 'p', baseUrl: 'http://x', contextWindowTokens: 100000, maxOutputTokens: 1000, protocol: 'anthropic' };

test('Messages: images travel inside the tool result; the omitted note replaces pruned ones', () => {
  const messages = anthropicMessages(request, options);
  const results = messages.flatMap(m => m.content).filter(b => b.type === 'tool_result');
  expect(results).toHaveLength(5);
  expect(typeof results[0].content).toBe('string'); expect(results[0].content).toContain('removed from the context');
  expect(results[4].content).toEqual([{ type: 'text', text: expect.stringContaining('"ok":true') }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }]);
  expect(results.some(r => r.toolset_name)).toBe(false);
  const body = createAnthropicProvider(options).body({ ...request, tools });
  expect(body.tools.map(t => t.name)).toContain('browser_screenshot');
  expect(body.tools.some(t => t.type)).toBe(false);
});

test('Messages with the native toolset: the vendor toolset replaces four portable tools, calls replay as members, and results name the toolset', () => {
  const native = { ...options, computerUse: 'native' };
  const body = createAnthropicProvider(native).body({ ...request, tools });
  expect(body.tools[0]).toMatchObject({ type: 'computer_toolset_20260801', configs: { hold_key: { enabled: false } } });
  const names = body.tools.slice(1).map(t => t.name);
  for (const name of ['browser_screenshot', 'browser_zoom', 'browser_pointer', 'browser_wait']) expect(names).not.toContain(name);
  for (const name of ['browser_click', 'browser_snapshot', 'browser_press', 'browser_type', 'read_file']) expect(names).toContain(name);
  // A call the model made through the toolset replays as its own block; a portable call from another
  // preset is expressed as the member; a reference-based call stays a function call.
  const nativeRef = { protocol: 'anthropic', preset: 'p', model: 'm', baseUrl: 'http://x' };
  const block = { type: 'tool_use', id: 'k1', name: 'left_click', toolset_name: 'computer', input: { coordinate: [3, 4] } };
  const history = [
    { kind: 'user_message', groupId: 'u', payload: { text: 'go' } },
    { kind: 'tool_call', groupId: 'g', payload: { callId: 'k1', name: 'browser_pointer', arguments: { action: 'click', x: 3, y: 4 }, native: { block }, nativeRef } },
    { kind: 'tool_call', groupId: 'g', payload: { callId: 'k2', name: 'browser_zoom', arguments: { x0: 0, y0: 0, x1: 5, y1: 6 } } },
    { kind: 'tool_call', groupId: 'g', payload: { callId: 'k3', name: 'browser_click', arguments: { ref: 'e1' } } },
    { kind: 'tool_result', groupId: 'g', payload: { callId: 'k1', output: '{"ok":true}' } },
    { kind: 'tool_result', groupId: 'g', payload: { callId: 'k2', output: '{"ok":false,"error":{"code":"x"}}' } },
    { kind: 'tool_result', groupId: 'g', payload: { callId: 'k3', output: '{"ok":true}' } },
  ];
  const messages = anthropicMessages({ ...request, items: history }, native);
  const uses = messages[1].content;
  expect(uses[0]).toEqual(block);
  expect(uses[1]).toEqual({ type: 'tool_use', id: 'k2', name: 'zoom', toolset_name: 'computer', input: { region: [0, 0, 5, 6] } });
  expect(uses[2]).toEqual({ type: 'tool_use', id: 'k3', name: 'browser_click', input: { ref: 'e1' } });
  const results = messages[2].content;
  expect(results[0]).toMatchObject({ tool_use_id: 'k1', toolset_name: 'computer' }); expect(results[0].is_error).toBeUndefined();
  expect(results[1]).toMatchObject({ tool_use_id: 'k2', toolset_name: 'computer', is_error: true });
  expect(results[2].toolset_name).toBeUndefined();
  // Without the browser the toolset is not declared and the same history replays as function calls.
  const portable = anthropicMessages({ ...request, items: history, tools: [] }, native);
  expect(portable[1].content[1]).toMatchObject({ name: 'browser_zoom' });
  expect(portable[1].content[0]).toEqual(block); // the block the model produced is always replayed as made
});

test('Messages stream: toolset member calls arrive as portable tool calls with their block kept for replay', async () => {
  const events = [
    { type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'left_click', toolset_name: 'computer', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"coordinate":[12,' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '34],"text":"shift"}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't2', name: 'hold_key', toolset_name: 'computer', input: { text: 'a', duration: 1 } } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } },
    { type: 'message_stop' },
  ];
  const sse = events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const provider = createAnthropicProvider({ ...options, computerUse: 'native', fetchImpl: async () => new Response(sse, { headers: { 'content-type': 'text/event-stream' } }) });
  const out = [];
  for await (const event of provider.stream({ ...request, items: hydrated.slice(0, 1) }, new AbortController().signal)) out.push(event);
  const calls = out.filter(e => e.type === 'tool_call_complete');
  expect(calls[0]).toEqual({ type: 'tool_call_complete', callId: 't1', name: 'browser_pointer', arguments: { action: 'click', x: 12, y: 34, modifiers: ['Shift'] } });
  expect(calls[1]).toMatchObject({ callId: 't2', name: 'computer_hold_key' }); // unsupported: the registry answers with a structured error
  const blocks = out.filter(e => e.type === 'continuation_item').map(e => e.native.block);
  expect(blocks[0]).toEqual({ type: 'tool_use', id: 't1', name: 'left_click', toolset_name: 'computer', input: { coordinate: [12, 34], text: 'shift' } });
  expect(out.at(-1)).toEqual({ type: 'finished', reason: 'tool_calls' });
});

test('Responses: a function output carries the image as input parts', () => {
  const body = createOpenAIProvider(/** @type {any} */ ({ ...options, protocol: 'openai-responses' })).body(request);
  const outputs = body.input.filter(i => i.type === 'function_call_output');
  expect(typeof outputs[0].output).toBe('string');
  expect(outputs[4].output).toEqual([{ type: 'input_text', text: expect.stringContaining('"ok":true') }, { type: 'input_image', image_url: `data:image/png;base64,${PNG}`, detail: 'auto' }]);
});

test('Chat: tool messages stay text and one user message after them carries the pictures', () => {
  const messages = chatMessages(request, { ...options, protocol: 'openai-chat' });
  const last = messages.at(-1);
  expect(messages.at(-2)).toMatchObject({ role: 'tool', tool_call_id: 'c5' });
  expect(last.role).toBe('user');
  expect(last.content[0].text).toContain('browser_screenshot');
  expect(last.content[1]).toEqual({ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } });
  expect(messages.filter(m => m.role === 'user' && Array.isArray(m.content))).toHaveLength(IMAGE_RESULTS_KEPT);
  expect(messages.find(m => m.tool_call_id === 'c1').content).toContain('removed from the context');
});

test('GenerateContent: the function response carries the image in its own parts', () => {
  const contents = geminiContents(request, { ...options, protocol: 'gemini' });
  const responses = contents.flatMap(c => c.parts).filter(p => p.functionResponse).map(p => p.functionResponse);
  expect(responses[0].parts).toBeUndefined();
  expect(responses[4]).toMatchObject({ name: 'browser_screenshot', response: { output: expect.stringContaining('"ok":true') }, parts: [{ inlineData: { mimeType: 'image/png', data: PNG } }] });
});
