// Each folder has its own cursor; a busy workspace cannot hide another folder's chats.
export async function readWorkspaceTasks(call, workspaceId, pages = 1, state = 'open', standalone) {
  const tasks = new Map();
  let before, result;
  for (let index = 0; index < pages; index++) {
    result = await call('board.tasks', { workspaceId, limit: 100, ...(standalone !== undefined ? { standalone } : {}), ...(state !== 'open' ? { state } : {}), ...(before ? { before } : {}) });
    for (const task of result.tasks) tasks.set(task.sessionId, task);
    if (!result.hasMore || !result.nextCursor) break;
    before = result.nextCursor;
  }
  return { tasks: [...tasks.values()], hasMore: Boolean(result?.hasMore && result?.nextCursor) };
}
