import { useEffect, useReducer, useState } from 'react';
import { agentStatus, agentsByPhase, childRows, clearFinished, forceStopOffered, formatElapsed, formatTokens, groupActivity, nestTasks, phaseSquares, plural, squaresInWords, statusWord, taskDetail, taskKind, workflowPhaseStatus, workflowSummary } from '../activity.js';
import { modelLabel } from '../model-options.js';
import { delegationWords } from '../delegation.js';
import { Icon } from './icon.jsx';
import { Modal } from './modal.jsx';

/** @typedef {import('../activity.js').TaskRecord} TaskRecord */

const noop = () => {};
const noOutput = async () => ({ output: '', totalBytes: 0, truncated: false });
const NO_CHILDREN = /** @type {import('../activity.js').ChildTask[]} */ ([]);
const NO_DELEGATIONS = /** @type {Map<string, import('../activity.js').DelegationRow>} */ (new Map());
/** A workflow agent's status in words (see agentStatus). */
const AGENT_WORDS = { running: 'Running', done: 'Done', failed: 'Failed', stopped: 'Stopped', pending: 'Pending' };
const elapsed = (/** @type {string} */ startedAt, /** @type {string | null} */ endedAt, /** @type {number} */ now) => formatElapsed((endedAt ? Date.parse(endedAt) : now) - Date.parse(startedAt));
/** Unknown usage is left out, never shown as 0 tokens (spec §2); so is a 0, which says no spend was reported yet. */
const tokens = (/** @type {number | null} */ count) => !count ? null : `${formatTokens(count)} tokens`;
const meta = (/** @type {(string | null)[]} */ parts) => parts.filter(Boolean).join(' · ');

/** Which phase of which workflow card is open, as the panel keeps it: the task's id and the phase's position. */
export const phaseKey = (/** @type {string} */ taskId, /** @type {number} */ index) => `${taskId}\u0000${index}`;
/** Which agent of an open phase shows its result preview in full, kept in the same set: its phase's key and its position. */
export const agentKey = (/** @type {string} */ taskId, /** @type {number} */ index, /** @type {number} */ at) => `${phaseKey(taskId, index)}\u0000${at}`;

/**
 * A card's or a row's first line: its name (after `↳` when it is drawn under the task that started it), its elapsed time
 * (frozen once it ended), a chevron that opens its output under it (see TaskOutput), and while it runs a square stop at
 * its right end, as Claude Code's own panel has, named after the task for assistive technology.
 * @param {{ task: TaskRecord, name: string, nested?: boolean, className: string, now: number, onStopTask: (taskId: string) => void,
 *   output?: { open: boolean, onToggle: () => void } | null }} props
 */
function ItemHead({ task, name, nested = false, className, now, onStopTask, output = null }) {
  return <div className="item-head">
    <span className={className} title={name}>{nested && <span className="activity-nest" aria-hidden="true">↳ </span>}{name}</span>
    <span className="activity-elapsed">{elapsed(task.startedAt, task.endedAt, now)}</span>
    {output && <button type="button" className="icon-button task-output-toggle" aria-label="Show output" aria-expanded={output.open} title="Output" onClick={output.onToggle}><Icon name="chevron" size={14} className="activity-disclosure" /></button>}
    {task.status === 'running' && <button type="button" className="icon-button stop-task" aria-label={`Stop ${name}`} title="Stop" onClick={() => onStopTask(task.taskId)}><Icon name="stop" size={14} /></button>}
  </div>;
}

/** How often an open output is read again while its task runs. */
const OUTPUT_REFRESH_MS = 2000;

/**
 * What a task's output pane shows (see TaskOutput): `Loading output…` until the first answer; the output (from the process
 * or the task's output file alike), after `… earlier output left out` when its start was cut; for a running agent or
 * workflow that Claude cannot serve, `The output is readable once it finishes`; with the process gone, that it has ended
 * and, for a task that wrote one, its output file by name (the full path on hover); with an engine from before the
 * method, that it is not available; any other error in its own words.
 * @param {{ task: TaskRecord, state: { status: 'loading' } | { status: 'ready', result: { output: string, totalBytes: number, truncated: boolean, source?: 'process' | 'file' } } | { status: 'error', error: { code?: string, message?: string } } }} props
 */
