// Bounded HTTP/SSE transport shared by adapters. Retries belong to the harness.
import { createSseParser } from './sse.js';

export const RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
const ERROR_BODY_MAX_BYTES = 64 * 1024;
// A stream that stays silent this long is treated as lost. Reasoning providers send summaries, pings or
// keep-alive comments well within it; without a bound a stalled endpoint would hold a run for hours.
export const STREAM_IDLE_MS = 300_000;
export function requestHeaders(options) {
  const headers = { 'content-type': 'application/json', ...options.headers };
  const kind = options.auth?.kind ?? 'bearer';
  if (kind !== 'none' && options.apiKey) headers[kind === 'bearer' ? 'authorization' : kind] = kind === 'bearer' ? `Bearer ${options.apiKey}` : options.apiKey;
  return headers;
}
export function redact(message, key) { return (key ? String(message).split(key).join('[redacted]') : String(message)).slice(0, 500); }
export async function boundedText(response, maxBytes = RESPONSE_MAX_BYTES, { truncate = false } = {}) {
  if (!response.body) return '';
  const reader = response.body.getReader(), chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        if (!truncate) throw Object.assign(new Error('provider response exceeded size limit'), { category: 'limit' });
        chunks.push(value.subarray(0, value.byteLength - (bytes - maxBytes)));
        return `${Buffer.concat(chunks).toString('utf8')}…`;
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await reader.cancel().catch(() => {}); }
}
export function contextWindowFromError(text) {
  // Only explicit maximums, never the size of the rejected request or a generic number.
  const patterns = [/(?:maximum context length|context (?:window|length)(?: limit)?|maximum input tokens?)\s*(?:is|of|:|=)?\s*([\d,]+)\s*(?:tokens)?/i,
    /prompt is too long[^\n]*?>\s*([\d,]+)\s*maximum/i,
    /(?:exceeds?|exceeded) the maximum (?:number of tokens allowed|input token limit)\s*\(?([\d,]+)\)?/i];
  for (const re of patterns) {
    const n = Number(re.exec(text)?.[1]?.replaceAll(',', ''));
    if (Number.isInteger(n) && n >= 1000 && n <= 10_000_000) return n;
  }
  return null;
}
// Rejections that describe the prompt as too long without stating the maximum. Output-size limits
// ("max_tokens is too large") deliberately do not match: shrinking history would not help them.
const CONTEXT_REJECTION = /context (?:length|window)|prompt is too long|too many tokens|input token count|reduce the length of the messages|maximum input tokens/i;
export function providerError(status, message, key) {
  const rejected = [400, 413, 422].includes(status);
  const contextWindowTokens = rejected ? contextWindowFromError(message) : null;
  const contextLength = Boolean(contextWindowTokens) || (rejected && CONTEXT_REJECTION.test(message));
  const category = contextLength ? 'context_length' : status === 429 ? 'rate_limit' : [401, 403].includes(status) ? 'auth' : [400, 404, 413, 422].includes(status) ? 'invalid_request' : 'provider';
  return { type: 'error', category, retryable: status === 429 || status >= 500, status, message: redact(message, key), ...(contextWindowTokens ? { contextWindowTokens } : {}) };
}
export async function* streamSse(options, url, body, signal) {
  let reader, idle = false;
  const idleMs = options.idleTimeoutMs ?? STREAM_IDLE_MS;
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason ?? new Error('cancelled'));
  if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
  // Every wait on the endpoint is bounded on its own, and cancellation cuts through any of them.
  const bounded = (promise) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { idle = true; controller.abort(new Error('provider stream idle')); reject(new Error('provider stream idle')); }, idleMs);
    const cancelled = () => reject(controller.signal.reason ?? new Error('cancelled'));
    controller.signal.addEventListener('abort', cancelled, { once: true });
    promise.then(resolve, reject).finally(() => { clearTimeout(timer); controller.signal.removeEventListener('abort', cancelled); });
  });
  try {
    const response = await bounded((options.fetchImpl ?? fetch)(url, { method: 'POST', headers: requestHeaders(options), body: JSON.stringify(body), signal: controller.signal, redirect: 'error' }));
    if (!response.ok) {
      const text = await boundedText(response, ERROR_BODY_MAX_BYTES, { truncate: true });
      yield { error: providerError(response.status, `provider returned HTTP ${response.status}: ${text}`, options.apiKey) }; return;
    }
    if (!response.body) throw new Error('empty provider response');
    const events = [];
    const parser = createSseParser(event => events.push(event));
    reader = response.body.getReader();
    let bytes = 0;
    for (;;) {
      const { value, done } = await bounded(reader.read());
      if (done) parser.end();
      else {
        bytes += value.byteLength;
        if (bytes > RESPONSE_MAX_BYTES) { yield { error: { type: 'error', category: 'limit', retryable: false, message: 'provider response exceeded 8 MiB' } }; return; }
        parser.push(value);
      }
      for (const event of events.splice(0)) {
        if (event.event === 'parse_error') { yield { error: { type: 'error', category: 'invalid_response', retryable: false, message: 'provider sent malformed JSON' } }; return; }
        yield event;
      }
      if (done) break;
    }
  } catch (error) {
    const category = signal?.aborted ? 'cancelled' : idle ? 'network' : error.category ?? (/exceed|limit/i.test(error.message) ? 'limit' : 'network');
    const message = idle ? `provider sent nothing for ${Math.round(idleMs / 1000)} seconds` : error.message;
    yield { error: { type: 'error', category, retryable: category === 'network', message: redact(message, options.apiKey) } };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (reader) await reader.cancel().catch(() => {});
  }
}
export const incompleteStream = () => ({ type: 'error', category: 'network', retryable: true, message: 'stream ended without a completion event' });
export function parseArguments(raw) {
  if (typeof raw !== 'string') return raw ?? {};
  try { return JSON.parse(raw); } catch { return { __invalid_json: raw.slice(0, 1000) }; }
}
