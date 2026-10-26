import { useLayoutEffect, useRef, useState } from 'react';
import { modelLabel } from '../model-options.js';
import { titleSteps, typedLength, typeStepMs } from '../typed-title.js';
import { relativeTime } from '@jolo/client/board';
import { useTaskDrag } from '../task-drag.jsx';
import { Icon } from './icon.jsx';

// Keep one spinner throughout a turn: tool/model transitions must not flicker. A row shows a glyph, at its end, only
// when its state asks for a look; done, stopped and ready rows show none, and their state stays in the tooltip. A settled
// run whose background work still runs keeps the spinner.
const progress = {
  queued: ['clock', 'Queued'], preparing: ['spinner', 'Working'], model: ['spinner', 'Working'], tools: ['spinner', 'Working'],
  cancelling: ['spinner', 'Stopping'], awaiting_permission: ['shield', 'Needs approval'], paused: ['pause', 'Paused'],
  completed: [null, 'Done'], failed: ['alert', 'Failed'], interrupted: ['alert', 'Interrupted'], cancelled: [null, 'Stopped'],
};

/** What stands for a title while a task is being named (its title is blank but it has a run): a muted, sweeping bar. */
export function TitleShimmer() {
  return <span className="title-shimmer" role="img" aria-label="Naming…"><span /></span>;
}

/** Whether the person asked for less motion; a renderer without matchMedia has no preference. */
const reducedMotion = () => typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

/**
 * A task's title, or the shimmer while it is being named. The title that replaces the shimmer is typed out; a title that
 * was already there when this first rendered, or one that changes while no shimmer was shown (a rename), appears at
 * once, as it does with less motion asked for. A static render never shows part of a title: typing starts in an effect.
 * @param {{ title: string, naming: boolean }} props
 */
export function TypedTitle({ title, naming }) {
  const wasNaming = useRef(naming);
  const [shown, setShown] = useState(/** @type {number | null} */ (null)); // code points typed so far; null is all
  // A layout effect, so the first character replaces the shimmer in the same paint rather than the whole title flashing.
  useLayoutEffect(() => {
    const typing = wasNaming.current && !naming && Boolean(title);
    wasNaming.current = naming;
    if (!typing || reducedMotion()) { setShown(null); return; }
    const started = Date.now();
    const total = titleSteps(title).length;
    setShown(typedLength(title, 0));
    const timer = setInterval(() => {
      const count = typedLength(title, Date.now() - started);
      setShown(count >= total ? null : count);
      if (count >= total) clearInterval(timer);
    }, Math.max(16, typeStepMs(title))); // the count comes from the clock, so a long title renders at most once a frame
    return () => clearInterval(timer);
  }, [naming, title]);
  if (naming) return <TitleShimmer />;
  return shown === null ? title : titleSteps(title).slice(0, shown).join('');
}

/**
 * One navigation row for both workspace tasks and standalone conversations: its state and title on one line, with the
 * agent, model, branch and folder in its tooltip. Child tasks are listed in their parent's conversation header, not
 * here; the parent's row only takes the needs-you mark when one of them needs the user.
 */
export function SidebarChatRow({ task, target, selected, onOpen, onMenu, agentName = id => id, standalone = false, childTasks = [] }) {
  const drag = useTaskDrag();
  const childNeeds = childTasks.some(child => child.attention === 'needs_you');
  // A blank title on a task that has a run means it is being named; a blank one without a run is new.
  const naming = !task.title && Boolean(task.run);
  const title = naming ? 'Naming…' : task.title || (standalone ? 'New chat' : 'New task');
  const own = task.reason === 'background' ? ['spinner', 'Working in background']
    : progress[task.run?.state] ?? (task.attention === 'needs_you' ? ['alert', 'Needs you'] : [null, 'Ready']);
  const asks = ['alert', 'shield'].includes(own[0]);
  const needs = task.attention === 'needs_you' || childNeeds;
  const [icon, status] = childNeeds && !asks ? ['alert', 'A child task needs you'] : own;
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
      <span className={standalone ? 'recent-chat-title' : 'task-title'}><TypedTitle title={naming ? '' : title} naming={naming} /></span>
      {worktree && <span className="sidebar-task-worktree" role="img" aria-label="Worktree" title={workspacePath ? `Worktree: ${workspacePath}` : 'Worktree'}><Icon name="worktree" size={12} /></span>}
      {icon && <span className={`sidebar-task-progress${needs ? ' needs' : ''}${icon === 'spinner' ? ' working' : ''}`} role="img" aria-label={status}>
        <Icon name={icon} size={14} className={icon === 'spinner' ? 'activity-spin' : ''} />
      </span>}
    </button>
    {onMenu && <button className="task-more" onClick={() => onMenu(task)} aria-label={`Options for ${title}`}><Icon name="more" size={14} /></button>}
  </div>;
}
