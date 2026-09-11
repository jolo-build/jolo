import { expect, test } from 'bun:test';
import { connectResumable } from '../src/reconnect.js';

function connection(stream = 'db1', statusCursor = '0') {
  const listeners = {}, subscriptions = [], calls = [];
  let closed = false;
  return {
    hello: { eventStreamId: stream }, subscriptions, calls,
    get closed() { return closed; },
    onClose(fn) { listeners.close = fn; }, onEvent(fn) { listeners.event = fn; },
    onPreview(fn) { listeners.preview = fn; }, onNotification() {},
    async call(method, params) { calls.push({ method, params }); return { cursor: statusCursor }; },
    async subscribe(params) { subscriptions.push(params); return { subscribed: true }; },
    event(seq) { listeners.event?.({ eventSeq: seq }); },
    drop() { closed = true; listeners.close?.(new Error('lost connection')); },
    async close() { closed = true; },
  };
}
async function until(fn) { for (let i = 0; i < 100 && !fn(); i++) await Bun.sleep(5); expect(Boolean(fn())).toBe(true); }

test('reconnect resumes the observed cursor without replaying calls', async () => {
  const first = connection(), next = connection(); let opens = 0;
  const client = await connectResumable({ open: async () => ++opens === 1 ? first : next, retryBaseMs: 1 });
  try {
    const seen = []; client.onEvent(e => seen.push(e.eventSeq));
    await client.subscribe({ after: '8', sessionId: 'session' });
    first.event('12');
    await client.call('run.start', { prompt: 'once' });
    first.drop();
    await until(() => next.subscriptions.length);
    expect(next.subscriptions[0]).toEqual({ after: '12', sessionId: 'session' });
    expect(next.calls).toEqual([]);
    next.event('13'); expect(seen).toEqual(['12', '13']);
  } finally { await client.close(); }
});

test('a replaced database resets the cursor and requests a snapshot', async () => {
  const first = connection(), next = connection('db2', '3'); let opens = 0; const resets = [];
  const client = await connectResumable({ open: async () => ++opens === 1 ? first : next, retryBaseMs: 1, onResync: info => resets.push(info) });
  try {
    await client.subscribe({ after: '90' }); first.drop();
    await until(() => next.subscriptions.length);
    expect(resets).toEqual([{ cursor: '3', streamId: 'db2' }]);
    expect(next.subscriptions[0].after).toBe('3');
  } finally { await client.close(); }
});

test('authentication and version failures stop automatic reconnect', async () => {
  const first = connection(); let opens = 0;
  const client = await connectResumable({ open: async () => { if (++opens === 1) return first; throw Object.assign(new Error('incompatible engine'), { code: 'version_mismatch' }); }, retryBaseMs: 1 });
  try {
    await client.subscribe(); first.drop();
    await until(() => opens === 2); await Bun.sleep(30);
    expect(opens).toBe(2);
    await expect(client.call('engine.status', {})).rejects.toMatchObject({ code: 'version_mismatch' });
  } finally { await client.close(); }
});
