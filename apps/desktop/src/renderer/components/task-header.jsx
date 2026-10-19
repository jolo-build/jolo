import { ChildTasksMenu } from './child-tasks-menu.jsx';
import { Icon } from './icon.jsx';

/**
 * The conversation's status line. A conversation that started child tasks lists them at its right end; a child task
 * offers the way back to the task that started it there instead.
 */
export function TaskHeader({ status, working, branch, branchPath, agent, childTasks, parentTask, onOpenTask }) {
  return <header className="task-header">
    <div className="task-meta">
      <span className="task-status">{working && <span className="state-dot working" aria-hidden="true" />}{status}</span>
      {branch && <span className="task-meta-item task-worktree" title={branchPath}><span>{branch}</span></span>}
      {agent && <span className="task-meta-item task-agent" title={`Answered by ${agent}`}><span>{agent}</span></span>}
    </div>
    {childTasks.length > 0 && <ChildTasksMenu tasks={childTasks} onOpen={onOpenTask} />}
    {parentTask && <button type="button" className="parent-task-link" title={`Back to ${parentTask.title}`} onClick={() => onOpenTask(parentTask.sessionId)}><Icon name="back" size={12} /><span>{parentTask.title || 'Parent task'}</span></button>}
  </header>;
}
