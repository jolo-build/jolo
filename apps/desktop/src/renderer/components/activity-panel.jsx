import { useEffect, useReducer, useState } from 'react';
import { agentStatus, agentsByPhase, clearFinished, forceStopOffered, formatElapsed, formatTokens, groupActivity, nestTasks, phaseSquares, plural, squaresInWords, statusWord, taskDetail, taskKind, workflowPhaseStatus, workflowSummary } from '../activity.js';
import { modelLabel } from '../model-options.js';
import { Icon } from './icon.jsx';
import { Modal } from './modal.jsx';

/** @typedef {import('../activity.js').TaskRecord} TaskRecord */

/** A workflow agent's status in words (see agentStatus). */
const AGENT_WORDS = { running: 'Running', done: 'Done', failed: 'Failed', stopped: 'Stopped', pending: 'Pending' };
const elapsed = (/** @type {string} */ startedAt, /** @type {string | null} */ endedAt, /** @type {number} */ now) => formatElapsed((endedAt ? Date.parse(endedAt) : now) - Date.parse(startedAt));
/** Unknown usage is left out, never shown as 0 tokens (spec §2); so is a 0, which says no spend was reported yet. */
const tokens = (/** @type {number | null} */ count) => !count ? null : `${formatTokens(count)} tokens`;
const meta = (/** @type {(string | null)[]} */ parts) => parts.filter(Boolean).join(' · ');

/** Which phase of which workflow card is open, as the panel keeps it: the task's id and the phase's position. */
export const phaseKey = (/** @type {string} */ taskId, /** @type {number} */ index) => `${taskId}\u0000${index}`;

/**
 * A card's or a row's first line: its name (after `↳` when it is drawn under the task that started it), its elapsed time
 * (frozen once it ended), and while it runs a square stop at its right end, as Claude Code's own panel has, named after
 * the task for assistive technology.
 * @param {{ task: TaskRecord, name: string, nested?: boolean, className: string, now: number, onStopTask: (taskId: string) => void }} props
 */
function ItemHead({ task, name, nested = false, className, now, onStopTask }) {
  return <div className="item-head">
    <span className={className} title={name}>{nested && <span className="activity-nest" aria-hidden="true">↳ </span>}{name}</span>
    <span className="activity-elapsed">{elapsed(task.startedAt, task.endedAt, now)}</span>
    {task.status === 'running' && <button type="button" className="icon-button stop-task" aria-label={`Stop ${name}`} title="Stop" onClick={() => onStopTask(task.taskId)}><Icon name="stop" size={14} /></button>}
  </div>;
}

/**
 * How a finished task ended, as its notification said (see taskDetail): its summary, and the file its output was written
 * to by name, the full path on hover. Nothing of either while it runs.
 * @param {{ detail: ReturnType<typeof taskDetail> }} props
 */
function Ending({ detail }) {
  return <>
    {detail.summary && <div className="activity-summary" title={detail.summary}>{detail.summary}</div>}
    {detail.output && <div className="activity-output" title={detail.output.path}>{`Output: ${detail.output.name}`}</div>}
  </>;
}

/**
 * A task that is not a workflow: its description, then its kind, status, tokens and tool uses, those it reported, and while
 * it runs what it does now (its progress line under the status, else the tool it last used on the status line); once it
 * ended, how (see Ending).
 * @param {{ task: TaskRecord, nested: boolean, now: number, onStopTask: (taskId: string) => void }} props
 */
function TaskRow({ task, nested, now, onStopTask }) {
  const uses = task.usage.toolUses;
  const detail = taskDetail(task);
  return <li className="task-row" data-state={task.status} data-nested={nested ? '' : undefined}>
    <ItemHead task={task} name={task.description} nested={nested} className="activity-task-name" now={now} onStopTask={onStopTask} />
    <div className="activity-task-meta">{meta([taskKind(task), statusWord(task.status), tokens(task.usage.totalTokens), uses ? plural(uses, 'tool use') : null, detail.tool])}</div>
    {detail.now && <div className="activity-now" title={detail.now}>{detail.now}</div>}
    <Ending detail={detail} />
  </li>;
}

/**
 * One agent of a workflow phase, as Claude's progress last listed it: its label, model, tokens (none while it reported no
 * spend), duration and status in one line, and a preview of its result below, each in full on hover.
 * @param {{ agent: import('../activity.js').WorkflowAgent, taskStatus: TaskRecord['status'] }} props
 */
function AgentLine({ agent, taskStatus }) {
  const status = agentStatus(agent, taskStatus);
  const rest = meta([modelLabel(agent.model) || null, tokens(agent.tokens), agent.durationMs === null ? null : formatElapsed(agent.durationMs), AGENT_WORDS[status]]);
  return <li className="phase-agent" data-state={status}>
    <div className="phase-agent-line" title={meta([agent.label, rest])}>{agent.label && <span className="phase-agent-label">{agent.label}</span>}{agent.label ? ` · ${rest}` : rest}</div>
    {agent.resultPreview && <div className="phase-agent-result" title={agent.resultPreview}>{agent.resultPreview}</div>}
  </li>;
}

