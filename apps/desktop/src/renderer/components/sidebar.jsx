import { useEffect, useMemo, useState } from 'react';
import { relativeTime, RUNNING } from '@jolo/client/board';
import { Icon } from './icon.jsx';
import { basename } from '../presentation.js';
import { useWorkspaceTasks } from '../use-workspace-tasks.js';
import { useTaskDrag } from '../task-drag.jsx';
import { RecentChats } from './recent-chats.jsx';

function taskStatus(task) {
  if (task.attention === 'needs_you') return task.run?.state === 'failed' ? 'Failed' : 'Needs you';
  if (task.run && RUNNING.has(task.run.state)) return 'Working';
  if (task.run?.state === 'cancelled') return 'Stopped';
  return task.run ? 'Done' : 'Ready';
}

export function SidebarTask({ task, dragTask, selected, onOpen, onMenu, agentName }) {
  const drag = useTaskDrag();
  return <div className={`task-row${selected ? ' selected' : ''}`} onContextMenu={event => { event.preventDefault(); onMenu(task); }}
    onKeyDown={event => { if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') { event.preventDefault(); onMenu(task); } }}>
    <button className="task" {...drag(dragTask)} data-session-id={task.sessionId} aria-current={selected ? 'page' : undefined} onClick={() => onOpen(task)}>
      <span className="task-title">{task.title || 'New task'}</span>
      <span className="meta"><span className="task-progress"><span className={`task-state ${task.attention === 'needs_you' ? 'needs' : ''}`}>{taskStatus(task)}</span><span className="task-time">{relativeTime(task.updatedAt)}</span></span>{task.agentId && <span className="branch-tag" title={agentName(task.agentId)}>{agentName(task.agentId)}</span>}</span>
    </button>
    <button className="task-more" onClick={() => onMenu(task)} aria-label={`Options for ${task.title || 'New task'}`}><Icon name="more" size={13} /></button>
  </div>;
}

function WorkspaceChats({ row, revision, call, state, selectedTask, sessionId, onOpen, onMenu, agentName }) {
  const { result, loading, error, retry, loadMore } = useWorkspaceTasks({ call, workspaceId: row.workspaceId, revision, state });
  const tasks = result?.tasks ?? [];
  // Keep an explicitly opened older chat selected even before its page is loaded.
  const rows = selectedTask && !tasks.some(task => task.sessionId === selectedTask.sessionId) ? [selectedTask, ...tasks] : tasks;
  return <div className="sidebar-workspace-chats" id={`sidebar-chats-${row.workspaceId}`}>
    {rows.map(task => <SidebarTask key={task.sessionId} task={task} dragTask={{ ...row, session: { id: task.sessionId, title: task.title }, historyState: state }} selected={sessionId === task.sessionId} onOpen={onOpen} onMenu={onMenu} agentName={agentName} />)}
    {error && <div className="sidebar-empty" role="alert">{error}<button onClick={retry}>Retry</button></div>}
    {!result && loading && <p className="sidebar-empty" role="status">Loading tasks…</p>}
    {result && !rows.length && !loading && !error && <p className="sidebar-empty">{state === 'archived' ? 'No archived tasks.' : 'No tasks yet.'}</p>}
    {result?.hasMore && <button className="sidebar-load-more" disabled={loading} onClick={loadMore}>{loading ? 'Loading…' : 'Load more tasks'}</button>}
  </div>;
}

export function Sidebar({ project, sessions = [], sessionId, workspaceId, lastRun, board, visible = true, call, agentName = id => id, onOpenFolder, onNewChat, onNewSession, onNewWorktree, onNewWorkspaceTask, onOpenTask, onSettings, onTaskMenu, onError, historyState = 'open', onHistory }) {
  const [expanded, setExpanded] = useState(() => new Set(workspaceId ? [workspaceId] : []));
  const rows = useMemo(() => (board?.projects ?? []).filter(row => !row.standalone).sort((a, b) => a.workspace.path.localeCompare(b.workspace.path)), [board]);
  const archived = historyState === 'archived';
  useEffect(() => { if (workspaceId) setExpanded(current => new Set([...current, workspaceId])); }, [workspaceId, sessionId]);
  const selected = sessions.find(session => session.id === sessionId && session.state === historyState);
  const selectedTask = selected ? { sessionId: selected.id, title: selected.title, agentId: selected.agentId, workspaceId: selected.workspaceId,
    updatedAt: lastRun?.updatedAt ?? selected.updatedAt, run: lastRun, attention: lastRun && ['paused', 'failed', 'interrupted', 'awaiting_permission'].includes(lastRun.state) ? 'needs_you' : 'idle' } : null;
  const toggle = id => setExpanded(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const menu = async task => {
    try { const { session } = await call('session.page', { sessionId: task.sessionId, limit: 1 }); await onTaskMenu(session); }
    catch (error) { onError?.(error.message); }
  };
  return <aside className="sidebar" aria-label="Workspace navigation">
    <div className="new-task-row">
      <button className="new-chat" onClick={onNewChat}><Icon name="edit" size={14} />New chat</button>
      {project && !project.standalone && <button className="new-task" onClick={onNewSession} title="New task in this workspace" aria-label="New task in this workspace"><Icon name="plus" size={14} /></button>}
      {project && !project.standalone && <button className="new-task-alt" onClick={onNewWorktree} title="New task in a worktree" aria-label="New task in a worktree"><Icon name="branch" size={14} /></button>}
    </div>
    <div className="task-tabs" role="tablist" aria-label="Workspace tasks" onKeyDown={event => {
      if (event.target.getAttribute('role') !== 'tab' || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? false : event.key === 'End' ? true : !archived;
      event.currentTarget.querySelectorAll('[role="tab"]')[next ? 1 : 0].focus();
      onHistory(next ? 'archived' : 'open');
    }}>
      <button id="open-tasks-tab" className={!archived ? 'selected' : ''} role="tab" aria-selected={!archived} aria-controls="sidebar-task-list" tabIndex={archived ? -1 : 0} onClick={() => { if (archived) onHistory('open'); }}>Workspaces<span className="task-tab-count">{rows.length}</span></button>
      <button id="archived-tasks-tab" className={archived ? 'selected' : ''} role="tab" aria-selected={archived} aria-controls="sidebar-task-list" tabIndex={archived ? 0 : -1} onClick={() => { if (!archived) onHistory('archived'); }}>Archive</button>
    </div>
    <nav className="task-list" id="sidebar-task-list" role="tabpanel" aria-labelledby={archived ? 'archived-tasks-tab' : 'open-tasks-tab'}>
      {rows.map(row => {
        const name = basename(row.workspace.path) || row.name;
        const open = expanded.has(row.workspaceId);
        const working = !archived && (row.working ?? row.attention === 'running');
        return <div className="sidebar-workspace" key={row.workspaceId} data-workspace-id={row.workspaceId}>
          <div className={`sidebar-workspace-heading${workspaceId === row.workspaceId ? ' current' : ''}`}>
            <button className="sidebar-workspace-toggle" onClick={() => toggle(row.workspaceId)} aria-expanded={open} aria-controls={open ? `sidebar-chats-${row.workspaceId}` : undefined} aria-label={`${open ? 'Hide' : 'Show'} tasks in ${name}`} title={row.workspace.path}>
              <Icon name="chevron" size={12} /><span className={`workspace-folder${working ? ' working' : ''}`} role={working ? 'img' : undefined} aria-label={working ? 'Tasks working' : undefined}><Icon name="folder" size={15} /></span><span className="sidebar-workspace-name">{name}</span>
              {row.attention === 'needs_you' && !archived && <span className="workspace-attention" aria-label="Needs attention">●</span>}
              {!archived && row.taskCount !== undefined && <span className="task-tab-count">{row.taskCount}</span>}
            </button>
            {!archived && <button className="sidebar-workspace-new" onClick={() => onNewWorkspaceTask(row)} aria-label={`New task in ${name}`} title={`New task in ${name}`}><Icon name="plus" size={13} /></button>}
          </div>
          {open && visible && <WorkspaceChats key={historyState} row={row} revision={board?.generatedAt} call={call} state={historyState} selectedTask={selectedTask?.workspaceId === row.workspaceId ? selectedTask : null} sessionId={sessionId} agentName={agentName} onMenu={menu} onOpen={task => onOpenTask({ ...row, session: { id: task.sessionId }, historyState })} />}
        </div>;
      })}
      {!rows.length && <p className="sidebar-empty">{board ? 'No workspaces yet.' : 'Loading workspaces…'}</p>}
      {visible && <RecentChats key={`recents-${historyState}`} call={call} revision={board?.generatedAt} state={historyState} sessionId={sessionId}
        selectedTask={project?.standalone && selectedTask ? { ...selectedTask, projectId: project.projectId, rootPath: project.rootPath, standalone: true } : null} onOpen={onOpenTask} onMenu={menu} />}
    </nav>
    <div className="side-bottom"><button className="sidebar-open-folder" onClick={onOpenFolder}><Icon name="folder" size={15} />Open folder</button><button className="settings-link" onClick={onSettings}><Icon name="settings" />Settings</button></div>
  </aside>;
}
