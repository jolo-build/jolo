// Each folder has its own cursor; a busy workspace cannot hide another folder's chats.
export async function readWorkspaceTasks(call, workspaceId, pages = 1, state = 'open', standalone, pinned) {
  const tasks = new Map();
  let before, result;
  for (let index = 0; index < pages; index++) {
    result = await call('board.tasks', { workspaceId, limit: 100, ...(standalone !== undefined ? { standalone } : {}), ...(pinned !== undefined ? { pinned } : {}), ...(state !== 'open' ? { state } : {}), ...(before ? { before } : {}) });
    for (const task of result.tasks) tasks.set(task.sessionId, task);
    if (!result.hasMore || !result.nextCursor) break;
    before = result.nextCursor;
  }
  return { tasks: [...tasks.values()], hasMore: Boolean(result?.hasMore && result?.nextCursor) };
}

/**
 * The chats the sidebar lists: each one that has been written to, the open one, and the newest one not yet written to,
 * which another pane may have open. Older unwritten chats are left out rather than piling up as identical rows.
 */
export function sidebarChats(tasks, sessionId) {
  const newestUnwritten = tasks.filter((task) => !task.run).reduce((newest, task) => (!newest || String(task.updatedAt) > String(newest.updatedAt) ? task : newest), null);
  return tasks.filter((task) => task.run || task.sessionId === sessionId || task === newestUnwritten);
}

/**
 * The open conversation's family: the child tasks it started, directly or through its children, and, when it is a
 * child itself, the top-level task that started it.
 * @returns {{ children: any[], parent: any | null }}
 */
export function taskFamily(tasks, sessionId) {
  const tree = taskTree(tasks);
  const parentId = [...tree.children].find(([, list]) => list.some((task) => task.sessionId === sessionId))?.[0] ?? null;
  return { children: tree.children.get(sessionId) ?? [], parent: parentId ? tasks.find((task) => task.sessionId === parentId) ?? null : null };
}

/** A tree without its pinned tasks, which the sidebar lists in a section of their own; a pinned task's children go with it. */
export function unpinnedTree(tree) {
  return { roots: tree.roots.filter((task) => !task.pinnedAt), children: new Map([...tree.children].map(([id, list]) => [id, list.filter((task) => !task.pinnedAt)])) };
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
