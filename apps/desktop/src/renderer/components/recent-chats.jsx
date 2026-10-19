import { useWorkspaceTasks } from '../use-workspace-tasks.js';
import { sidebarChats, taskTree, unpinnedTree } from '../workspace-tasks.js';
import { SidebarChatRow } from './sidebar-chat-row.jsx';

/**
 * The chats that belong to no folder. Board rows arrive from the engine as validated JSON, so a task
 * is passed on as it came rather than restated here.
 *
 * @param {{
 *   call: (method: string, params?: any) => Promise<any>,
 *   revision?: string,
 *   state?: string,
 *   sessionId?: string | null,
 *   selectedTask?: any,
 *   onOpen: (target: any) => void,
 *   onMenu?: (task: any) => void,
 *   agentName?: (id: string) => string,
 * }} props
 */
export function RecentChats({ call, revision, state = 'open', sessionId, selectedTask, onOpen, onMenu, agentName }) {
  const { result, loading, error, retry, loadMore } = useWorkspaceTasks({ call, revision, state, standalone: true });
  const all = result?.tasks ?? [];
  const tree = unpinnedTree(taskTree(sidebarChats(all)));
  // The open chat joins as soon as it is sent, before the list's own copy of it has caught up.
  const rows = selectedTask?.run && !selectedTask.pinnedAt && !all.some(task => task.sessionId === selectedTask.sessionId && task.run) ? [selectedTask, ...tree.roots] : tree.roots;
  if (state !== 'archived' && !error && !rows.length && !result?.hasMore) return null;
  return <section className="recent-chats" aria-label={state === 'archived' ? 'Archived chats' : 'Recent chats'}>
    <h2>{state === 'archived' ? 'Archived chats' : 'Chats'}</h2>
    {rows.map(task => {
      const target = { ...task, session: { id: task.sessionId }, historyState: state };
      return <SidebarChatRow key={task.sessionId} task={task} target={target} selected={sessionId === task.sessionId} onOpen={() => onOpen(target)} onMenu={onMenu} agentName={agentName} standalone
        childTasks={tree.children.get(task.sessionId) ?? []} />;
    })}
    {error && <p className="sidebar-empty" role="alert">{error}<button onClick={retry}>Retry</button></p>}
    {!result && loading && <p className="sidebar-empty" role="status">Loading chats…</p>}
    {state === 'archived' && result && !rows.length && !error && <p className="sidebar-empty">No archived chats.</p>}
    {result?.hasMore && <button className="sidebar-load-more" disabled={loading} onClick={loadMore}>{loading ? 'Loading…' : 'Load more chats'}</button>}
  </section>;
}
