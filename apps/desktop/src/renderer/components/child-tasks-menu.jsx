import { useEffect, useId, useRef, useState } from 'react';
import { RUNNING } from '@jolo/client/board';
import { modelLabel } from '../model-options.js';
import { delegationWords } from '../delegation.js';
import { Icon } from './icon.jsx';

/**
 * The child tasks a conversation started, as one quiet line at the top right of its header that opens a small list.
 * A mark shows only while one of them is working or needs the user; picking one opens its conversation. Each row says
 * what that child is doing when `delegations` (by session) has its row; `onShow` runs each time the list opens.
 */
export function ChildTasksMenu({ tasks, delegations = new Map(), onOpen, onShow = undefined }) {
  const trigger = useRef(null), menu = useRef(null);
  const menuId = useId();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const element = menu.current;
    // Focus stays on the toggle; the list follows it in tab order.
    const changed = () => setOpen(element.matches(':popover-open'));
    const close = () => element.hidePopover();
    element.addEventListener('toggle', changed);
    window.addEventListener('resize', close);
    return () => { element.removeEventListener('toggle', changed); window.removeEventListener('resize', close); };
  }, []);
  useEffect(() => { if (open) onShow?.(); }, [open]);
  const working = tasks.some(task => RUNNING.has(task.run?.state));
  const needs = tasks.some(task => task.attention === 'needs_you');
  const label = `${tasks.length} child ${tasks.length === 1 ? 'task' : 'tasks'}`;
  return <>
    <button ref={trigger} type="button" className={`child-tasks-toggle${needs ? ' needs' : ''}`} aria-haspopup="dialog" aria-expanded={open} popoverTarget={menuId} onClick={() => {
      const rect = trigger.current.getBoundingClientRect();
      menu.current.style.top = `${rect.bottom + 6}px`;
      menu.current.style.left = `${Math.max(8, Math.min(innerWidth - 300, rect.right - 292))}px`;
    }}>
      {needs ? <Icon name="alert" size={12} /> : working ? <Icon name="spinner" size={12} className="activity-spin" /> : null}
      <span>{label}</span><Icon name="down" size={12} />
    </button>
    <div ref={menu} id={menuId} className="panel-menu child-tasks-menu" popover="auto" role="dialog" aria-label="Child tasks">
      {tasks.map(task => {
        const identity = [task.answerer?.displayName, modelLabel(task.answerer?.model ?? task.run?.execution?.model)].filter(Boolean).join(' · ');
        const needsYou = task.attention === 'needs_you';
        const delegation = delegations.get(task.sessionId);
        const words = delegation ? delegationWords(delegation) : '';
        return <button key={task.sessionId} type="button" data-session-id={task.sessionId} onClick={() => { menu.current.hidePopover(); onOpen(task.sessionId); }}>
          <span className="child-task-text"><span>{task.title || 'Child task'}</span>{identity && <small>{identity}</small>}{words && <small>{words}</small>}</span>
          {needsYou ? <Icon name="alert" size={14} className="needs" /> : RUNNING.has(task.run?.state) ? <Icon name="spinner" size={14} className="activity-spin" /> : null}
        </button>;
      })}
    </div>
  </>;
}
