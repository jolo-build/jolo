import { expect, test } from 'bun:test';
import { stopAndDeleteSession } from '../src/renderer/session-actions.js';

test('deletion stops older paused turns even when the latest turn is stopped', async () => {
  const runs = [{ id: 'old', state: 'paused' }, { id: 'latest', state: 'cancelled' }, { id: 'queued', state: 'queued' }];
  const cancelled = [];
  let deleted = false;
  await stopAndDeleteSession(async (method, params) => {
    if (method === 'session.page') return { session: { revision: cancelled.length + 1 }, runs };
    if (method === 'run.cancel') { cancelled.push(params.runId); runs.find(r => r.id === params.runId).state = 'cancelled'; return; }
    expect(method).toBe('session.delete');
    expect(params).toEqual({ sessionId: 'chat', expectedRevision: 3 });
    expect(runs.every(r => r.state === 'cancelled')).toBe(true);
    deleted = true;
  }, 'chat');
  expect(cancelled).toEqual(['queued', 'old']);
  expect(deleted).toBe(true);
});

test('deletion waits for active cancellation to settle', async () => {
  let stopping = false, reads = 0, deleted = false;
  await stopAndDeleteSession(async (method) => {
    if (method === 'session.page') return { session: { revision: 1 }, runs: [{ id: 'active', state: stopping ? ++reads > 1 ? 'cancelled' : 'cancelling' : 'model' }] };
    if (method === 'run.cancel') { stopping = true; return; }
    expect(reads).toBe(2); deleted = true;
  }, 'chat');
  expect(deleted).toBe(true);
});

test('a failed cancellation does not delete a live task', async () => {
  let deleted = false;
  const call = async method => {
    if (method === 'session.page') return { session: { revision: 1 }, runs: [{ id: 'active', state: 'model' }] };
    if (method === 'run.cancel') throw new Error('could not stop');
    if (method === 'run.snapshot') return { run: { state: 'model' } };
    deleted = true;
  };
  await expect(stopAndDeleteSession(call, 'chat')).rejects.toThrow('could not stop');
  expect(deleted).toBe(false);
});
