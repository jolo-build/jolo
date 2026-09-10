// Wire fixtures shared by the adapter conformance tests. No vendor credentials or paid calls.
const named = events => events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const data = events => events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
export const PROTOCOLS = ['openai-responses', 'openai-chat', 'anthropic', 'gemini'];
export function wireTurn(protocol, { tool = false, incomplete = false, text = 'Fixture answer.', toolName = 'list_files', args = { path: '.' }, signature = 'SIGNED-FIXTURE', reasoningChunks, callId = 'call1' } = {}) {
  if (protocol === 'openai-responses') return named([
    ...(tool ? [
      { type: 'response.reasoning_summary_text.delta', item_id: 'r1', delta: 'Inspect files.' },
      { type: 'response.output_item.done', item: { type: 'reasoning', id: 'r1', summary: [], encrypted_content: signature } },
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'f1', call_id: 'call1', name: toolName } },
      { type: 'response.function_call_arguments.delta', item_id: 'f1', delta: JSON.stringify(args).slice(0, 4) },
      { type: 'response.function_call_arguments.delta', item_id: 'f1', delta: JSON.stringify(args).slice(4) },
      { type: 'response.function_call_arguments.done', item_id: 'f1', arguments: JSON.stringify(args) },
      { type: 'response.output_item.done', item: { type: 'function_call', id: 'f1', call_id: 'call1', name: toolName } },
    ] : [{ type: 'response.output_text.delta', item_id: 'm1', delta: text }]),
    { type: incomplete ? 'response.incomplete' : 'response.completed', response: { usage: { input_tokens: 42, output_tokens: 7, input_tokens_details: { cached_tokens: 5 } }, incomplete_details: { reason: 'max_output_tokens' } } },
  ]);
  if (protocol === 'openai-chat') return data([
    ...(reasoningChunks ?? (tool ? [{ reasoning_content: 'Inspect files.' }] : [])).map(delta => ({ choices: [{ index: 0, delta }] })),
    ...(tool ? [
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: callId, function: { name: toolName, arguments: JSON.stringify(args).slice(0,4) } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args).slice(4) } }] } }] },
    ] : [{ choices: [{ index: 0, delta: { content: text } }] }]),
    { choices: [{ index: 0, delta: {}, finish_reason: incomplete ? 'length' : tool ? 'tool_calls' : 'stop' }] },
    { choices: [], usage: { prompt_tokens: 42, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 5 } } },
  ]) + 'data: [DONE]\n\n';
  if (protocol === 'anthropic') return named([
    { type: 'message_start', message: { usage: { input_tokens: 37, cache_read_input_tokens: 5, output_tokens: 1 } } },
    ...(tool ? [
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Inspect files.' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call1', name: toolName, input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify(args).slice(0,4) } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify(args).slice(4) } },
      { type: 'content_block_stop', index: 1 },
    ] : [
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      { type: 'content_block_stop', index: 0 },
    ]),
    { type: 'message_delta', delta: { stop_reason: incomplete ? 'max_tokens' : tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 7 } },
    { type: 'message_stop' },
  ]);
  return data([
    ...(tool ? [{ candidates: [{ index: 0, content: { parts: [{ text: 'Inspect files.', thought: true }] } }] }, { candidates: [{ index: 0, content: { parts: [{ functionCall: { id: 'call1', name: toolName, args }, thoughtSignature: signature }] } }] }] : [{ candidates: [{ index: 0, content: { parts: [{ text }] } }] }]),
    { candidates: [{ index: 0, finishReason: incomplete ? 'MAX_TOKENS' : 'STOP' }], usageMetadata: { promptTokenCount: 42, candidatesTokenCount: 5, thoughtsTokenCount: 2, cachedContentTokenCount: 5 } },
  ]);
}

export function mockProvider(protocol, { turns = [{}], failures = [], hang = false, raw = null, validate } = {}) {
  const requests = [], listings = [];
  let turn = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'GET') {
      listings.push(url.pathname);
      return Response.json(protocol === 'gemini' ? { models: [{ name: 'models/test-model', displayName: 'Test model', inputTokenLimit: 64000, outputTokenLimit: 4096, supportedGenerationMethods: ['generateContent'], thinking: true }] }
        : { data: [{ id: 'test-model', display_name: 'Test model', max_input_tokens: 64000, max_tokens: 4096 }] });
    }
    const body = await request.json(); requests.push({ body, url: request.url, headers: Object.fromEntries(request.headers) });
    const invalid = validate?.(body, requests.length - 1);
    if (invalid) return Response.json({ error: { message: invalid } }, { status: 400 });
    const failure = failures[requests.length - 1];
    if (failure) return Response.json({ error: { message: typeof failure === 'object' ? failure.message : 'fixture failure' } }, { status: typeof failure === 'object' ? failure.status : failure });
    if (hang) return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(': waiting\n\n')); } }), { headers: { 'content-type': 'text/event-stream' } });
    const wire = raw ?? wireTurn(protocol, turns[Math.min(turn++, turns.length - 1)]);
    const bytes = new TextEncoder().encode(wire);
    let offset = 0;
    return new Response(new ReadableStream({ pull(c) { if (offset >= bytes.length) c.close(); else { c.enqueue(bytes.slice(offset, offset += 137)); } } }), { headers: { 'content-type': 'text/event-stream' } });
  } });
  return { requests, listings, baseUrl: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}
