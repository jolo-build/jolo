import { useEffect, useReducer } from 'react';
import { clearFinished, forceStopOffered, formatElapsed, formatTokens, groupActivity, phaseSquares, plural, taskKind, workflowPhaseStatus, workflowSummary } from '../activity.js';
import { Icon } from './icon.jsx';
import { Modal } from './modal.jsx';

/** @typedef {import('../activity.js').TaskRecord} TaskRecord */

const WORDS = { running: 'Running', completed: 'Completed', stopped: 'Stopped', failed: 'Failed' };
const elapsed = (/** @type {string} */ startedAt, /** @type {string | null} */ endedAt, /** @type {number} */ now) => formatElapsed((endedAt ? Date.parse(endedAt) : now) - Date.parse(startedAt));
/** Unknown usage is left out, never shown as 0 tokens (spec §2); so is a 0, which says no spend was reported yet. */
const tokens = (/** @type {number | null} */ count) => !count ? null : `${formatTokens(count)} tokens`;
const meta = (/** @type {(string | null)[]} */ parts) => parts.filter(Boolean).join(' · ');
/** A phase's squares in words, their text alternative: `1 done, 1 running, 2 pending`, leaving out a status none has. */
const inWords = (/** @type {string[]} */ squares) => {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const status of squares) counts.set(status, (counts.get(status) ?? 0) + 1);
  return [...counts].map(([status, count]) => `${count} ${status}`).join(', ');
};

/**
 * A card's or a row's first line: its name, its elapsed time (frozen once it ended), and a Stop while it runs.
 * @param {{ task: TaskRecord, name: string, className: string, now: number, onStopTask: (taskId: string) => void }} props
 */
function ItemHead({ task, name, className, now, onStopTask }) {
  return <div className="item-head">
    <span className={className} title={name}>{name}</span>
    <span className="activity-elapsed">{elapsed(task.startedAt, task.endedAt, now)}</span>
    {task.status === 'running' && <button type="button" onClick={() => onStopTask(task.taskId)}>Stop</button>}
  </div>;
}

/**
 * A task that is not a workflow: its description, then its kind, status, tokens and tool uses, those it reported.
 * @param {{ task: TaskRecord, now: number, onStopTask: (taskId: string) => void }} props
 */
function TaskRow({ task, now, onStopTask }) {
  const uses = task.usage.toolUses;
  return <li className="task-row" data-state={task.status}>
    <ItemHead task={task} name={task.description} className="activity-task-name" now={now} onStopTask={onStopTask} />
    <div className="activity-task-meta">{meta([taskKind(task), WORDS[task.status], tokens(task.usage.totalTokens), uses ? plural(uses, 'tool use') : null])}</div>
  </li>;
}

/**
 * A workflow (D3): ONE task of the process, stopped as any task is, laid out as Claude Code's own panel lays one out: its
 * name and elapsed time, `Workflow` and its status (a `Large` badge past the threshold), its agents and tokens, its
 * description, and its phases, each with how many of its agents are done and a square per agent (see phaseSquares). The
 * agents and phases come from Claude's progress report; without it, none of them. The agent the last report named is
 * the phases' tooltip while the workflow runs, and nothing once it ended.
 * @param {{ task: TaskRecord, now: number, onStopTask: (taskId: string) => void }} props
 */
function WorkflowCard({ task, now, onStopTask }) {
  const name = task.workflowName ?? task.description;
  const { agents, phases, current, large } = workflowSummary(task);
  const spent = tokens(task.usage.totalTokens);
  // Claude Code describes a workflow's task `Workflow <name>`, which says nothing the card's first two lines do not.
  const described = task.description !== name && task.description !== `Workflow ${name}` ? task.description : '';
  return <li className="workflow-card" data-state={task.status}>
    <ItemHead task={task} name={name} className="workflow-title" now={now} onStopTask={onStopTask} />
    <div className="card-meta"><span>Workflow</span><span>{WORDS[task.status]}</span>{large && <span className="plan-mark">Large</span>}</div>
    {(agents !== null || spent) && <div className="card-meta">{agents !== null && <span>{plural(agents, 'agent')}</span>}{spent && <span>{spent}</span>}</div>}
    {described && <p className="workflow-description">{described}</p>}
    {phases.length > 0 && <div className="workflow-phases" title={task.status === 'running' ? current ?? undefined : undefined}>
      <span className="phases-label">Phases</span>
      {phases.map((phase, index) => {
        const squares = phaseSquares(phase, task.status);
        return <div key={index} className="workflow-phase" data-state={workflowPhaseStatus(phase, task.status)}>
          <div className="phase-head"><span>{phase.title}</span><span>{`${phase.done}/${phase.agents}`}</span></div>
          {squares.length > 0 && <div className="phase-squares" role="img" aria-label={inWords(squares)}>{squares.map((status, square) => <span key={square} data-status={status} />)}</div>}
        </div>;
      })}
    </div>}
  </li>;
}

