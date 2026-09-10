import { useEffect, useState } from "react";
import { Icon } from "./icon.jsx";
import { JoloMark } from "./brand.jsx";
import { branchLabel, relativeTime, stateLabel, summaryLine } from "@jolo/client/board";
import { basename } from '../presentation.js';
import { useWorkspaceTasks } from '../use-workspace-tasks.js';
import { useTaskDrag } from '../task-drag.jsx';
import { RecentChats } from './recent-chats.jsx';

const capitalize = text => text.charAt(0).toUpperCase() + text.slice(1);
const chipClass = row => row.attention === 'needs_you' ? 'chip needs' : row.attention === 'running' ? 'chip running' : row.reason === 'completed' ? 'chip good' : 'chip';

function ProjectStatus({ row }) {
  const state = row.run?.state;
  const status = row.pendingPermission || state === "awaiting_permission" || state === "paused" && row.run.pauseReason === "permission" ? "attention"
    : ["preparing", "model", "tools", "cancelling"].includes(state) ? "running"
    : state === "completed" ? "done"
    : state === "failed" ? "failed"
    : state === "paused" || state === "interrupted" ? "paused"
    : state === "cancelled" ? "stopped"
    : state === "queued" ? "queued" : "ready";
  return <span className={`board-progress ${status}`} aria-hidden="true">
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle className="board-progress-track" cx="12" cy="12" r="9" />
      {status === "running" && <circle className="board-progress-arc" cx="12" cy="12" r="9" strokeDasharray="19 38" />}
      {status === "done" && <path d="m8 12 2.6 2.6L16 9" />}
      {status === "attention" && <path d="M12 7.5v5M12 16h.01" />}
      {status === "failed" && <path d="m9 9 6 6m0-6-6 6" />}
      {status === "paused" && <path d="M9.5 8.5v7m5-7v7" />}
      {status === "stopped" && <rect x="9" y="9" width="6" height="6" rx=".6" fill="currentColor" stroke="none" />}
    </svg>
  </span>;
}


function WorkspaceTasks({ row, revision, now, call, onOpen }) {
  const drag = useTaskDrag();
  const { result, loading, error, retry, loadMore } = useWorkspaceTasks({ call, workspaceId: row.workspaceId, revision });
  return <div className="board-workspace-tasks" id={`workspace-tasks-${row.workspaceId}`} role="region" aria-label={`Tasks in ${basename(row.workspace.path)}`}>
    {error && <div className="board-task-feedback" role="alert">{error}<button onClick={retry}>Retry</button></div>}
    {!result && loading && <p className="board-task-feedback" role="status">Loading tasks…</p>}
    {result?.tasks.length === 0 && !loading && !error && <p className="board-task-feedback">No tasks yet. Create a new task to start a chat in this workspace.</p>}
    {result?.tasks.length > 0 && <ul className="board-task-list">{result.tasks.map(task => <li key={task.sessionId}>
      <button className="board-task" {...drag({ ...row, session: { id: task.sessionId, title: task.title } })} data-session-id={task.sessionId} onClick={() => onOpen({ ...row, session: { id: task.sessionId, title: task.title }, run: task.run })}>
        <ProjectStatus row={task} />
        <span className="board-task-title">{task.title || 'New task'}</span>
        <span className={chipClass(task)}>{['preparing', 'model', 'tools'].includes(task.run?.state) ? 'Working' : task.run ? capitalize(stateLabel({ ...task, actions: [] })) : 'Ready'}</span>
        <span className="board-task-updated">{relativeTime(task.updatedAt, now)}</span>
        <Icon name="right" size={13} />
      </button>
    </li>)}</ul>}
    {result?.hasMore && <div className="board-task-feedback"><button disabled={loading} onClick={loadMore}>{loading ? 'Loading tasks…' : 'Load more tasks'}</button></div>}
  </div>;
}

export function WorkspaceRow({ row, revision, now, expanded, onToggle, onOpen, onNewTask, call }) {
  const branch = branchLabel(row);
  const name = basename(row.workspace.path) || row.name;
  const count = row.taskCount;
  const working = row.working ?? row.attention === 'running';
  return <div className={`board-card${expanded ? ' expanded' : ''}`} data-workspace-id={row.workspaceId}>
    <div className="board-row">
      <button className="board-expand" onClick={onToggle} aria-expanded={expanded} aria-controls={`workspace-tasks-${row.workspaceId}`} aria-label={`${expanded ? 'Hide' : 'Show'} tasks in ${name}`}><Icon name="chevron" size={15} /></button>
      <button className="board-project" onClick={onToggle} aria-expanded={expanded} title={row.workspace.path}>
        <span className={`workspace-folder${working ? ' working' : ''}`} role={working ? 'img' : undefined} aria-label={working ? 'Tasks working' : undefined}><Icon name="folder" size={20} /></span>
        <span className="board-title">
          <span className="board-name-line"><span className="name">{name}</span>{row.workspace.mode === 'worktree' && <span className="worktree-tag">worktree</span>}{branch !== '—' && <span className="branch" title={branch}><Icon name="branch" size={12} />{branch}</span>}</span>
          <span className="prompt">{row.workspace.path}</span>
          <span className="board-meta"><span>{count === undefined ? 'Tasks' : `${count} ${count === 1 ? 'task' : 'tasks'}`}</span>
            {working && <span className="board-workspace-activity">Working</span>}
            {row.attention === 'needs_you' && <span className="board-workspace-activity needs">Needs attention</span>}
          </span>
        </span>
      </button>
      <div className="board-actions"><button onClick={() => onNewTask(row)} aria-label={`New task in ${name}`}><Icon name="plus" size={13} />New task</button></div>
    </div>
    {expanded && <WorkspaceTasks row={row} revision={revision} now={now} call={call} onOpen={onOpen} />}
  </div>;
}

export function Board({ board, connected, onOpen, onNewTask, onNewChat, onChatMenu, onOpenFolder, call }) {
  const [now, setNow] = useState(Date.now());
  const [expanded, setExpanded] = useState(() => new Set());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(timer); }, []);
  const rows = (board?.projects ?? []).filter(row => !row.standalone).sort((a, b) => a.workspace.path.localeCompare(b.workspace.path));
  const toggle = id => setExpanded(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  return <div className="board" aria-label="Work board"><div className="board-content">
    <div className="board-head"><div><div className="eyebrow">Workspace overview</div><h1>Your workspaces<span className="board-total">{rows.length}</span></h1><p><span className={`state-dot ${connected ? '' : 'offline'}`} />{connected ? rows.length ? capitalize(summaryLine(rows)) : 'A folder for your next idea.' : 'Connecting to the engine…'}</p></div><button className="outline board-add" onClick={onOpenFolder}><Icon name="plus" size={14} />Open folder</button></div>
    <div className="board-chat-actions"><button onClick={onNewChat} className="outline" disabled={!connected}><Icon name="edit" size={15} />New chat</button><span>Start a conversation without a workspace.</span></div>
    {!rows.length && board && <div className="empty-state"><JoloMark className="welcome-mark" /><h2>Start with a chat.</h2><p>You can also open a folder when you want to work on a project.</p></div>}
    {rows.length > 0 && <div className="board-list">{rows.map(row => <WorkspaceRow key={row.workspaceId} row={row} revision={board.generatedAt} now={now} expanded={expanded.has(row.workspaceId)} onToggle={() => toggle(row.workspaceId)} onOpen={onOpen} onNewTask={onNewTask} call={call} />)}</div>}
    <RecentChats call={call} revision={board?.generatedAt} onOpen={onOpen} onMenu={onChatMenu} />
  </div></div>;
}
