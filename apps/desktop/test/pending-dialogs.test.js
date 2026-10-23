import { expect, test } from 'bun:test';
import { PendingDialogs } from '../src/renderer/pending-dialogs.js';

const dialog = (dialogId, runId = 'run') => ({ dialogId, runId, tool: 'AskUserQuestion', input: { questions: [] }, toolUseId: null });
const event = (seq, type, payload, runId = 'run') => ({ eventSeq: String(seq), type, payload, runId });

test('reopening a session restores its unanswered dialogs', () => {
  const queue = new PendingDialogs();
  queue.seed([dialog('first'), dialog('second')], '10');
  expect(queue.first.dialogId).toBe('first');
  queue.remove('first');
  expect(queue.first.dialogId).toBe('second');
});

test('an answer arriving during snapshot loading cannot resurrect an old dialog', () => {
  const queue = new PendingDialogs();
  queue.apply(event(12, 'dialog.resolved', { dialogId: 'old', state: 'answered' }));
  queue.apply(event(13, 'dialog.requested', dialog('new')));
  queue.seed([dialog('old')], '10');
  expect([...queue.requests.keys()]).toEqual(['new']);
  queue.apply(event(9, 'dialog.requested', dialog('old')));
  expect([...queue.requests.keys()]).toEqual(['new']);
});

test('a cancelled run clears its dialogs without clearing another run', () => {
  const queue = new PendingDialogs();
  queue.seed([dialog('first'), dialog('second', 'other')], '10');
  queue.apply(event(11, 'run.state', { state: 'cancelled' }));
  expect(queue.first).toEqual(dialog('second', 'other'));
});

test('Review Focus 5: a run cancelled before the snapshot was read clears its dialog', () => {
  const queue = new PendingDialogs();
  queue.apply(event(11, 'run.state', { state: 'cancelled' }));
  queue.seed([dialog('first')], '10');
  expect(queue.first).toBeNull();
});

test('a cancelled dialog leaves the queue', () => {
  const queue = new PendingDialogs();
  queue.seed([dialog('first')], '10');
  queue.apply(event(11, 'dialog.resolved', { dialogId: 'first', state: 'cancelled' }));
  expect(queue.first).toBeNull();
});
