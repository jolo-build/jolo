import { ChildTasksMenu } from './child-tasks-menu.jsx';
import { Icon } from './icon.jsx';

/**
 * The task's location and family links. A conversation that started child tasks lists them at its right end; a child
 * task offers the way back to the task that started it there instead.
 */
export function TaskHeader({ branch, branchPath, childTasks, parentTask, onOpenTask }) {
  return <header className="task-header">
    <div className="task-meta">
      {branch && <span className="task-worktree" title={branchPath}><Icon name="worktree" size={12} /><span>{branch}</span></span>}
    </div>
    {childTasks.length > 0 && <ChildTasksMenu tasks={childTasks} onOpen={onOpenTask} />}
    {parentTask && <button type="button" className="parent-task-link" title={`Back to ${parentTask.title}`} onClick={() => onOpenTask(parentTask.sessionId)}><Icon name="back" size={12} /><span>{parentTask.title || 'Parent task'}</span></button>}
  </header>;
}