export function TaskOutputView({ task, state }) {
  const note = (/** @type {string} */ text, /** @type {string | undefined} */ title = undefined) => <p className="task-output-note" title={title}>{text}</p>;
  if (state.status === 'loading') return <div className="task-output-pane">{note('Loading output…')}</div>;
  if (state.status === 'error') {
    // An engine from before session.taskOutput, as the client reports one (Clear finished falls back the same way).
    if (state.error?.code === 'unknown_method') return <div className="task-output-pane">{note('Not available with this engine')}</div>;
    // Claude serves a command's output as it runs, never an agent's or a workflow's. Their output file exists from the start
    // (an agent's is a link to its transcript), but only its name arrives, with the notice that the task ended.
    if (state.error?.code !== 'no_process' && task.status === 'running' && ['Agent', 'Workflow'].includes(taskKind(task))) return <div className="task-output-pane">{note('The output is readable once it finishes')}</div>;
    if (state.error?.code !== 'no_process') { const message = state.error?.message || 'Could not read the output'; return <div className="task-output-pane">{note(message, message)}</div>; }
    const file = task.outputFile ? { name: task.outputFile.split('/').pop() || task.outputFile, path: task.outputFile } : null;
    return <div className="task-output-pane">{note('The process that ran it has ended')}{file && note(`Output file: ${file.name}`, file.path)}</div>;
  }
  const { output, truncated } = state.result;
  if (!output) return <div className="task-output-pane">{note('No output yet')}</div>;
  return <div className="task-output-pane"><pre className="task-output">{truncated ? `… earlier output left out\n${output}` : output}</pre></div>;
}

/**
 * A task's output, read from the conversation's process (`load`) while the panel is on screen (`visible`): when the pane
 * opens or the panel is shown again, then, while the task runs, OUTPUT_REFRESH_MS after each read has settled (one at a
 * time, so a slow answer never piles reads up or lands out of order), and once more when it ends. Nothing is read while
 * the panel is hidden: each read is a question to Claude and up to TASK_OUTPUT_MAX through the bridge.
 * @param {{ task: TaskRecord, load: (taskId: string) => Promise<{ output: string, totalBytes: number, truncated: boolean }>, visible: boolean }} props
 */
