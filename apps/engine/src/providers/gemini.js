import { randomUUID } from 'node:crypto';
import { streamSse, incompleteStream, providerError } from './transport.js';
import { appendContent, itemGroups, nativeFor } from './transcript.js';

export function geminiContents(request, options) {
  const messages = [], calls = new Map();
  for (const group of itemGroups(request.items)) {
    // The complete native turn preserves signed part boundaries, including empty text parts.
    const native = group.items.map(i => nativeFor(i, { ...options, protocol: 'gemini' })).find(n => n?.parts);
    const nativeCalls = native?.parts.filter(part => part.functionCall).map(part => part.functionCall) ?? [];
    let nativeAdded = false, callIndex = 0;
    for (const item of group.items) {
      const p = item.payload;
      if (item.kind === 'tool_call') calls.set(p.callId, { name: p.name, id: native ? nativeCalls[callIndex++]?.id : p.callId });
      if (['assistant_message', 'reasoning', 'tool_call'].includes(item.kind) && native) {
        if (!nativeAdded) { appendContent(messages, 'model', native.parts, 'parts'); nativeAdded = true; }
        continue;
      }
      if (item.kind === 'user_message' || item.kind === 'system_note') appendContent(messages, 'user', [{ text: p.text }, ...(p.images ?? []).map(image => ({ inlineData: { mimeType: image.mimeType, data: image.data } }))], 'parts');
      else if (item.kind === 'assistant_message') appendContent(messages, 'model', p.text ? [{ text: p.text }] : [], 'parts'); // an empty text part is rejected
      else if (item.kind === 'tool_call') appendContent(messages, 'model', [{ functionCall: { id: p.callId, name: p.name, args: p.arguments ?? {} }, thoughtSignature: 'skip_thought_signature_validator' }], 'parts');
      else if (item.kind === 'tool_result') appendContent(messages, 'user', [{ functionResponse: { ...(calls.get(p.callId)?.id ? { id: calls.get(p.callId).id } : {}), name: calls.get(p.callId)?.name ?? 'unknown_tool', response: { output: p.output } } }], 'parts');
    }
  }
  return messages;
}
// GenerateContent accepts a subset of OpenAPI. Local tool validation remains authoritative.
const UNSUPPORTED_KEYWORDS = ['$schema', '$ref', '$defs', 'additionalProperties', 'default'];
export function geminiSchema(schema, { propertyNames = false } = {}) {
  if (Array.isArray(schema)) return schema.map(entry => geminiSchema(entry));
  if (!schema || typeof schema !== 'object') return schema;
  // Keys under `properties` are parameter names, not keywords: a parameter called `default` must survive.
  return Object.fromEntries(Object.entries(schema)
    .filter(([key]) => propertyNames || !UNSUPPORTED_KEYWORDS.includes(key))
    .map(([key, value]) => [key, geminiSchema(value, { propertyNames: !propertyNames && key === 'properties' })]));
}
export function createGeminiProvider(options) {
  return {
    name: 'gemini',
    capabilities: () => ({ contextWindowTokens: options.contextWindowTokens, maxOutputTokens: options.maxOutputTokens, supportsTools: true, supportsReasoning: options.supportsReasoning ?? true }),
    body(request) {
      const body = { systemInstruction: { parts: [{ text: request.instructions }] }, contents: geminiContents(request, options), generationConfig: { maxOutputTokens: request.maxOutputTokens, candidateCount: 1 } };
      if (request.tools.length) body.tools = [{ functionDeclarations: request.tools.map(t => ({ name: t.name, description: t.description, parameters: geminiSchema(t.parameters) })) }];
      const effort = request.reasoningEffort ?? options.reasoningEffort;
      if (effort) {
        if (options.thinkingMode === 'level') body.generationConfig.thinkingConfig = { thinkingLevel: effort === 'none' ? 'minimal' : effort, includeThoughts: true };
        else {
          const budget = effort === 'none' ? 0 : options.thinkingBudgets?.[effort === 'minimal' ? 'low' : effort];
          if (budget === undefined) throw new Error(`This preset needs a thinking budget for effort ${effort}`);
          body.generationConfig.thinkingConfig = { thinkingBudget: Math.min(budget, request.maxOutputTokens - 1), includeThoughts: true };
        }
      }
      return body;
    },
    async *stream(request, signal) {
      const model = options.model.replace(/^models\//, '');
      const url = `${options.baseUrl.replace(/\/+$/, '')}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
      const parts = [], calls = [], nonce = randomUUID();
      let reason = null, usage = null;
      for await (const e of streamSse(options, url, this.body(request), signal)) {
        if (e.error) { yield e.error; return; }
        const data = e.data;
        if (data?.error) { yield providerError(data.error.code ?? 400, data.error.message ?? 'provider error', options.apiKey); return; }
        if (data?.usageMetadata) usage = data.usageMetadata;
        if (data?.promptFeedback?.blockReason) { yield { type: 'error', category: 'provider', retryable: false, message: `prompt blocked: ${data.promptFeedback.blockReason}` }; return; }
        const candidate = data?.candidates?.find(c => (c.index ?? 0) === 0);
        for (const part of candidate?.content?.parts ?? []) {
          parts.push(part);
          if (part.text) yield part.thought ? { type: 'reasoning_delta', itemId: 'thought', blockId: 'thought:0', kind: 'summary', text: part.text } : { type: 'text_delta', itemId: 'text', text: part.text };
          if (part.functionCall) {
            const f = part.functionCall;
            // Preserve server IDs when present; older endpoints do not send one.
            calls.push({ callId: f.id ?? `gemini_${nonce}_${calls.length}`, name: f.name, arguments: f.args ?? {} });
          }
        }
        if (candidate?.finishReason) reason = candidate.finishReason;
      }
      if (!reason) { yield incompleteStream(); return; }
      if (usage) yield { type: 'usage', inputTokens: usage.promptTokenCount ?? 0, outputTokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0), cachedInputTokens: usage.cachedContentTokenCount };
      if (!['STOP', 'MAX_TOKENS'].includes(reason)) { yield { type: 'error', category: 'provider', retryable: false, message: `provider stopped: ${reason}` }; return; }
      if (reason === 'STOP') {
        for (const call of calls) yield { type: 'tool_call_complete', ...call };
        if (parts.length) yield { type: 'continuation_item', native: { type: 'reasoning', parts } };
      }
      yield { type: 'finished', reason: reason === 'MAX_TOKENS' ? 'incomplete:max_output_tokens' : calls.length ? 'tool_calls' : 'completed' };
    },
  };
}
