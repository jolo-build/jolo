import { useEffect, useState } from "react";
import { Icon } from "./icon.jsx";
import { JoloMark } from "./brand.jsx";
import { relativeTime, stateLabel, RUNNING } from "@jolo/client/board";
import { basename, workspacePath } from '../presentation.js';
import { useWorkspaceTasks } from '../use-workspace-tasks.js';
import { useTaskDrag } from '../task-drag.jsx';
import { RecentChats } from './recent-chats.jsx';

const capitalize = text => text.charAt(0).toUpperCase() + text.slice(1);
const working = row => row.working ?? RUNNING.has(row.run?.state);
const rank = row => row.attention === 'needs_you' ? 0 : working(row) ? 1 : 2;
export const workspaceOrder = (a, b) => rank(a) - rank(b) || (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? '') || a.workspace.path.localeCompare(b.workspace.path);
const initiallyExpanded = board => new Set((board?.projects ?? []).filter(row => !row.standalone && rank(row) < 2).map(row => row.workspaceId));
export function boardSummary(rows) {
  const needs = rows.filter(row => row.attention === 'needs_you').length;
  const active = rows.filter(working).length;
  const done = rows.filter(row => row.attention === 'done').length;
  return [needs && `${needs} need${needs === 1 ? 's' : ''} attention`, active && `${active} working`, done && `${done} new result${done === 1 ? '' : 's'}`].filter(Boolean).join(' · ') || 'All caught up';
}

