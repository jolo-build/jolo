import { useState } from 'react';
import { createPortal } from 'react-dom';
import { RUNNING } from '@jolo/client/board';
import { useWorkspaceTasks } from '../use-workspace-tasks.js';

export function TaskRail({ call, revision, sessionId, onOpen }) {
  const { result, error, retry, loadMore, loading } = useWorkspaceTasks({ call, revision });
  const [hover, setHover] = useState(null);
  const rows = result?.tasks ?? [];
  return <nav className="task-rail" aria-label="Switch tasks and chats">
    <div className="task-rail-marks">{rows.map(task => {
      const working = RUNNING.has(task.run?.state);
      const attention = task.attention === 'needs_you';
      const status = attention ? 'Needs attention' : working ? 'Working' : task.run?.state === 'completed' ? 'Completed' : 'Ready';
      const title = task.title || (task.standalone ? 'New chat' : 'New task');
      const reveal = event => { const rect = event.currentTarget.getBoundingClientRect(); setHover({ id: task.sessionId, title, workspace: task.standalone ? 'Chat' : task.projectName, status, right: rect.right, top: rect.top }); };
      return <button key={task.sessionId} type="button" data-task-id={task.sessionId} aria-label={`${title} · ${status}`} aria-current={sessionId === task.sessionId ? 'page' : undefined} className={`${working ? 'working' : ''}${attention ? ' attention' : ''}`} onMouseEnter={reveal} onMouseLeave={() => setHover(null)} onFocus={reveal} onBlur={() => setHover(null)} onClick={() => { setHover(null); onOpen({ ...task, session: { id: task.sessionId }, historyState: 'open' }); }}><span className="task-rail-mark" />{(working || attention) && <i />}</button>;
    })}
    {error ? <button type="button" title={error} aria-label="Retry loading task switcher" onClick={retry}>!</button> : result?.hasMore && <button type="button" aria-label="Load more tasks" disabled={loading} onClick={loadMore}>…</button>}
    </div>
    {hover && createPortal(<div className="task-rail-tooltip" role="tooltip" style={{ left: `${Math.max(8, Math.min(hover.right + 10, window.innerWidth - 284))}px`, top: `${Math.max(8, Math.min(hover.top - 8, window.innerHeight - 82))}px` }}><strong>{hover.title}</strong><span>{hover.workspace} · {hover.status}</span></div>, document.body)}
  </nav>;
}