function TaskOutput({ task, load, visible }) {
  const [state, setState] = useState(/** @type {Parameters<typeof TaskOutputView>[0]['state']} */ ({ status: 'loading' }));
  const running = task.status === 'running';
  useEffect(() => {
    if (!visible) return;
    let current = true;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let timer = null;
    const read = () => load(task.taskId)
      .then(result => { if (current) setState({ status: 'ready', result }); }, error => { if (current) setState({ status: 'error', error: { code: error?.code, message: error?.message } }); })
      .finally(() => { if (current && running) timer = setTimeout(read, OUTPUT_REFRESH_MS); });
    void read();
    return () => { current = false; if (timer) clearTimeout(timer); };
  }, [task.taskId, running, visible]);
  return <TaskOutputView task={task} state={state} />;
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

/** A subagent type that names no kind of its own, as the transcript's subagent block decides. */
const GENERIC_AGENT = /^(agent|task|general-purpose)$/i;
/**
 * What an agent's row says after `Agent`: its kind when it is a named one (`Explore`), and its model once its own messages
 * named one; nothing for a command, a workflow (whose agents each have a model, in its table) or a task.
 * @param {TaskRecord} task @returns {string[]}
 */
const agentOf = (task) => taskKind(task) !== 'Agent' ? [] : [task.subagentType && !GENERIC_AGENT.test(task.subagentType) ? task.subagentType : null, modelLabel(task.model) || null].filter(Boolean);

/**
 * A task that is not a workflow: its description (else its summary, else its kind and id), then its kind (an agent's own
 * kind and model after it, see agentOf), status, tokens and tool uses, those it reported, and while
 * it runs what it does now (its progress line under the status, else the tool it last used on the status line); once it
 * ended, how (see Ending); its output under it while that is open (see TaskOutput).
 * @param {{ task: TaskRecord, nested: boolean, now: number, onStopTask: (taskId: string) => void, outputOpen?: boolean,
 *   onOutputToggle?: (taskId: string, open: boolean) => void, loadOutput?: (taskId: string) => Promise<{ output: string, totalBytes: number, truncated: boolean }>, visible?: boolean }} props
 */
export function TaskRow({ task, nested, now, onStopTask, outputOpen = false, onOutputToggle = noop, loadOutput = noOutput, visible = true }) {
  const uses = task.usage.toolUses;
  const kind = taskKind(task);
  // A task Claude reported only by its end (a background command a previous process left) has no description: it is
  // named by its summary, which is then not repeated below, else by its kind and id.
  const name = task.description || task.summary || `${kind} ${task.taskId}`;
  const found = taskDetail(task);
  const detail = !task.description && name === task.summary ? { ...found, summary: null } : found;
  return <li className="task-row" data-state={task.status} data-nested={nested ? '' : undefined}>
    <ItemHead task={task} name={name} nested={nested} className="activity-task-name" now={now} onStopTask={onStopTask} output={{ open: outputOpen, onToggle: () => onOutputToggle(task.taskId, !outputOpen) }} />
    <div className="activity-task-meta">{meta([kind, ...agentOf(task), statusWord(task.status), tokens(task.usage.totalTokens), uses ? plural(uses, 'tool use') : null, detail.tool])}</div>
    {detail.now && <div className="activity-now" title={detail.now}>{detail.now}</div>}
    <Ending detail={detail} />
    {outputOpen && <TaskOutput task={task} load={loadOutput} visible={visible} />}
  </li>;
}

/**
 * An open phase's agents as Claude Code's panel shows them: a table of Agent, Model, Tokens and Time with its header row
 * once, then a row per agent (see AgentRow). A grid of `display: contents` rows, so the columns line up across agents.
 * Which agents show their preview in full the panel keeps with its open phases (`open`, by agentKey).
 * @param {{ agents: import('../activity.js').WorkflowAgent[], taskStatus: TaskRecord['status'], keyOf: (at: number) => string, label: string,
 *   open: Set<string>, onToggle: (key: string, open: boolean) => void }} props
 */
function AgentTable({ agents, taskStatus, keyOf, open, onToggle, label }) {
  return <div className="phase-agents" role="table" aria-label={label}>
    <div className="phase-agents-head" role="row"><span role="columnheader">Agent</span><span role="columnheader">Model</span><span role="columnheader" className="num">Tokens</span><span role="columnheader" className="num">Time</span></div>
    {agents.map((agent, at) => <AgentRow key={at} agent={agent} taskStatus={taskStatus} expanded={open.has(keyOf(at))} onToggle={expand => onToggle(keyOf(at), expand)} />)}
  </div>;
}

/**
 * One agent of a workflow phase, as Claude's progress last listed it: a square for its status (in words for assistive
 * technology and in the row's tooltip, never as a word in the row), its label, model, tokens (blank while it reported no
 * spend) and duration (blank until it has one), and a preview of its result, which the stylesheet sets on a line of its
 * own under the row, cut to one line, in full on hover. Clicking the row, or its label's button from the keyboard, shows
 * that preview in full and wrapped, and again cuts it. Nothing else opens: the stream carries no agent's full output,
 * only this preview (and the workflow's output file, once it ended).
 * @param {{ agent: import('../activity.js').WorkflowAgent, taskStatus: TaskRecord['status'], expanded: boolean, onToggle: (expand: boolean) => void }} props
 */
function AgentRow({ agent, taskStatus, expanded, onToggle }) {
  const status = agentStatus(agent, taskStatus);
  const model = modelLabel(agent.model) || '';
  const time = agent.durationMs === null ? '' : formatElapsed(agent.durationMs);
  const square = <span className="agent-square" role="img" aria-label={AGENT_WORDS[status]} data-status={status} />;
  const preview = Boolean(agent.resultPreview);
  // A click toggles the preview; a drag that selected some of its text is not a click (the selection stays).
  return <div className="phase-agent" role="row" data-state={status} data-expanded={preview && expanded ? '' : undefined} title={meta([agent.label, model, tokens(agent.tokens), time, AGENT_WORDS[status]])}
    onClick={preview ? () => { if (getSelection()?.isCollapsed !== false) onToggle(!expanded); } : undefined}>
    <span role="cell" className="phase-agent-label">{preview ? <button type="button" className="agent-toggle" aria-expanded={expanded}>{square}{agent.label}</button> : <>{square}{agent.label}</>}</span>
    <span role="cell">{model}</span>
    <span role="cell" className="num">{agent.tokens ? formatTokens(agent.tokens) : ''}</span>
    <span role="cell" className="num">{time}</span>
    {agent.resultPreview && <span role="cell" className="phase-agent-result" title={agent.resultPreview}>{agent.resultPreview}</span>}
  </div>;
}

/**
 * A workflow (D3): ONE task of the process, stopped as any task is, laid out as Claude Code's own panel lays one out: its
 * name and elapsed time, `Workflow` and its status (a `Large` badge past the threshold), its agents and tokens, its
 * description, and its phases, each with how many of its agents are done and a square per agent (see phaseSquares). The
 * agents and phases come from Claude's progress report; without it, none of them. The agent the last report named is
 * the phases' tooltip while the workflow runs, and nothing once it ended. A phase whose agents Claude listed opens, by its
 * chevron, to a table of its agents (see AgentTable); one with none listed, or from an engine before the list, has no
 * chevron. Once the workflow ended, the card says how (see Ending), set apart below the phases. Which phases are open the panel keeps (`openPhases`, by
 * phaseKey), so a phase stays open when its card moves under Finished; a closed phase renders none of its agent lines, so
 * a large workflow does not redraw hundreds of them every second.
 * Its chevron opens the workflow's own output under the card (see TaskOutput).
 * @param {{ task: TaskRecord, nested: boolean, now: number, onStopTask: (taskId: string) => void, openPhases: Set<string>,
 *   onPhaseToggle: (key: string, open: boolean) => void, outputOpen?: boolean, onOutputToggle?: (taskId: string, open: boolean) => void,
 *   loadOutput?: (taskId: string) => Promise<{ output: string, totalBytes: number, truncated: boolean }>, visible?: boolean }} props
 */
export function WorkflowCard({ task, nested, now, onStopTask, openPhases, onPhaseToggle, outputOpen = false, onOutputToggle = noop, loadOutput = noOutput, visible = true }) {
  const name = task.workflowName ?? task.description;
  const { agents, phases, current, large } = workflowSummary(task);
  const agentsOf = agentsByPhase(task);
  const spent = tokens(task.usage.totalTokens);
  // Claude Code describes a workflow's task `Workflow <name>`, which says nothing the card's first two lines do not.
  const described = task.description !== name && task.description !== `Workflow ${name}` ? task.description : '';
  const ending = taskDetail(task);
  return <li className="workflow-card" data-state={task.status} data-nested={nested ? '' : undefined}>
    <ItemHead task={task} name={name} nested={nested} className="workflow-title" now={now} onStopTask={onStopTask} output={{ open: outputOpen, onToggle: () => onOutputToggle(task.taskId, !outputOpen) }} />
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
          {open && <AgentTable agents={listed} taskStatus={task.status} keyOf={at => agentKey(task.taskId, index, at)} open={openPhases} onToggle={onPhaseToggle} label={`${phase.title} agents`} />}
        </details>;
      })}
    </div>}
    {(ending.summary || ending.output) && <div className="workflow-ending"><Ending detail={ending} /></div>}
    {outputOpen && <TaskOutput task={task} load={loadOutput} visible={visible} />}
  </li>;
}

