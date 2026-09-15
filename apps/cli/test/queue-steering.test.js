import { expect, test } from 'bun:test';
import { createQueueSteering } from '../src/tui/queue-steering.js';

test('double Enter promotes exactly the queued request even before its response arrives', async () => {
  const sent = [];
  const { promise: operation, resolve } = Promise.withResolvers();
  const steering = createQueueSteering(id => sent.push(id));
  steering.remember(operation, 'follow-up');
  const promoted = steering.steer('follow-up'); // React may still expose the original draft.
  expect(sent).toEqual([]);
  expect(steering.steer('')).toBeNull();
  resolve({ id: 'queued-1' });
  await promoted;
  expect(sent).toEqual(['queued-1']);
});

test('late Enter, edited drafts, and cleared candidates cannot interrupt a turn', async () => {
  let time = 0;
  const sent = [];
  const steering = createQueueSteering(id => sent.push(id), () => time);
  const operation = Promise.resolve({ id: 'queued' });
  steering.remember(operation, 'follow-up'); time = 501;
  expect(steering.steer('')).toBeNull();
  steering.remember(operation, 'follow-up');
  expect(steering.steer('edited')).toBeNull();
  steering.remember(operation, 'follow-up'); steering.clear();
  expect(steering.steer('')).toBeNull();
  expect(sent).toEqual([]);
  steering.remember(operation, 'follow-up'); time += 500;
  await steering.steer('');
  expect(sent).toEqual(['queued']);
});

test('failed queue creation is surfaced without sending an unrelated run now', async () => {
  const sent = [];
  const steering = createQueueSteering(id => sent.push(id));
  steering.remember(Promise.reject(new Error('queue full')), 'follow-up');
  await expect(steering.steer('')).rejects.toThrow('queue full');
  expect(sent).toEqual([]);
});