/**
 * The confirmation before closing the process whose tasks ignored their stop (D11). The pane shows it at its root, with
 * its other modals, so it counts as a host dialog and no panel switch can hide it.
 * @param {{ onConfirm: () => void, onClose: () => void }} props
 */
export function ForceStopDialog({ onConfirm, onClose }) {
  return <Modal label="Close Claude's process?" onClose={onClose}>
    <div className="task-dialog">
      <h2>Close Claude's process?</h2>
      <p>Its background work, and any answer in progress, end with the process. The conversation continues with a fresh process on your next message.</p>
      <div className="modal-actions"><button type="button" autoFocus onClick={onClose}>Cancel</button><button type="button" className="danger" onClick={onConfirm}>Close process</button></div>
    </div>
  </Modal>;
}

/**
 * The conversation's background work (D2), as Claude Code's own panel lists it: the running tasks, then the finished ones
 * under `Finished N`, each newest first, a workflow as a card and any other task as a row, each running one with a Stop.
 * Clear finished hides the finished tasks listed at that moment (`cleared`, which the pane keeps). A Stop background
 * work that left some of its tasks running offers `Force stop`, which asks the pane to confirm closing the process; tasks
 * that end with it are recorded `failed` by the engine and read so here. Everything comes from the activity snapshot: no
 * row asks the engine for anything, so hundreds of tasks render in one pass (Review Focus 3).
 * @param {{
 *   activity: import('../activity.js').Activity | null,
 *   stopResult: import('../activity.js').StopResult | null,
 *   stopping: boolean,
 *   visible: boolean,
 *   cleared: import('../activity.js').ClearedTasks,
 *   onStopAll: () => void,
 *   onStopTask: (taskId: string) => void,
 *   onForceStop: () => void,
 *   onClear: (cleared: import('../activity.js').ClearedTasks) => void,
 * }} props `stopping` while a Stop background work waits for its reply; `visible` while the panel is on screen.
 */
export function ActivityPanel({ activity, stopResult, stopping, visible, cleared, onStopAll, onStopTask, onForceStop, onClear }) {
  const [, tick] = useReducer((/** @type {number} */ count) => count + 1, 0);
  const { running, finished } = groupActivity(activity, cleared);
  const ticking = visible && running.length > 0;
  // Elapsed times move once a second while something runs and the panel is shown; nothing ticks otherwise, and showing
  // the panel again renders it with the current time.
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  const now = Date.now();
  const item = (/** @type {TaskRecord} */ task) => taskKind(task) === 'Workflow'
    ? <WorkflowCard key={task.taskId} task={task} now={now} onStopTask={onStopTask} />
    : <TaskRow key={task.taskId} task={task} now={now} onStopTask={onStopTask} />;
  return <div className="activity-panel">
    <div className="activity-heading">
      <strong>Activity</strong>
      <span className="activity-actions">
        {running.length > 0 && <button type="button" disabled={stopping} onClick={onStopAll}>{stopping ? 'Stopping…' : 'Stop background work'}</button>}
        {finished.length > 0 && <button type="button" className="icon-button" aria-label="Clear finished" title="Clear finished" onClick={() => onClear(clearFinished(activity, cleared))}><Icon name="trash" size={14} /></button>}
        {!running.length && !finished.length && <span className="muted">Nothing running</span>}
      </span>
    </div>
    {forceStopOffered(activity, stopResult) && <p className="panel-note" role="status"><span>Some tasks did not stop</span><button type="button" onClick={onForceStop}>Force stop</button></p>}
    {running.length > 0 && <ol className="activity-list">{running.map(item)}</ol>}
    {finished.length > 0 && <details open className="finished-tasks">
      <summary><span>{`Finished ${finished.length}`}</span><Icon name="chevron" size={12} className="activity-disclosure" /></summary>
      <ol className="activity-list">{finished.map(item)}</ol>
    </details>}
    {activity?.truncated && <p className="panel-note">Older finished tasks are not listed</p>}
  </div>;
}
