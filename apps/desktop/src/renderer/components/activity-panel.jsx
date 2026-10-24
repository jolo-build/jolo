import { useEffect, useReducer } from 'react';
import { forceStopOffered, formatElapsed, formatTokens, groupActivity, runningTasks, taskKind } from '../activity.js';
import { Modal } from './modal.jsx';

/** @typedef {import('../activity.js').TaskRecord} TaskRecord */

const WORDS = { running: 'running', completed: 'done', stopped: 'stopped', failed: 'failed' };
const elapsed = (/** @type {string} */ startedAt, /** @type {string | null} */ endedAt, /** @type {number} */ now) => formatElapsed((endedAt ? Date.parse(endedAt) : now) - Date.parse(startedAt));
/** Unknown usage is left out, never shown as 0 tokens (spec §2). */
const tokens = (/** @type {number | null} */ count) => count === null ? null : `${formatTokens(count)} tokens`;
const meta = (/** @type {(string | null)[]} */ parts) => parts.filter(Boolean).join(' · ');

/** @param {{ task: TaskRecord, now: number, onStopTask: (taskId: string) => void }} props */
function TaskRow({ task, now, onStopTask }) {
  return <li className="task-row" data-state={task.status}>
    <span className="activity-task-name" title={task.description}>{task.description}</span>
    <span className="activity-task-meta">{meta([taskKind(task), task.phase, WORDS[task.status], elapsed(task.startedAt, task.endedAt, now), tokens(task.usage.totalTokens)])}</span>
    {task.status === 'running' && <button type="button" onClick={() => onStopTask(task.taskId)}>Stop</button>}
  </li>;
}

/**
 * A workflow (D3): ONE task of the process, so its card says what the wire carries, its name, status, elapsed time and
 * tokens, and stops it as any task is stopped. Claude Code reports no agents, phases or agent count for it.
 * @param {{ task: TaskRecord, now: number, onStopTask: (taskId: string) => void }} props
 */
function WorkflowCard({ task, now, onStopTask }) {
  const name = task.workflowName ?? task.description;
  return <section className="workflow-card" data-state={task.status}>
    <header>
      <div className="workflow-head">
        <span className="workflow-title" title={name}>{name}</span>
        <span className="grow" />
        {task.status === 'running' && <button type="button" onClick={() => onStopTask(task.taskId)}>Stop</button>}
      </div>
      <div className="workflow-line">
        <span className="workflow-meta">{meta(['Workflow', WORDS[task.status], elapsed(task.startedAt, task.endedAt, now), tokens(task.usage.totalTokens)])}</span>
      </div>
    </header>
  </section>;
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
 * The conversation's background work (D2): workflows as cards, then the other tasks, each running one with a Stop.
 * A Stop background work that left some of its tasks running offers `Force stop`, which asks the pane to confirm closing
 * the process; tasks that end with it are recorded `failed` by the engine and read so here. Everything comes from the
 * activity snapshot: no row asks the engine for anything, so hundreds of tasks render in one pass (Review Focus 3).
 * @param {{
 *   activity: import('../activity.js').Activity | null,
 *   stopResult: import('../activity.js').StopResult | null,
 *   stopping: boolean,
 *   visible: boolean,
 *   onStopAll: () => void,
 *   onStopTask: (taskId: string) => void,
 *   onForceStop: () => void,
 * }} props `stopping` while a Stop background work waits for its reply; `visible` while the panel is on screen.
 */
export function ActivityPanel({ activity, stopResult, stopping, visible, onStopAll, onStopTask, onForceStop }) {
  const [, tick] = useReducer((/** @type {number} */ count) => count + 1, 0);
  const running = runningTasks(activity);
  const ticking = visible && running.length > 0;
  // Elapsed times move once a second while something runs and the panel is shown; nothing ticks otherwise, and showing
  // the panel again renders it with the current time.
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  const now = Date.now();
  const { workflows, tasks } = groupActivity(activity);
  return <div className="activity-panel">
    <div className="activity-heading">
      <strong>Activity</strong>
      {running.length ? <button type="button" disabled={stopping} onClick={onStopAll}>{stopping ? 'Stopping…' : 'Stop background work'}</button> : <span className="muted">Nothing running</span>}
    </div>
    {forceStopOffered(activity, stopResult) && <p className="panel-note" role="status"><span>Some tasks did not stop</span><button type="button" onClick={onForceStop}>Force stop</button></p>}
    {workflows.map(task => <WorkflowCard key={task.taskId} task={task} now={now} onStopTask={onStopTask} />)}
    {tasks.length > 0 && <ol className="activity-tasks">{tasks.map(task => <TaskRow key={task.taskId} task={task} now={now} onStopTask={onStopTask} />)}</ol>}
    {activity?.truncated && <p className="panel-note">Older finished tasks are not listed</p>}
  </div>;
}
