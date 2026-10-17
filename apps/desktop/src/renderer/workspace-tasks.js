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

/**
 * A task list as a tree one level deep: each child task under the top-level conversation that started it, directly or
 * through another child task, so the narrow sidebar never nests twice. A child whose parent is not in the list (an
 * older page, or a deleted parent) stays a row of its own, so it is never lost.
 * @returns {{ roots: any[], children: Map<string, any[]> }}
 */
export function taskTree(tasks) {
  const listed = new Map(tasks.map((task) => [task.sessionId, task]));
  const rootOf = (task) => (listed.has(task.parentSessionId) ? rootOf(listed.get(task.parentSessionId)) : task);
  const children = new Map();
  for (const task of tasks) {
    const root = rootOf(task);
    if (root !== task) children.set(root.sessionId, [...(children.get(root.sessionId) ?? []), task]);
  }
  return { roots: tasks.filter((task) => rootOf(task) === task), children };
}
