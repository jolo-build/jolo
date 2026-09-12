import { modelLabel } from '../model-options.js';
import { relativeTime } from '@jolo/client/board';
import { useTaskDrag } from '../task-drag.jsx';
import { Icon } from './icon.jsx';

// Keep one spinner throughout a turn: tool/model transitions must not flicker.
const progress = {
  queued: ['clock', 'Queued'], preparing: ['spinner', 'Working'], model: ['spinner', 'Working'], tools: ['spinner', 'Working'],
  cancelling: ['spinner', 'Stopping'], awaiting_permission: ['shield', 'Needs approval'], paused: ['pause', 'Paused'],
  completed: ['check', 'Done'], failed: ['alert', 'Failed'], interrupted: ['alert', 'Interrupted'], cancelled: ['stop', 'Stopped'],
};

/** One navigation row for both workspace tasks and standalone conversations. */
export function SidebarChatRow({ task, target, selected, onOpen, onMenu, agentName = id => id, standalone = false }) {
  const drag = useTaskDrag();
  const title = task.title || (standalone ? 'New chat' : 'New task');
  const needs = task.attention === 'needs_you';
  const [icon, status] = progress[task.run?.state] ?? (needs ? ['alert', 'Needs you'] : ['circle', 'Ready']);
  const answerer = task.answerer;
  const id = answerer?.id ?? (task.run?.execution?.preset ? 'jolo' : task.run?.execution?.agentId ?? task.agentId ?? 'jolo');
  const name = answerer?.displayName || (id === 'jolo' ? 'Jolo' : agentName(id));
  const model = answerer?.model ?? task.run?.execution?.model;
  const identity = [name, modelLabel(model)].filter(Boolean).join(' · ');
  const branch = standalone ? null : target?.git?.branch ?? task.branch ?? target?.workspace?.branch;
  const worktree = !standalone && (task.mode ?? target?.workspace?.mode) === 'worktree';
  const workspacePath = target?.workspace?.path;
  const details = [status, task.updatedAt && relativeTime(task.updatedAt), identity, branch && `Branch: ${branch}`, worktree && 'Worktree', !standalone && workspacePath].filter(Boolean).join(' · ');
  return <div className={`sidebar-chat-row ${standalone ? 'recent-chat-row' : 'task-row'}${selected ? ' selected' : ''}`}
    onContextMenu={onMenu ? event => { event.preventDefault(); onMenu(task); } : undefined}
    onKeyDown={onMenu ? event => { if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') { event.preventDefault(); onMenu(task); } } : undefined}>
    <button className={`sidebar-chat ${standalone ? 'recent-chat' : 'task'}`} {...drag(target)} data-session-id={task.sessionId}
      aria-current={selected ? 'page' : undefined} title={`${title}\n${details}`} onClick={onOpen}>
      <span className={`sidebar-task-progress${needs ? ' needs' : ''}${icon === 'spinner' ? ' working' : ''}`} role="img" aria-label={status}>
        <Icon name={icon} size={15} className={icon === 'spinner' ? 'activity-spin' : ''} />
      </span>
      <span className="sidebar-chat-content">
        <span className={standalone ? 'recent-chat-title' : 'task-title'}>{title}</span>
        <span className="sidebar-chat-details">
          <span className="sidebar-task-answerer" title={identity}>{identity}</span>
          {branch && <span className="sidebar-task-branch" title={`Branch: ${branch}`}><Icon name="branch" size={12} /><span>{branch}</span></span>}
          {worktree && <span className="sidebar-task-worktree" role="img" aria-label="Worktree" title={workspacePath ? `Worktree: ${workspacePath}` : 'Worktree'}><Icon name="worktree" size={12} /></span>}
        </span>
      </span>
    </button>
    {onMenu && <button className="task-more" onClick={() => onMenu(task)} aria-label={`Options for ${title}`}><Icon name="more" size={14} /></button>}
  </div>;
}
