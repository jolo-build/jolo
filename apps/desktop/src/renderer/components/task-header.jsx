export function TaskHeader({ status, working, branch, branchPath, agent }) {
  return <header className="task-header">
    <div className="task-meta">
      <span className="task-status"><span className={`state-dot${working ? ' working' : ''}`} aria-hidden="true" />{status}</span>
      {branch && <span className="task-meta-item task-worktree" title={branchPath}><span>{branch}</span></span>}
      {agent && <span className="task-meta-item task-agent" title={`Answered by ${agent}`}><span>{agent}</span></span>}
    </div>
  </header>;
}