/**
 * One of the conversation's child tasks (a Jolo delegation): its title, which opens the child's conversation, the time
 * since its delegation started (frozen once its run ended; blank without a delegation row), and while it runs a square
 * stop as a task row has, which cancels its run; then `Child`, who answers it and what it is doing (see delegationWords),
 * and `Needs you` with the alert mark when it waits on the user.
 * @param {{ row: ReturnType<typeof childRows>[number], onOpenTask: (sessionId: string) => void, onStopChild: (runId: string) => void }} props
 */
function ChildRow({ row, onOpenTask, onStopChild }) {
  const { task, delegation, running, elapsed, stopRunId } = row;
  const title = task.title || 'Child task';
  const identity = [task.answerer?.displayName, modelLabel(task.answerer?.model ?? task.run?.execution?.model)].filter(Boolean).join(' · ');
  return <li className="task-row child-task-row" data-state={running ? 'running' : 'done'} data-session-id={task.sessionId}>
    <div className="item-head">
      <button type="button" className="child-task-open" title={`Open ${title}`} onClick={() => onOpenTask(task.sessionId)}>{title}</button>
      <span className="activity-elapsed">{elapsed}</span>
      {running && stopRunId && <button type="button" className="icon-button stop-task" aria-label={`Stop ${title}`} title="Stop" onClick={() => onStopChild(stopRunId)}><Icon name="stop" size={14} /></button>}
    </div>
    <div className="activity-task-meta">{meta(['Child', identity, delegation ? delegationWords(delegation) : null])}{task.attention === 'needs_you' && <>{' · '}<span className="child-needs"><Icon name="alert" size={12} />Needs you</span></>}</div>
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
 * and a task started by another of the same list drawn under it (see nestTasks). Between the running and the finished
 * ones, the conversation's child tasks (Jolo delegations) under `Child tasks` (see childRows and ChildRow), loaded by the
 * pane with their delegation rows; their stops cancel their runs, and Stop background work and Clear finished, which are
 * the process's, leave them be.
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
 *   childTasks?: import('../activity.js').ChildTask[],
 *   delegations?: Map<string, import('../activity.js').DelegationRow>,
 *   onOpenTask?: (sessionId: string) => void,
 *   onStopChild?: (runId: string) => void,
 *   loadTaskOutput?: (taskId: string) => Promise<{ output: string, totalBytes: number, truncated: boolean, source?: 'process' | 'file' }>,
 * }} props `stopping` while a Stop background work waits for its reply; `visible` while the panel is on screen;
 * `loadTaskOutput` reads a task's output, from the process or, for what it cannot serve, the task's output file.
 */