function ProjectStatus({ row }) {
  const state = row.run?.state;
  const status = row.pendingPermission || state === "awaiting_permission" || state === "paused" && row.run.pauseReason === "permission" ? "attention"
    : state === "queued" ? "queued"
    : RUNNING.has(state) ? "running"
    : state === "completed" ? "done"
    : state === "failed" ? "failed"
    : state === "paused" || state === "interrupted" ? "paused"
    : state === "cancelled" ? "stopped"
    : "ready";
  return <span className={`board-progress ${status}`} aria-hidden="true">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
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

export function BoardTask({ task, row, now, onOpen }) {
  const drag = useTaskDrag();
  const active = RUNNING.has(task.run?.state);
  const needs = task.attention === 'needs_you';
  const label = ['preparing', 'model', 'tools'].includes(task.run?.state) ? 'Working' : task.run ? capitalize(stateLabel({ ...task, actions: [] })) : 'Ready';
  const title = task.title || 'New task';
  const target = { ...row, session: { id: task.sessionId, title: task.title }, run: task.run };
  return <button className={`board-task${active ? ' working' : ''}${needs ? ' needs' : ''}`} {...drag(target)} data-session-id={task.sessionId} aria-label={`${title}, ${label}, ${relativeTime(task.updatedAt, now)}`} onClick={() => onOpen(target)}>
    <ProjectStatus row={task} />
    <span className="board-task-title">{title}</span>
    {task.attention === 'done' && <span className="board-unread" role="img" aria-label="New result" />}
    {task.run && task.run.state !== 'completed' && <span className="board-task-state">{label}</span>}
    {!active && <span className="board-task-updated" title={relativeTime(task.updatedAt, now)}>{relativeTime(task.updatedAt, now).replace(/ ago$/, '')}</span>}
  </button>;
}

function WorkspaceTasks({ row, revision, now, call, onOpen, onNewTask }) {
  const { result, loading, error, retry, loadMore } = useWorkspaceTasks({ call, workspaceId: row.workspaceId, revision });
  const [showOlder, setShowOlder] = useState(false);
  const tasks = result?.tasks ?? [];
  // Keep work that needs attention visible even when it falls outside the recent four.
  const visible = showOlder ? tasks : tasks.filter((task, index) => index < 4 || task.attention === 'needs_you' || RUNNING.has(task.run?.state));
  const older = tasks.length - visible.length;
  return <div className="board-workspace-tasks" id={`workspace-tasks-${row.workspaceId}`} role="region" aria-label={`Tasks in ${basename(row.workspace.path)}`}>
    {error && <div className="board-task-feedback" role="alert">{error}<button onClick={retry}>Retry</button></div>}
    {!result && loading && <p className="board-task-feedback" role="status">Loading tasks…</p>}
    {result && !tasks.length && !loading && !error && <div className="board-task-feedback">No tasks yet.<button onClick={() => onNewTask(row)}><Icon name="plus" size={13} />Start a task</button></div>}
    {visible.length > 0 && <ul className="board-task-list">{visible.map(task => <li key={task.sessionId}><BoardTask task={task} row={row} now={now} onOpen={onOpen} /></li>)}</ul>}
    {(older > 0 || showOlder && tasks.length > 4) && <button className="board-show-older" aria-expanded={showOlder} onClick={() => setShowOlder(value => !value)}>{showOlder ? 'Show fewer tasks' : `Show ${older} older task${older === 1 ? '' : 's'}`}</button>}
    {result?.hasMore && (showOlder || older === 0) && <div className="board-task-feedback"><button className="board-load-more" disabled={loading} onClick={loadMore}>{loading ? 'Loading tasks…' : 'Load more tasks'}</button></div>}
  </div>;
}

export function WorkspaceRow({ row, revision, now, expanded, onToggle, onOpen, onNewTask, call, homeDirectory }) {
  const branch = row.git?.branch ? `${row.git.branch}${row.git.dirty ? ` · +${row.git.dirty}` : ''}` : null;
  const name = basename(row.workspace.path) || row.name;
  const active = working(row);
  return <div className={`board-card${expanded ? ' expanded' : ''}`} data-workspace-id={row.workspaceId}>
    <div className="board-row">
      <button className="board-expand" onClick={onToggle} aria-expanded={expanded} aria-controls={`workspace-tasks-${row.workspaceId}`} aria-label={`${expanded ? 'Hide' : 'Show'} tasks in ${name}`}><Icon name="chevron" size={14} /></button>
      <button className="board-project" onClick={onToggle} aria-expanded={expanded} title={row.workspace.path}>
        <span className={`workspace-folder${active ? ' working' : ''}`} role={active ? 'img' : undefined} aria-label={active ? 'Tasks working' : undefined}><Icon name={expanded ? "folderOpen" : "folder"} size={18} /></span>
        <span className="board-title"><span className="name">{name}</span><span className="board-task-count" aria-label={row.taskCount === undefined ? 'Tasks' : `${row.taskCount} tasks`}>{row.taskCount ?? '—'}</span>{row.workspace.mode === 'worktree' && <span className="worktree-tag">worktree</span>}<span className="board-path">{workspacePath(row.workspace.path, homeDirectory)}</span></span>
      </button>
      <div className="board-actions">
        {row.attention === 'needs_you' ? <span className="board-workspace-activity needs">Needs attention</span> : active && !expanded ? <span className="board-workspace-activity">Working</span> : row.attention === 'done' && !expanded ? <span className="board-unread" role="img" aria-label="New result" /> : null}
        {branch && <span className="board-branch" title={branch}><Icon name="branch" size={12} /><span>{branch}</span></span>}
        <button onClick={() => onNewTask(row)} aria-label={`New task in ${name}`} title={`New task in ${name}`}><Icon name="plus" size={15} /></button>
      </div>
    </div>
    {expanded && <WorkspaceTasks row={row} revision={revision} now={now} call={call} onOpen={onOpen} onNewTask={onNewTask} />}
  </div>;
}

export function Board({ board, connected, onOpen, onNewTask, onNewChat, onChatMenu, onOpenFolder, call }) {
  const [now, setNow] = useState(Date.now());
  const [homeDirectory, setHomeDirectory] = useState(null);
  useEffect(() => {
    let live = true;
    Promise.resolve(window.jolo.homeDirectory?.()).then(home => { if (live) setHomeDirectory(home); }).catch(() => {});
    return () => { live = false; };
  }, []);
  const [expanded, setExpanded] = useState(() => board ? initiallyExpanded(board) : null);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(timer); }, []);
  useEffect(() => { if (board && expanded === null) setExpanded(initiallyExpanded(board)); }, [board, expanded]);
  const rows = (board?.projects ?? []).filter(row => !row.standalone).sort(workspaceOrder);
  const open = expanded ?? initiallyExpanded(board);
  const toggle = id => setExpanded(current => { const next = new Set(current ?? open); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  return <div className="board" aria-label="Work board"><div className="board-content">
    <div className="board-head"><div><h1>Workspaces</h1><p><span className={`state-dot ${connected ? rows.some(working) ? 'working' : '' : 'offline'}`} />{connected ? rows.length ? boardSummary(rows) : 'A place for your next idea.' : 'Connecting to the engine…'}</p></div><div className="board-head-actions"><button className="outline board-add" onClick={onOpenFolder}><Icon name="folderPlus" size={16} />Open folder</button><div className="board-chat-actions"><button onClick={onNewChat} className="primary" disabled={!connected}><Icon name="squarePen" size={16} />New chat</button></div></div></div>
    {!rows.length && board && <div className="empty-state"><JoloMark className="welcome-mark" /><h2>Start with a chat.</h2><p>You can also open a folder when you want to work on a project.</p></div>}
    {rows.length > 0 && <section className="board-folders" aria-label="Workspace folders"><div className="board-section-heading"><h2>Folders <span className="board-total">{rows.length}</span></h2><span>Recent activity</span></div><div className="board-list">{rows.map(row => <WorkspaceRow key={row.workspaceId} row={row} homeDirectory={homeDirectory} revision={board.generatedAt} now={now} expanded={open.has(row.workspaceId)} onToggle={() => toggle(row.workspaceId)} onOpen={onOpen} onNewTask={onNewTask} call={call} />)}</div></section>}
    <RecentChats call={call} revision={board?.generatedAt} onOpen={onOpen} onMenu={onChatMenu} variant="board" now={now} />
  </div></div>;
}
