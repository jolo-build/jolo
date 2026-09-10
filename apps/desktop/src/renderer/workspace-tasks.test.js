import { expect, test } from 'bun:test';
import { readWorkspaceTasks } from './workspace-tasks.js';

test('workspace task loading uses its own cursor and refreshes every loaded page', async () => {
  const calls = [];
  const before = { updatedAt: '2026-09-10T00:00:00.000Z', sessionId: 'b' };
  let archived = false;
  const call = async (method, params) => {
    calls.push({ method, ...params });
    return params.before ? { tasks: [{ sessionId: 'a' }], hasMore: false, nextCursor: null }
      : { tasks: archived ? [{ sessionId: 'b' }] : [{ sessionId: 'c' }, { sessionId: 'b' }], hasMore: true, nextCursor: before };
  };
  expect(await readWorkspaceTasks(call, 'folder', 1)).toMatchObject({ hasMore: true, tasks: [{ sessionId: 'c' }, { sessionId: 'b' }] });
  archived = true;
  expect(await readWorkspaceTasks(call, 'folder', 2)).toEqual({ hasMore: false, tasks: [{ sessionId: 'b' }, { sessionId: 'a' }] });
  expect(calls[2]).toEqual({ method: 'board.tasks', workspaceId: 'folder', limit: 100, before });
});

test('page failures remain visible to the task list for retry', async () => {
  await expect(readWorkspaceTasks(async () => { throw new Error('offline'); }, 'folder')).rejects.toThrow('offline');
});
