import { useEffect, useState } from 'react';
import { modelLabel } from '../model-options.js';
import { relativeTime } from '@jolo/client/board';
import { useTaskDrag } from '../task-drag.jsx';
import { readOpenGroups, rememberOpenGroup } from '../subtask-groups.js';
import { Icon } from './icon.jsx';

// Keep one spinner throughout a turn: tool/model transitions must not flicker. A row shows a glyph, at its end, only
// when its state asks for a look; done, stopped and ready rows show none, and their state stays in the tooltip.
const progress = {
  queued: ['clock', 'Queued'], preparing: ['spinner', 'Working'], model: ['spinner', 'Working'], tools: ['spinner', 'Working'],
  cancelling: ['spinner', 'Stopping'], awaiting_permission: ['shield', 'Needs approval'], paused: ['pause', 'Paused'],
  completed: [null, 'Done'], failed: ['alert', 'Failed'], interrupted: ['alert', 'Interrupted'], cancelled: [null, 'Stopped'],
};

/**
 * One navigation row for both workspace tasks and standalone conversations: its state and title on one line, with the
 * agent, model, branch and folder in its tooltip. A task that started child tasks folds them under its row behind
 * their count. The fold is the user's and is remembered; a child that comes on screen or starts needing the user
 * opens it.
 */
export function SidebarChatRow({ task, target, selected, onOpen, onMenu, agentName = id => id, standalone = false, subtasks = [], renderSubtask = null, currentSessionId = null }) {
  const drag = useTaskDrag();
  const [unfolded, setUnfolded] = useState(() => readOpenGroups(globalThis.localStorage).has(task.sessionId));
  const childNeeds = subtasks.some(child => child.attention === 'needs_you');
  const childCurrent = subtasks.some(child => child.sessionId === currentSessionId);
  useEffect(() => { if (childNeeds || childCurrent) setUnfolded(true); }, [childNeeds, childCurrent]);
  const open = subtasks.length > 0 && unfolded;
  const toggle = () => { setUnfolded(!open); rememberOpenGroup(globalThis.localStorage, task.sessionId, !open); };
  const title = task.title || (standalone ? 'New chat' : 'New task');
  const needs = task.attention === 'needs_you';
  const [icon, status] = progress[task.run?.state] ?? (needs ? ['alert', 'Needs you'] : [null, 'Ready']);
  const answerer = task.answerer;
  const id = answerer?.id ?? (task.run?.execution?.preset ? 'jolo' : task.run?.execution?.agentId ?? task.agentId ?? 'jolo');
  const name = answerer?.displayName || (id === 'jolo' ? 'Jolo' : agentName(id));
  const model = answerer?.model ?? task.run?.execution?.model;
  const identity = [name, modelLabel(model)].filter(Boolean).join(' · ');
  const branch = standalone ? null : target?.git?.branch ?? task.branch ?? target?.workspace?.branch;
  const worktree = !standalone && (task.mode ?? target?.workspace?.mode) === 'worktree';
  const workspacePath = target?.workspace?.path;
  const details = [status, task.updatedAt && relativeTime(task.updatedAt), identity, branch && `Branch: ${branch}`, worktree && 'Worktree', !standalone && workspacePath].filter(Boolean).join(' · ');
  return <><div className={`sidebar-chat-row ${standalone ? 'recent-chat-row' : 'task-row'}${selected ? ' selected' : ''}${subtasks.length ? ' has-subtasks' : ''}`}
    onContextMenu={onMenu ? event => { event.preventDefault(); onMenu(task); } : undefined}
    onKeyDown={onMenu ? event => { if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') { event.preventDefault(); onMenu(task); } } : undefined}>
    <button className={`sidebar-chat ${standalone ? 'recent-chat' : 'task'}`} {...drag(target)} data-session-id={task.sessionId}
      aria-current={selected ? 'page' : undefined} title={`${title}\n${details}`} onClick={onOpen}>
      <span className={standalone ? 'recent-chat-title' : 'task-title'}>{title}</span>
      {worktree && <span className="sidebar-task-worktree" role="img" aria-label="Worktree" title={workspacePath ? `Worktree: ${workspacePath}` : 'Worktree'}><Icon name="worktree" size={12} /></span>}
      {icon && <span className={`sidebar-task-progress${needs ? ' needs' : ''}${icon === 'spinner' ? ' working' : ''}`} role="img" aria-label={status}>
        <Icon name={icon} size={14} className={icon === 'spinner' ? 'activity-spin' : ''} />
      </span>}
    </button>
    {subtasks.length > 0 && <button className={`task-subtasks${childNeeds ? ' needs' : ''}`} aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} ${subtasks.length} child ${subtasks.length === 1 ? 'task' : 'tasks'} of ${title}`} onClick={toggle}>{subtasks.length}</button>}
    {onMenu && <button className="task-more" onClick={() => onMenu(task)} aria-label={`Options for ${title}`}><Icon name="more" size={14} /></button>}
  </div>
  {open && <div className="sidebar-subtasks" role="group" aria-label={`Child tasks of ${title}`}>{subtasks.map(renderSubtask)}</div>}
  </>;
}
