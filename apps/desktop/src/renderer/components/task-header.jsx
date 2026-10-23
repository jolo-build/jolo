import { ChildTasksMenu } from './child-tasks-menu.jsx';
import { Icon } from './icon.jsx';

/**
 * The task's location and family links. A conversation that started child tasks lists them at its right end; a child
 * task offers the way back to the task that started it there instead. `delegations` holds the children's delegation rows by
 * session, which `onShowChildTasks` refreshes when the list opens.
 */
export function TaskHeader({ branch, branchPath, childTasks, parentTask, onOpenTask, delegations = undefined, onShowChildTasks = undefined }) {
  return <header className="task-header">
    <div className="task-meta">
      {branch && <span className="task-worktree" title={branchPath}><Icon name="worktree" size={12} /><span>{branch}</span></span>}
    </div>
    {childTasks.length > 0 && <ChildTasksMenu tasks={childTasks} delegations={delegations} onOpen={onOpenTask} onShow={onShowChildTasks} />}
    {parentTask && <button type="button" className="parent-task-link" title={`Back to ${parentTask.title}`} onClick={() => onOpenTask(parentTask.sessionId)}><Icon name="back" size={12} /><span>{parentTask.title || 'Parent task'}</span></button>}
  </header>;
}
