import { expect, test } from 'bun:test';
import { SessionProjection } from '@jolo/client/projection';
import { SessionHistory } from './session-history.js';

const messages = Array.from({ length: 388 }, (_, ordinal) => ({ id: `m${ordinal}`, artifactId: `m${ordinal}`, ordinal, role: 'assistant', kind: 'text', status: 'complete', committedBytes: 4 }));
const page = (before = 388) => ({ messages: messages.slice(Math.max(0, before - 100), before), hasOlder: before > 100, cursor: '10' });
function fixture(call, isCurrent = () => true) {
  const projection = new SessionProjection({ readArtifact: async () => ({ text: 'body', bytes: 4 }) });
  projection.seed(page());
  const history = new SessionHistory({ sessionId: 's', projection, call, isCurrent, onChange() {} });
  history.seed(page());
  return { projection, history };
}

test('all 388 saved entries can be paged back to the first request', async () => {
  const requests = [];
  const { projection, history } = fixture(async (method, params) => { requests.push({ method, ...params }); return page(params.beforeOrdinal); });
  while (history.hasOlder) await history.loadOlder();
  expect(requests.map(r => r.beforeOrdinal)).toEqual([288, 188, 88]);
  expect(projection.ordered().map(m => m.ordinal)).toEqual(messages.map(m => m.ordinal));
  expect(projection.ordered().slice(0, 288).every(m => m.text === 'body')).toBe(true);
  await history.loadOlder();
  expect(requests).toHaveLength(3);
});

test('paging does not swallow live messages covered by the newer snapshot cursor', async () => {
  const { projection, history } = fixture(async () => ({ ...page(288), cursor: '20', runs: [{ id: 'r', state: 'completed' }] }));
  await history.loadOlder();
  expect(projection.lastSeq).toBe('10');
  projection.applyEvent({ eventSeq: '11', type: 'message.started', runId: 'r', payload: { messageId: 'live', ordinal: 388, role: 'assistant', artifactId: 'live' } });
  expect(projection.messages.has('live')).toBe(true);
  expect(projection.runs.size).toBe(0);
});

test('duplicate scroll events share one request and a failed page can be retried', async () => {
  let reject, calls = 0;
  const { projection, history } = fixture(async () => {
    if (++calls === 1) return new Promise((_, fail) => { reject = fail; });
    return page(288);
  });
  const pending = history.loadOlder();
  await history.loadOlder();
  expect(calls).toBe(1);
  reject(new Error('offline'));
  await pending;
  expect(history).toMatchObject({ error: 'offline', hasOlder: true, loading: false, beforeOrdinal: 288 });
  expect(projection.messages.size).toBe(100);
  await history.loadOlder();
  expect(history.error).toBeNull();
  expect(projection.messages.size).toBe(200);
});

test('switching tasks discards an in-flight older page', async () => {
  let resolve, current = true;
  const { projection, history } = fixture(() => new Promise(done => { resolve = done; }), () => current);
  const pending = history.loadOlder();
  current = false;
  resolve(page(288));
  await pending;
  expect(projection.messages.size).toBe(100);
  expect(history.loading).toBe(false);
});