export function ActivityPanel({ activity, stopResult, stopping, visible, cleared, onStopAll, onStopTask, onForceStop, onClear, childTasks = NO_CHILDREN, delegations = NO_DELEGATIONS, onOpenTask = noop, onStopChild = noop, loadTaskOutput = noOutput }) {
  const [, tick] = useReducer((/** @type {number} */ count) => count + 1, 0);
  const [openPhases, setOpenPhases] = useState(() => /** @type {Set<string>} */ (new Set()));
  const onPhaseToggle = (/** @type {string} */ key, /** @type {boolean} */ open) => setOpenPhases(current => {
    if (current.has(key) === open) return current;
    const next = new Set(current);
    if (open) next.add(key);
    else next.delete(key);
    return next;
  });
  // Which tasks show their output, kept here as the open phases are, so a pane stays open when its task moves under Finished.
  const [openOutputs, setOpenOutputs] = useState(() => /** @type {Set<string>} */ (new Set()));
  const onOutputToggle = (/** @type {string} */ taskId, /** @type {boolean} */ open) => setOpenOutputs(current => {
    if (current.has(taskId) === open) return current;
    const next = new Set(current);
    if (open) next.add(taskId);
    else next.delete(taskId);
    return next;
  });
  const { running, finished } = groupActivity(activity, cleared);
  const now = Date.now();
  const children = childRows(childTasks, delegations, now);
  const ticking = visible && (running.length > 0 || children.some(row => row.running));
  // Elapsed times move once a second while something runs and the panel is shown; nothing ticks otherwise, and showing
  // the panel again renders it with the current time.
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  // A task is drawn under the task in the same list that started it (see nestTasks).
  const item = (/** @type {{ task: TaskRecord, nested: boolean }} */ { task, nested }) => taskKind(task) === 'Workflow'
    ? <WorkflowCard key={task.taskId} task={task} nested={nested} now={now} onStopTask={onStopTask} openPhases={openPhases} onPhaseToggle={onPhaseToggle} outputOpen={openOutputs.has(task.taskId)} onOutputToggle={onOutputToggle} loadOutput={loadTaskOutput} visible={visible} />
    : <TaskRow key={task.taskId} task={task} nested={nested} now={now} onStopTask={onStopTask} outputOpen={openOutputs.has(task.taskId)} onOutputToggle={onOutputToggle} loadOutput={loadTaskOutput} visible={visible} />;
  return <div className="activity-panel">
    <div className="activity-heading">
      <strong>Activity</strong>
      <span className="activity-actions">
        {running.length > 0 && <button type="button" disabled={stopping} onClick={onStopAll}>{stopping ? 'Stopping…' : 'Stop background work'}</button>}
        {finished.length > 0 && <button type="button" className="icon-button" aria-label="Clear finished" title="Clear finished" onClick={() => onClear(clearFinished(activity, cleared))}><Icon name="trash" size={14} /></button>}
        {!running.length && !finished.length && !children.length && <span className="muted">Nothing running</span>}
      </span>
    </div>
    {forceStopOffered(activity, stopResult) && <p className="panel-note" role="status"><span>Some tasks did not stop</span><button type="button" onClick={onForceStop}>Force stop</button></p>}
    {running.length > 0 && <ol className="activity-list">{nestTasks(running).map(item)}</ol>}
    {/* Conversations of their own, not the process's tasks: Stop background work and Clear finished leave them be. */}
    {children.length > 0 && <section className="child-tasks" aria-label="Child tasks">
      <h3 className="activity-section-label">Child tasks</h3>
      <ol className="activity-list">{children.map(row => <ChildRow key={row.task.sessionId} row={row} onOpenTask={onOpenTask} onStopChild={onStopChild} />)}</ol>
    </section>}
    {finished.length > 0 && <details open className="finished-tasks">
      <summary><span>{`Finished ${finished.length}`}</span><Icon name="chevron" size={12} className="activity-disclosure" /></summary>
      <ol className="activity-list">{nestTasks(finished).map(item)}</ol>
    </details>}
    {activity?.truncated && <p className="panel-note">Older finished tasks are not listed</p>}
  </div>;
}
