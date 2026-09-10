import { useEffect, useMemo, useState } from 'react';
import { formatDuration, RUNNING } from '@jolo/client/board';
import { Icon } from './icon.jsx';
import { basename, runLabel } from '../presentation.js';

// The task list spans every project the engine knows. What needs you and what is
// working stays at the top, whichever project it belongs to, because a task waiting in another checkout is
// exactly the one that is easy to forget. Everything settled folds away behind a count.
//
// A row says where it is before it says what it is: project, then state, then title, then branch and agent.

const WORKING = new Set([...RUNNING, 'awaiting_permission']);
const SCOPES = [{ id: 'all', label: 'All projects' }, { id: 'project', label: 'This project' }];

const isLive = (task) => Boolean(task.run && WORKING.has(task.run.state));
/**
 * Settled means it ran and finished. A task that has never run is not settled but new, and folding it away
 * would hide the one thing a fresh task list should show.
 */
const isSettled = (task) => Boolean(task.run) && !isLive(task) && task.attention !== 'needs_you';

/** How long the current run has been going, or how long ago the last one stopped. */
function since(task, now) {
  if (!task.run) return null;
  const from = Date.parse(isLive(task) ? task.run.createdAt : task.run.updatedAt);
  if (!Number.isFinite(from)) return null;
  return formatDuration(Math.max(0, now - from));
}

function state(task) {
  if (!task.run) return { label: 'No task yet', tone: 'muted' };
  if (task.attention === 'needs_you') return { label: task.run.state === 'failed' ? 'Failed' : task.run.state === 'interrupted' ? 'Interrupted' : 'Needs you', tone: 'needs' };
  if (isLive(task)) return { label: 'Working', tone: 'busy' };
  if (task.run.state === 'cancelled') return { label: 'Stopped', tone: 'muted' };
  return { label: 'Done', tone: 'good' };
}

