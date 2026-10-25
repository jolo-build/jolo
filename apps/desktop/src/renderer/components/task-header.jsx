import { Icon } from './icon.jsx';

/**
 * The task's location and family link: its worktree branch, and for a child task the way back to the task that started
 * it at the right end. A conversation's own child tasks are listed in the Activity panel.
 */
export function TaskHeader({ branch, branchPath, parentTask, onOpenTask }) {
  return <header className="task-header">
    <div className="task-meta">
      {branch && <span className="task-worktree" title={branchPath}><Icon name="worktree" size={12} /><span>{branch}</span></span>}
    </div>
    {parentTask && <button type="button" className="parent-task-link" title={`Back to ${parentTask.title}`} onClick={() => onOpenTask(parentTask.sessionId)}><Icon name="back" size={12} /><span>{parentTask.title || 'Parent task'}</span></button>}
  </header>;
}
