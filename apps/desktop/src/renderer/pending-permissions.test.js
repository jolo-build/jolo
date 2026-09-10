import { expect, test } from 'bun:test';
import { PendingPermissions } from './pending-permissions.js';

const request = (permissionId, runId = 'run') => ({ permissionId, runId });
const event = (seq, type, payload, runId = 'run') => ({ eventSeq: String(seq), type, payload, runId });

test('reopening a session restores its unanswered requests', () => {
  const queue = new PendingPermissions();
  queue.seed([request('first'), request('second')], '10');
  expect(queue.first.permissionId).toBe('first');
  queue.remove('first');
  expect(queue.first.permissionId).toBe('second');
});

test('a decision arriving during snapshot loading cannot resurrect an old approval', () => {
  const queue = new PendingPermissions();
  queue.apply(event(12, 'permission.resolved', { permissionId: 'old' }));
  queue.apply(event(13, 'permission.requested', request('new')));
  queue.seed([request('old')], '10');
  expect([...queue.requests.keys()]).toEqual(['new']);
  queue.apply(event(9, 'permission.requested', request('old')));
  expect([...queue.requests.keys()]).toEqual(['new']);
});

test('a cancelled run clears its requests without clearing another run', () => {
  const queue = new PendingPermissions();
  queue.seed([request('first'), request('second', 'other')], '10');
  queue.apply(event(11, 'run.state', { state: 'cancelled' }));
  expect(queue.first).toEqual(request('second', 'other'));
});

test('cancellation arriving during snapshot loading still clears the request', () => {
  const queue = new PendingPermissions();
  queue.apply(event(11, 'run.state', { state: 'cancelled' }));
  queue.seed([request('first')], '10');
  expect(queue.first).toBeNull();
});