/**
 * A workflow (D3): ONE task of the process, stopped as any task is, laid out as Claude Code's own panel lays one out: its
 * name and elapsed time, `Workflow` and its status (a `Large` badge past the threshold), its agents and tokens, its
 * description, and its phases, each with how many of its agents are done and a square per agent (see phaseSquares). The
 * agents and phases come from Claude's progress report; without it, none of them. The agent the last report named is
 * the phases' tooltip while the workflow runs, and nothing once it ended. A phase whose agents Claude listed opens, by its
 * chevron, to one line per agent (see AgentLine); one with none listed, or from an engine before the list, has no chevron.
 * Once the workflow ended, the card says how (see Ending). Which phases are open the panel keeps (`openPhases`, by
 * phaseKey), so a phase stays open when its card moves under Finished; a closed phase renders none of its agent lines, so
 * a large workflow does not redraw hundreds of them every second.
 * @param {{ task: TaskRecord, nested: boolean, now: number, onStopTask: (taskId: string) => void, openPhases: Set<string>,
 *   onPhaseToggle: (key: string, open: boolean) => void }} props
 */
export function WorkflowCard({ task, nested, now, onStopTask, openPhases, onPhaseToggle }) {
  const name = task.workflowName ?? task.description;
  const { agents, phases, current, large } = workflowSummary(task);
  const agentsOf = agentsByPhase(task);
  const spent = tokens(task.usage.totalTokens);
  // Claude Code describes a workflow's task `Workflow <name>`, which says nothing the card's first two lines do not.
  const described = task.description !== name && task.description !== `Workflow ${name}` ? task.description : '';
  return <li className="workflow-card" data-state={task.status} data-nested={nested ? '' : undefined}>
    <ItemHead task={task} name={name} nested={nested} className="workflow-title" now={now} onStopTask={onStopTask} />
    <div className="card-meta"><span>Workflow</span><span>{statusWord(task.status)}</span>{large && <span className="plan-mark">Large</span>}</div>
    {(agents !== null || spent) && <div className="card-meta">{agents !== null && <span>{plural(agents, 'agent')}</span>}{spent && <span>{spent}</span>}</div>}
    {described && <p className="workflow-description">{described}</p>}
    {phases.length > 0 && <div className="workflow-phases" title={task.status === 'running' ? current ?? undefined : undefined}>
      <span className="phases-label">Phases</span>
      {phases.map((phase, index) => {
        const squares = phaseSquares(phase, task.status);
        const state = workflowPhaseStatus(phase, task.status);
        const count = `${phase.done}/${phase.agents}`;
        const blocks = squares.length > 0 && <div className="phase-squares" role="img" aria-label={squaresInWords(squares)}>{squares.map((status, square) => <span key={square} data-status={status} />)}</div>;
        const listed = agentsOf?.(phase);
        if (!listed?.length) return <div key={index} className="workflow-phase" data-state={state}><div className="phase-head"><span>{phase.title}</span><span>{count}</span></div>{blocks}</div>;
        const key = phaseKey(task.taskId, index);
        const open = openPhases.has(key);
        return <details key={index} className="workflow-phase" data-state={state} open={open} onToggle={event => onPhaseToggle(key, event.currentTarget.open)}>
          <summary>
            <div className="phase-head"><span className="phase-title"><span>{phase.title}</span><Icon name="chevron" size={12} className="activity-disclosure" /></span><span>{count}</span></div>
            {blocks}
          </summary>
          {open && <ol className="phase-agents">{listed.map((agent, at) => <AgentLine key={at} agent={agent} taskStatus={task.status} />)}</ol>}
        </details>;
      })}
    </div>}
    <Ending detail={taskDetail(task)} />
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
 * under `Finished N`, each newest first, a workflow as a card and any other task as a row, each running one with a stop square,
 * and a task started by another of the same list drawn under it (see nestTasks).
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
  const [openPhases, setOpenPhases] = useState(() => /** @type {Set<string>} */ (new Set()));
  const onPhaseToggle = (/** @type {string} */ key, /** @type {boolean} */ open) => setOpenPhases(current => {
    if (current.has(key) === open) return current;
    const next = new Set(current);
    if (open) next.add(key);
    else next.delete(key);
    return next;
  });
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
  // A task is drawn under the task in the same list that started it (see nestTasks).
  const item = (/** @type {{ task: TaskRecord, nested: boolean }} */ { task, nested }) => taskKind(task) === 'Workflow'
    ? <WorkflowCard key={task.taskId} task={task} nested={nested} now={now} onStopTask={onStopTask} openPhases={openPhases} onPhaseToggle={onPhaseToggle} />
    : <TaskRow key={task.taskId} task={task} nested={nested} now={now} onStopTask={onStopTask} />;
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
    {running.length > 0 && <ol className="activity-list">{nestTasks(running).map(item)}</ol>}
    {finished.length > 0 && <details open className="finished-tasks">
      <summary><span>{`Finished ${finished.length}`}</span><Icon name="chevron" size={12} className="activity-disclosure" /></summary>
      <ol className="activity-list">{nestTasks(finished).map(item)}</ol>
    </details>}
    {activity?.truncated && <p className="panel-note">Older finished tasks are not listed</p>}
  </div>;
}
