import { RUNNING, relativeTime } from '@jolo/client/board';
import { useWorkspaceTasks } from '../use-workspace-tasks.js';
import { useTaskDrag } from '../task-drag.jsx';
import { Icon } from './icon.jsx';
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
 *   variant?: 'board',
 *   now?: number,
 *   agentName?: (id: string) => string,
 * }} props the board and sidebar share chat identity, status, and activity dates.
 */
export function RecentChats({ call, revision, state = 'open', sessionId, selectedTask, onOpen, onMenu, variant, now, agentName }) {
  const { result, loading, error, retry, loadMore } = useWorkspaceTasks({ call, revision, state, standalone: true });
  const drag = useTaskDrag();
  const tasks = result?.tasks ?? [];
  const rows = selectedTask && !tasks.some(task => task.sessionId === selectedTask.sessionId) ? [selectedTask, ...tasks] : tasks;
  return <section className="recent-chats" aria-label={state === 'archived' ? 'Archived chats' : 'Recent chats'}>
    {variant === 'board' ? <div className="board-section-heading"><h2>Chats</h2><span>Outside workspaces</span></div> : <h2>{state === 'archived' ? 'Archived chats' : 'Chats'}</h2>}
    {rows.map(task => {
      const target = { ...task, session: { id: task.sessionId }, historyState: state };
      if (variant !== 'board') return <SidebarChatRow key={task.sessionId} task={task} target={target} selected={sessionId === task.sessionId} onOpen={() => onOpen(target)} onMenu={onMenu} agentName={agentName} standalone />;
      return <div key={task.sessionId} className={`recent-chat-row${sessionId === task.sessionId ? ' selected' : ''}`}
        onContextMenu={onMenu ? event => { event.preventDefault(); onMenu(task); } : undefined}
        onKeyDown={onMenu ? event => { if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') { event.preventDefault(); onMenu(task); } } : undefined}>
        <button className="recent-chat" {...drag(target)} data-session-id={task.sessionId} aria-current={sessionId === task.sessionId ? 'page' : undefined} onClick={() => onOpen(target)}>
          <span className="recent-chat-icon"><Icon name="chat" size={14} />
            {task.attention === 'needs_you' ? <span className="recent-chat-attention" role="img" aria-label="Needs attention">●</span> : RUNNING.has(task.run?.state) && <span className="recent-chat-working" role="img" aria-label="Working">●</span>}
          </span>
          <span className="recent-chat-title" title={task.title || 'New chat'}>{task.title || 'New chat'}</span>
          <span className={variant === 'board' ? 'board-task-updated' : 'recent-chat-time'}>{relativeTime(task.updatedAt, now)}</span>
        </button>
        {onMenu && <button className="task-more" aria-label={`Options for ${task.title || 'New chat'}`} onClick={() => onMenu(task)}><Icon name="more" size={13} /></button>}
      </div>;
    })}
    {error && <p className="sidebar-empty" role="alert">{error}<button onClick={retry}>Retry</button></p>}
    {!result && loading && <p className="sidebar-empty" role="status">Loading chats…</p>}
    {result && !rows.length && !error && <p className="sidebar-empty">{state === 'archived' ? 'No archived chats.' : 'Your chats will appear here.'}</p>}
    {result?.hasMore && <button className="sidebar-load-more" disabled={loading} onClick={loadMore}>{loading ? 'Loading…' : 'Load more chats'}</button>}
  </section>;
}
