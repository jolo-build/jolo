import { RUNNING, relativeTime } from '@jolo/client/board';
import { useWorkspaceTasks } from '../use-workspace-tasks.js';
import { useTaskDrag } from '../task-drag.jsx';
import { Icon } from './icon.jsx';

export function RecentChats({ call, revision, state = 'open', sessionId, selectedTask, onOpen, onMenu, variant, now }) {
  const { result, loading, error, retry, loadMore } = useWorkspaceTasks({ call, revision, state, standalone: true });
  const drag = useTaskDrag();
  const tasks = result?.tasks ?? [];
  const rows = selectedTask && !tasks.some(task => task.sessionId === selectedTask.sessionId) ? [selectedTask, ...tasks] : tasks;
  return <section className="recent-chats" aria-label={state === 'archived' ? 'Archived chats' : 'Recent chats'}>
    {variant === 'board' ? <div className="board-section-heading"><h2>Chats</h2><span>Outside workspaces</span></div> : <h2>{state === 'archived' ? 'Archived chats' : 'Recents'}</h2>}
    {rows.map(task => {
      const target = { ...task, session: { id: task.sessionId }, historyState: state };
      return <div key={task.sessionId} className={`recent-chat-row${sessionId === task.sessionId ? ' selected' : ''}`}
        onContextMenu={onMenu ? event => { event.preventDefault(); onMenu(task); } : undefined}>
        <button className="recent-chat" {...drag(target)} data-session-id={task.sessionId} aria-current={sessionId === task.sessionId ? 'page' : undefined} onClick={() => onOpen(target)}>
          {variant === 'board' && <Icon name="chat" size={14} />}
          <span className="recent-chat-title">{task.title || 'New chat'}</span>
          {task.attention === 'needs_you' ? <span className="recent-chat-attention" role="img" aria-label="Needs attention">●</span> : RUNNING.has(task.run?.state) && <span className="recent-chat-working" role="img" aria-label="Working">●</span>}
          {variant === 'board' && <span className="board-task-updated">{relativeTime(task.updatedAt, now)}</span>}
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