function TaskRow({ task, selected, current, now, agentName, onSelect, onMenu, session }) {
  const mark = state(task);
  const elapsed = since(task, now);
  return (
    <div
      className={`task-row ${selected ? 'selected' : ''}`}
      onContextMenu={(event) => { if (!session) return; event.preventDefault(); onMenu(session); }}
      onKeyDown={(event) => { if (!session) return; if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') { event.preventDefault(); onMenu(session); } }}
    >
      <button className="task" aria-current={selected ? 'page' : undefined} onClick={() => onSelect(task)}>
        <span className="task-where">
          <span className="task-project" title={task.rootPath}>{task.projectName}</span>
          <span className={`task-state ${mark.tone}`}>
            {mark.tone === 'busy' && <span className="task-spinner" aria-hidden="true" />}
            {mark.label}{elapsed ? ` ${elapsed}` : ''}
          </span>
        </span>
        <span className="task-title">{task.title || 'New task'}</span>
        <span className="meta">
          <span className="task-branch">{task.branch ?? (current ? 'main checkout' : 'workspace')}</span>
          {task.agentId && <span className="branch-tag">{agentName(task.agentId)}</span>}
        </span>
      </button>
      {session && <button className="task-more" onClick={() => onMenu(session)} aria-label={`Options for ${task.title || 'New task'}`} title="Task options"><Icon name="more" size={14} /></button>}
    </div>
  );
}

export function Sidebar({ project, sessions, sessionId, lastRun, tasks = [], tasksAvailable = null, workspaces = [], agentName = (id) => id, onOpenFolder, onNewSession, onNewWorktree, onSelect, onOpenTask, onSettings, onTaskMenu, historyState, onHistory }) {
  const preferWorktree = project?.preferredMode === 'worktree';
  const [scope, setScope] = useState('all');
  const [showSettled, setShowSettled] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const sessionById = useMemo(() => new Map(sessions.map((session) => [session.id, session])), [sessions]);

  // Rows across every project come from the engine. Archived tasks, and any engine that cannot list across
  // projects, fall back to the open project's own sessions: a list that shows nothing when tasks exist would
  // be worse than one that shows fewer of them.
  const archived = historyState !== 'open';
  const crossProject = !archived && tasksAvailable === true;
  const fromSessions = useMemo(() => sessions.map((session) => ({
    sessionId: session.id, title: session.title, agentId: session.agentId, projectId: project?.projectId ?? null,
    projectName: project ? basename(project.rootPath) : '', rootPath: project?.rootPath ?? '', workspaceId: session.workspaceId,
    branch: workspaces.find((workspace) => workspace.id === session.workspaceId)?.branch ?? null,
    attention: session.id === sessionId && lastRun ? 'running' : 'idle', reason: null, summary: null, updatedAt: session.updatedAt,
    run: session.id === sessionId && lastRun ? { id: lastRun.id, state: lastRun.state, pauseReason: lastRun.pauseReason ?? null, createdAt: lastRun.createdAt, updatedAt: lastRun.updatedAt } : null,
  })), [sessions, project, workspaces, sessionId, lastRun]);
  const rows = useMemo(() => {
    if (!crossProject) return fromSessions;
    return scope === 'project' && project ? tasks.filter((task) => task.projectId === project.projectId) : tasks;
  }, [crossProject, scope, tasks, fromSessions, project]);

  const live = rows.filter((task) => !isSettled(task));
  const settled = rows.filter(isSettled);
  const scopeLabel = tasksAvailable === true ? SCOPES.find(option => option.id === scope).label : 'This project';
  const openCount = tasksAvailable === true ? tasks.filter(task => scope !== 'project' || !project || task.projectId === project.projectId).length : archived ? null : rows.length;

  // A clock only while something is running, so an idle window does no work.
  useEffect(() => {
    if (!live.some(isLive)) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [live.some(isLive)]);

  const open = (task) => (task.projectId && task.projectId !== project?.projectId ? onOpenTask(task) : onSelect(task.sessionId));
  const row = (task) => (
    <TaskRow
      key={task.sessionId}
      task={task}
      selected={task.sessionId === sessionId}
      current={task.projectId === project?.projectId}
      now={now}
      agentName={agentName}
      onSelect={open}
      onMenu={onTaskMenu}
      session={sessionById.get(task.sessionId) ?? null}
    />
  );

  return <aside className="sidebar" aria-label="Task navigation">
    <div className="new-task-row">
      <button className="new-task" aria-label={project && preferWorktree ? 'New task in a worktree' : undefined} title={project && preferWorktree ? 'New task in a worktree' : undefined} onClick={project ? (preferWorktree ? onNewWorktree : onNewSession) : onOpenFolder}><Icon name={project && preferWorktree ? 'branch' : 'plus'} size={14} />{project ? 'New task' : 'Open folder'}</button>
      {project && <button className="new-task-alt" onClick={preferWorktree ? onNewSession : onNewWorktree} title={preferWorktree ? 'New task in the main checkout' : 'New task in a worktree'} aria-label={preferWorktree ? 'New task in the main checkout' : 'New task in a worktree'}><Icon name={preferWorktree ? 'folder' : 'branch'} size={14} /></button>}
    </div>
    <div className="task-tabs" role="tablist" aria-label="Task lists" onKeyDown={event => {
      if (event.target.getAttribute('role') !== 'tab' || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const nextArchived = event.key === 'Home' ? false : event.key === 'End' ? true : !archived;
      event.currentTarget.querySelectorAll('[role="tab"]')[nextArchived ? 1 : 0].focus();
      onHistory(nextArchived ? 'archived' : 'open');
    }}>
      <div className={`task-scope-tab${archived ? '' : ' selected'}`} role="presentation">
        <button id="open-tasks-tab" role="tab" aria-selected={!archived} aria-controls="sidebar-task-list" tabIndex={archived ? -1 : 0} onClick={() => { if (archived) onHistory('open'); }}>
          {scopeLabel}{openCount !== null && <span className="task-tab-count">{openCount}</span>}
        </button>
        {!archived && crossProject && <label className="task-scope-menu"><Icon name="down" size={12} /><select value={scope} onChange={event => setScope(event.target.value)} aria-label="Which projects to list">
          {SCOPES.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select></label>}
      </div>
      <button id="archived-tasks-tab" className={`task-archive-tab${archived ? ' selected' : ''}`} role="tab" aria-selected={archived} aria-controls="sidebar-task-list" tabIndex={archived ? 0 : -1} onClick={() => { if (!archived) onHistory('archived'); }}>
        Archive{archived && <span className="task-tab-count">{rows.length}</span>}
      </button>
    </div>
    <nav className="task-list" id="sidebar-task-list" role="tabpanel" aria-labelledby={archived ? 'archived-tasks-tab' : 'open-tasks-tab'}>
      {live.map(row)}
      {!rows.length && <p className="sidebar-empty">{archived ? 'No archived tasks.' : project ? 'Your tasks will appear here.' : 'Choose a project to get started.'}</p>}
      {settled.length > 0 && <button className="settled-toggle" onClick={() => setShowSettled((open) => !open)} aria-expanded={showSettled}>
        <span>Settled ({settled.length})</span><span className="settled-rule" /><Icon name="down" size={13} className={showSettled ? '' : 'flipped'} />
      </button>}
      {showSettled && settled.map(row)}
    </nav>
    <div className="side-bottom">
      <button className="project-switch" onClick={onOpenFolder} title={project?.rootPath ?? 'Open folder'}><span className="project-icon"><Icon name="folder" /></span><span><strong>{project ? basename(project.rootPath) : 'Choose a project'}</strong><small>Local workspace</small></span><Icon name="down" size={13} /></button>
      <button className="settings-link" onClick={onSettings}><Icon name="settings" />Settings</button>
    </div>
  </aside>;
}
