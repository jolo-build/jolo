import { modelLabel } from '../model-options.js';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { Markdown } from "./markdown.jsx";
import { Icon } from "./icon.jsx";
import { diffSummary } from "../diff-lines.js";
import { DiffLines } from './diff-lines.jsx';
import { JoloLogo } from "./brand.jsx";
import { basename, runLabel, screenshotArtifactId } from "../presentation.js";
import { editedFiles, parseSubagent, shortStep } from "../subagent.js";
import { delegationChild, delegationWords, liveDelegation, parseDelegationCall } from "../delegation.js";
import { formatElapsed, phaseSquares, plural, squaresInWords, statusWord, workflowSummary } from "../activity.js";
import { parseWorkflowCall, workflowCardShown, workflowLaunched, workflowTasksFor } from "../workflow-call.js";
import { TERMINAL } from "@jolo/client/run-state";
import { relativeTime } from "@jolo/client/board";
import { ChangeSummary } from './change-summary.jsx';
import { fileDiffSections, readChangeCards, saveChangeCards, updateChangeCards } from '../change-cards.js';
import { ImageAttachment } from './image-attachment.jsx';
import { TextAttachment } from './text-attachment.jsx';
import { CopyButton } from './copy-button.jsx';

const CHUNK = 65535; // divisible by 3 so base64 chunks concatenate cleanly

// Inspect only the tool name, so words in a command or file path cannot change its icon.
function toolIcon(head) {
  const name = head.trim().split(/[\s({:]/, 1)[0].split(/__|[/.]/).at(-1).replaceAll(/[_-]/g, '').toLowerCase();
  if (/^(bash|shell|command|commandexecution|runcommand|execcommand|execute|terminal|writestdin)/.test(name)) return 'command';
  if (/^(browser|web|fetch)/.test(name)) return 'browser';
  if (/^(search|grep|glob|find)/.test(name)) return 'search';
  if (/^(viewimage|readimage|imageread|imageview|screenshot)/.test(name)) return 'image';
  if (/^(applypatch|revertpatch|replace|edit|write|filechange|notebookedit|delete|move)/.test(name)) return 'edit';
  if (/^(read|file|list|ls$)/.test(name)) return 'file';
  if (/^(plan|todo|updateplan)/.test(name)) return 'plan';
  if (/^(agent|task|spawn|delegate)/.test(name)) return 'agents';
  if (/^(wait|sleep)/.test(name)) return 'clock';
  return 'tools';
}

const runIcons = { queued: 'clock', preparing: 'spinner', model: 'spinner', tools: 'spinner', awaiting_permission: 'shield', cancelling: 'spinner', completed: 'check', failed: 'alert', interrupted: 'stop' };

function ActivityIcon({ name, active = false }) {
  return <Icon name={name} size={16} className={`activity-icon${active && name === 'spinner' ? ' activity-spin' : ''}`} />;
}

function activityIdentity(run, { assistantName, assistantAgentId, agents, providerModel }) {
  const guestId = run?.agentId ?? run?.execution?.agentId;
  const agentId = guestId ?? assistantAgentId;
  const native = !agentId || agentId === 'jolo';
  const agent = agents.find(entry => entry.id === agentId);
  const name = guestId === 'jolo' ? 'Jolo' : agent?.displayName ?? (guestId || assistantName);
  const model = modelLabel(run?.execution?.model || (native ? providerModel : agent?.model));
  return model ? `${name} · ${model}` : name;
}

function guestName(run, { assistantAgentId, agents }) {
  const agentId = run?.agentId ?? run?.execution?.agentId;
  if (!agentId || agentId === (assistantAgentId ?? 'jolo')) return null;
  return agentId === 'jolo' ? 'Jolo' : agents.find(entry => entry.id === agentId)?.displayName ?? agentId;
}

/** Reads a stored PNG artifact through the bridge and shows it; used for browser_screenshot results. */
/** The diff a tool call produced, drawn where the call is, from the artifact the engine kept (§9.3). */
function DiffPreview({ artifactId }) {
  const [text, setText] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const response = await window.jolo.call("artifact.read", { artifactId });
      if (cancelled) return;
      if (!response.ok) { setFailed(true); return; }
      setText(response.result.text);
    })();
    return () => { cancelled = true; };
  }, [artifactId]);
  if (failed) return null;
  if (text === null) return <p className="hint deferred">Loading changes…</p>;
  const counts = diffSummary(text);
  return <div className="tool-diff">
    <div className="tool-diff-head">{counts.files === 1 ? <span title={counts.paths[0]}>{counts.paths[0].split("/").at(-1)}</span> : `${counts.files} files`}<span className="diff-added">+{counts.added}</span><span className="diff-removed">−{counts.removed}</span></div>
    <div className="diff" aria-label="What this change did">
      <DiffLines text={text} />
    </div>
  </div>;
}

function ScreenshotPreview({ artifactId }) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let offset = 0;
      let base64 = "";
      for (;;) {
        const response = await window.jolo.call("artifact.read", { artifactId, offset, length: CHUNK, encoding: "base64" });
        if (!response.ok || response.result.bytes === 0) break;
        base64 += response.result.text;
        offset += response.result.bytes;
        if (response.result.eof) break;
      }
      if (!cancelled && base64) setSrc(`data:image/png;base64,${base64}`);
    })().catch(() => {});
    return () => { cancelled = true; };
  }, [artifactId]);
  return src ? <img className="screenshot" src={src} alt="browser screenshot" /> : <span className="hint deferred">loading screenshot…</span>;
}

/**
 * The projection grows a message in place, so the fields that change arrive as their own props: memo
 * compares them, and a finished tool is neither split nor redrawn on every tick of a later reply.
 * @typedef {{ text: string, status: string, committedBytes: number, renderedBytes: number, diffArtifactId?: string | null }} ToolBlockProps
 */
const ToolBlock = memo(function ToolBlock(/** @type {ToolBlockProps} */ { text, status, committedBytes, renderedBytes, diffArtifactId }) {
  const [head, rest] = useMemo(() => { const at = text.indexOf("\n"); return at < 0 ? [text, ""] : [text.slice(0, at), text.slice(at + 1)]; }, [text]);
  const [expanded, setExpanded] = useState(false);
  const loading = !head && committedBytes > renderedBytes;
  const screenshot = status === "streaming" ? null : screenshotArtifactId(text);
  return (
    <details className="block tool" onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary className={loading ? 'deferred' : undefined}><ActivityIcon name={loading ? 'spinner' : toolIcon(head)} active={loading || status === "streaming"} /><span>{head || (loading ? "Loading tool…" : "Tool")}{status === "streaming" ? " …" : ""}</span><Icon name="chevron" size={12} className="activity-disclosure" /></summary>
      {expanded && <>
        {diffArtifactId && <DiffPreview artifactId={diffArtifactId} />}
        {screenshot ? <ScreenshotPreview artifactId={screenshot} /> : !text && committedBytes > renderedBytes ? <p className="hint deferred" role="status">Loading tool output…</p> : diffArtifactId ? <details className="block tool-output"><summary>Output<Icon name="chevron" size={12} className="activity-disclosure" /></summary><pre>{rest}</pre></details> : <pre>{rest}</pre>}
      </>}
    </details>
  );
});

/**
 * One of the agent's own subagents, on its own line where the call is: its kind, model and purpose, with what it is doing
 * now while it works. Opening it lists the tools it used and its report.
 * @typedef {{ text: string, status: string, messageId: string, sessionId?: string | null, onReview?: () => void }} SubagentBlockProps
 */
const SubagentBlock = memo(function SubagentBlock(/** @type {SubagentBlockProps} */ { text, status, messageId, sessionId, onReview }) {
  const agent = useMemo(() => parseSubagent(text), [text]);
  const [expanded, setExpanded] = useState(false);
  if (!agent) return null;
  const working = status === "streaming";
  // The purpose leads. The kind is named only when it is a special one, and the model follows; edits are counted once it is done.
  const kind = /^(agent|task|general-purpose)$/i.test(agent.type) ? null : agent.type;
  const meta = [kind, modelLabel(agent.model)].filter(Boolean).join(" · ");
  const files = editedFiles(agent.steps);
  const now = working && agent.steps.length > 0 ? agent.steps.at(-1) : null;
  return <div className={`subagent${working ? " working" : ""}`}>
    <details className="block subagent-block" onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary><ActivityIcon name={working ? "spinner" : "agents"} active={working} /><span className="subagent-title">{agent.description || meta || "Subagent"}</span>{agent.description && meta && <span className="subagent-meta">{meta}</span>}{!working && files.length > 0 && <span className="subagent-meta">{files.length} {files.length === 1 ? "file" : "files"} edited</span>}<Icon name="chevron" size={12} className="activity-disclosure" /></summary>
      {expanded && <div className="subagent-body">
        {files.length > 0 && <ul className="subagent-files" aria-label="Files it edited">{files.map(file => <li key={file}><button type="button" title={file} onClick={onReview}>{basename(file)}</button></li>)}</ul>}
        {agent.steps.length > 0 && <ol className="subagent-steps" aria-label="Tools it used">{agent.steps.map((step, index) => <li key={index}>{step}</li>)}</ol>}
        {agent.report ? <div className="subagent-report"><Markdown text={agent.report} cacheKey={`${messageId}:report`} sessionId={sessionId} streaming={false} /></div>
          : <p className="hint">{working ? "Still working…" : "No report."}</p>}
      </div>}
    </details>
    {now && <div className="subagent-now" title={now}>{shortStep(now)}</div>}
  </div>;
});

/**
 * One of Jolo's delegation calls, on its own line where the call is: the child it is about and what that child is doing,
 * with a way into the child's conversation, and a spinner while the call itself is still going (a wait, say). The live
 * `delegation.list` row wins over the result, which the engine cuts short; opening it shows the raw call. `wakeReason` is
 * why the newest later wait on the same child ended, when that wait joined the actions instead of a line of its own.
 * @typedef {{ text: string, status: string, delegations: Map<string, any>, wakeReason?: string | null, onOpenSession?: (sessionId: string) => void }} DelegationBlockProps
 */
const DelegationBlock = memo(function DelegationBlock(/** @type {DelegationBlockProps} */ { text, status, delegations, wakeReason = null, onOpenSession }) {
  const call = useMemo(() => parseDelegationCall(text), [text]);
  const [expanded, setExpanded] = useState(false);
  if (!call) return null;
  /** @type {Record<string, any>} */
  const child = { ...liveDelegation(call, delegations), ...(wakeReason ? { wakeReason } : {}) };
  const title = child.title || call.args.title;
  const words = delegationWords(child) || call.error || '';
  const working = status === "streaming";
  return <div className="delegation-block">
    <details className="block delegation-details" onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary><ActivityIcon name={working ? "spinner" : "agents"} active={working} /><span className="delegation-title">{title ? `Child ${title}` : 'Child task'}</span>{words && <span className="delegation-words" title={words}>{words}</span>}<Icon name="chevron" size={12} className="activity-disclosure" /></summary>
      {expanded && <pre>{text}</pre>}
    </details>
    {child.sessionId && <button type="button" className="delegation-open" onClick={() => onOpenSession?.(child.sessionId)}>Open</button>}
  </div>;
});

/**
 * One of Claude's Workflow calls, as a compact card where the call is, as Claude Code's own transcript shows one: the
 * workflow's name, then `Workflow`, its agents and elapsed time (and its end word once it ended), then a square per agent
 * across all its phases in order. The head opens the Activity panel, where the workflow's phases, agents and stop are;
 * the card has no raw view and no stop of its own. With no task of its name (one of an earlier process, or a call that
 * failed), it says the first line of the tool's reply instead, the whole of it on hover. The elapsed time moves once a
 * second while the workflow runs, and nothing ticks otherwise.
 * @typedef {{ call: { name: string | null, reply: string }, task: import('../activity.js').TaskRecord | null, onOpenActivity?: () => void }} WorkflowCallBlockProps
 */
const WorkflowCallBlock = memo(function WorkflowCallBlock(/** @type {WorkflowCallBlockProps} */ { call, task, onOpenActivity }) {
  const [, tick] = useReducer((/** @type {number} */ count) => count + 1, 0);
  const running = task?.status === 'running';
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [running]);
  const name = task?.workflowName ?? call.name ?? 'Workflow';
  const summary = task ? workflowSummary(task) : null;
  const squares = task ? summary.phases.flatMap(phase => phaseSquares(phase, task.status)) : [];
  return <div className="workflow-call" data-state={task?.status ?? 'unknown'}>
    <button type="button" className="workflow-call-head" aria-label={`Show ${name} in Activity`} onClick={onOpenActivity}>
      <span className="workflow-call-title">{name}</span><Icon name="chevron" size={12} className="activity-disclosure" />
    </button>
    <div className="workflow-call-meta">
      <span>Workflow</span>
      {summary && summary.agents !== null && <span>{plural(summary.agents, 'agent')}</span>}
      {task && <span>{formatElapsed((task.endedAt ? Date.parse(task.endedAt) : Date.now()) - Date.parse(task.startedAt))}</span>}
      {task && task.status !== 'running' && <span>{statusWord(task.status)}</span>}
      {!task && call.reply && <span className="workflow-call-reply" title={call.reply}>{call.reply.split('\n', 1)[0]}</span>}
    </div>
    {squares.length > 0 && <div className="phase-squares" role="img" aria-label={squaresInWords(squares)}>{squares.map((status, at) => <span key={at} data-status={status} />)}</div>}
  </div>;
});

/** The run states in which work is going on: its note's icon turns. */
const WORKING_RUN_STATES = ['preparing', 'model', 'tools', 'cancelling'];

const ReasoningBlock = memo(function ReasoningBlock(/** @type {{ text: string, status: string }} */ { text, status }) {
  const working = status === "streaming";
  if (!text.trim()) return <div className={`reasoning-pending${working ? '' : ' deferred'}`} role="status"><ActivityIcon name={working ? 'think' : 'spinner'} active /><span>{working ? "Thinking…" : "Loading reasoning…"}</span></div>;
  return (
    <details className="block reasoning">
      <summary><ActivityIcon name="think" active={working} /><span>Reasoning{working ? " …" : ""}</span><Icon name="chevron" size={12} className="activity-disclosure" /></summary>
      <pre>{text}</pre>
    </details>
  );
});

/** The exact date and time of `iso`, as a message's time says it on hover: `Oct 24, 2026, 3:42 PM`. */
const exactTime = (/** @type {string} */ iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * One turn of the transcript. Its text grows in place, so what grows is passed beside it for memo to compare.
 * A text message with text ends with a row, shown on hover, to copy it and say when it was sent (`5m ago` against
 * `now`, which moves once a minute); `createdAt` is absent for a message from an engine that sends no time.
 * @typedef {{
 *   message: import('@jolo/client/projection').ProjectedMessage,
 *   text: string,
 *   status: string,
 *   committedBytes: number,
 *   renderedBytes: number,
 *   createdAt?: string,
 *   now: number,
 *   run: any,
 *   guestName: string | null,
 *   assistantName: string,
 *   sessionId?: string | null,
 * }} MessageArticleProps
 */
const MessageArticle = memo(function MessageArticle(/** @type {MessageArticleProps} */ { message, text, status, committedBytes, renderedBytes, createdAt, now, run, guestName, assistantName, sessionId }) {
  const assistant = message.role === "assistant";
  const tools = message.kind === "text" && Boolean(text) && !message.evicted && !message.loadError;
  return <article data-message-id={message.id} className={`message ${message.role} ${message.kind}${status === "streaming" ? " streaming" : ""}`} aria-label={message.role === "user" ? "Your message" : undefined}>
    {message.role === 'user' && run?.requestId?.startsWith('web_') && <p className="message-source">Sent from the web</p>}
    {message.role === 'user' && run?.attachments?.length > 0 && <div className="message-attachments">{run.attachments.map((attachment, index) => !attachment.mimeType.startsWith('image/') ? <TextAttachment key={attachment.artifactId} attachment={attachment} /> : <ImageAttachment key={`${attachment.artifactId}:${index}`} attachment={attachment} />)}</div>}
    {message.role === 'user' && run?.taskReferences?.length > 0 && <div className="message-task-references" aria-label="Referenced web tasks">{run.taskReferences.map(task => <button type="button" key={task.url} title={`${task.team?.name ?? 'Personal'} · ${task.title} · revision ${task.revision}`} onClick={() => window.jolo.openExternal(task.url).catch(() => {})}><strong>#{task.key}</strong> {task.title}<span>{task.team?.name ?? 'Personal'} · r{task.revision} ↗</span></button>)}</div>}
    {message.role !== "user" && (assistant && !guestName ? <div className="message-label sr-only">{assistantName}</div> : <div className="message-label" title={guestName ? 'Called in for this message' : undefined}>{assistant ? guestName : message.role}</div>)}
    {!text && committedBytes > renderedBytes ? <p className="hint deferred" role="status">Loading message…</p> : assistant && message.kind === "text" ? <Markdown text={text} cacheKey={message.id} sessionId={run?.sessionId ?? sessionId} streaming={status === "streaming"} /> : <div className="message-text">{text}</div>}
    {tools && <div className="message-tools">
      <CopyButton className="message-copy" label="Copy message" title="Copy message" text={text} />
      {createdAt && <time className="message-time" dateTime={createdAt}><span className="message-time-ago">{relativeTime(createdAt, now)}</span><span className="message-time-exact" aria-hidden="true">{exactTime(createdAt)}</span></time>}
    </div>}
  </article>;
});

function ActivityGroup({ messages, identity, guest, runState, hasRunStatus = false }) {
  const working = messages.some((message) => message.status === "streaming");
  const tools = messages.filter((message) => message.kind === "tool").length;
  if (!tools && !messages.some((message) => message.text.trim())) {
    if (working && hasRunStatus) return null;
    return <div className={`activity-pending${working ? '' : ' deferred'}`} role="status" title={identity}><ActivityIcon name="spinner" active /><span>{working ? `Thinking…${guest ? ` · ${guest}` : ''}` : "Loading reasoning…"}</span></div>;
  }
  // Background commands may span several replies. Their individual rows stay
  // live, while the task has one authoritative progress line below the transcript.
  // A completed tool is only a gap in the run, not task completion. Keep
  // the disclosure icon steady until the owning run explicitly completes.
  const label = tools ? `${tools} ${tools === 1 ? 'action' : 'actions'}` : 'Reasoning';
  return <details className="activity-group"><summary><ActivityIcon name={runState === 'completed' ? 'check' : tools ? 'tools' : 'think'} /><span className="activity-label" title={identity}>{label}</span><Icon name="chevron" size={12} className="activity-disclosure" /></summary><div className="activity-steps">{messages.map((message) => message.kind === "tool"
    ? <ToolBlock key={message.id} text={message.text} status={message.status} committedBytes={message.committedBytes} renderedBytes={message.renderedBytes} diffArtifactId={message.diffArtifactId} />
    : <ReasoningBlock key={message.id} text={message.text} status={message.status} />)}</div></details>;
}

const NO_DELEGATIONS = new Map();

/** How far a Workflow call's task may have started outside its run's own times: the engine stamps each separately. */
const RUN_SLACK_MS = 5000;

/**
 * The transcript's lines from its messages: a subagent, a delegated child, a Workflow call each on a line of their own (a
 * later call about a child whose line is shown joins the actions instead), the other tool calls and reasoning of a run
 * together in one collapsed group, and every other message as itself. `workflowCalls` names each Workflow call's card for
 * workflowTasksFor. Pure: the same messages and runs give the same lines.
 * @param {any[]} messages @param {Map<string, any> | undefined} runs
 */
export function groupMessages(messages, runs) {
  /** @type {any[]} */
  const groups = [];
  /** @type {(import('../workflow-call.js').WorkflowCallSlot & { id: string })[]} */
  const workflowCalls = [];
  // Each child's line is its delegate_task call's: by the delegation id its result names, else, while it has no result,
  // by its title. A later status or cancel call about a child whose line is here joins the actions instead of repeating
  // it, and hands the line the reason its wait ended; one whose child's line is not loaded keeps a line of its own.
  /** @type {{ byId: Map<string, any>, byTitle: Map<string, any> }} */
  const childLines = { byId: new Map(), byTitle: new Map() };
  for (const message of messages) {
    // A provider may complete a thinking block without a displayable summary.
    // Keep pending artifact loads visible, but never leave an empty disclosure.
    if (message.kind === "reasoning" && !message.evicted && !message.loadError && !message.text.trim() && message.status !== "streaming" && (message.renderedBytes ?? 0) >= (message.committedBytes ?? 0)) continue;
    const parsedWorkflow = message.kind === "tool" && !message.evicted && !message.loadError ? parseWorkflowCall(message.text) : null;
    // A call that answered with anything but its launch (an error, a refusal) started nothing: it is one of its run's
    // actions, with no card and no claim on a task, and Claude says what went wrong in its own words.
    const workflowCall = parsedWorkflow && (message.status === "streaming" || !parsedWorkflow.reply || workflowLaunched(parsedWorkflow.reply)) ? parsedWorkflow : null;
    const delegationCall = message.kind === "tool" && !message.evicted && !message.loadError ? parseDelegationCall(message.text) : null;
    let childLine = null;
    if (delegationCall && delegationCall.name !== "delegate_task") {
      const { id, title } = delegationChild(delegationCall);
      childLine = (id && childLines.byId.get(id)) || (title && childLines.byTitle.get(title)) || null;
      if (childLine && delegationCall.delegation?.wakeReason) childLine.wakeReason = delegationCall.delegation.wakeReason;
    }
    // The agent's own subagents stand on their own line, so their work shows without opening the activity.
    if (message.kind === "tool" && !message.evicted && !message.loadError && parseSubagent(message.text)) groups.push({ type: "subagent", id: message.id, runId: message.runId, message });
    // So do Jolo's delegation calls: one line for the child they are about, instead of a raw JSON tool block.
    else if (delegationCall && !childLine) {
      groups.push({ type: "delegation", id: message.id, runId: message.runId, message, wakeReason: null });
      if (delegationCall.name === "delegate_task") {
        const { id, title } = delegationChild(delegationCall);
        if (id) childLines.byId.set(id, groups.at(-1));
        else if (title && !delegationCall.error) childLines.byTitle.set(title, groups.at(-1)); // a start that failed started nothing
      }
    }
    // And Claude's Workflow calls: a compact card for the workflow, with its task when the activity still has it.
    else if (workflowCall) {
      groups.push({ type: "workflow", id: message.id, runId: message.runId, message, call: workflowCall });
      workflowCalls.push({ id: message.id, name: workflowCall.name, window: runWindow(runs?.get(message.runId)) });
    }
    else if (!message.evicted && !message.loadError && ["tool", "reasoning"].includes(message.kind)) {
      if (groups.at(-1)?.type === "activity" && groups.at(-1).runId === message.runId) groups.at(-1).messages.push(message);
      else groups.push({ type: "activity", id: message.id, runId: message.runId, messages: [message] });
    } else groups.push({ type: "message", id: message.id, message });
  }
  return { groups, workflowCalls };
}

/**
 * The window a Workflow call's task can have started in (see workflowTasksFor): its run's, from when it was created to
 * when it ended, a little either side, and open while it goes on. Null for a run the projection does not know, or knows
 * without when it was created (one first seen through a usage event).
 * @param {{ state?: string, createdAt?: string, updatedAt?: string } | undefined} run
 * @returns {{ from: number, to: number } | null}
 */
function runWindow(run) {
  const created = run?.createdAt ? Date.parse(run.createdAt) : NaN;
  if (!Number.isFinite(created)) return null;
  const ended = TERMINAL.has(run.state) && run.updatedAt ? Date.parse(run.updatedAt) : NaN;
  return { from: created - RUN_SLACK_MS, to: Number.isFinite(ended) ? ended + RUN_SLACK_MS : Infinity };
}

export function Conversation({ projection, sessionId, history, hasProject, standalone = false, onReview, onOpenFolder, assistantName = "Jolo", assistantAgentId = null, providerModel = null, agents = [], delegations = NO_DELEGATIONS, onOpenSession = undefined, activity = null, onOpenActivity = undefined }) {
  const container = useRef(null);
  const follow = useRef(true);
  const lastScrollTop = useRef(0);
  const touchY = useRef(null);
  const historyAnchor = useRef(null);
  const adjustedTop = useRef(null);
  const [changeCards, setChangeCards] = useState(() => readChangeCards(sessionId));
  // One clock for every message's `5m ago`: it moves once a minute, and `now` changes only then, so a streaming tick
  // still leaves a finished message's memo alone.
  const [minute, nextMinute] = useReducer((/** @type {number} */ count) => count + 1, 0);
  useEffect(() => {
    const timer = setInterval(nextMinute, 60_000);
    return () => clearInterval(timer);
  }, []);
  const now = useMemo(() => Date.now(), [minute]);
  const recordCounts = useCallback((runId, counts) => setChangeCards(cards => cards.map(card => card.runId === runId ? { ...card, counts } : card)), []);
  const loadRunDiff = useCallback(async (path, file) => {
    if (!file?.diffArtifactIds?.length) return { source: 'none', diff: '', truncated: false };
    let diff = '', truncated = false;
    for (const artifactId of file.diffArtifactIds) {
      const response = await window.jolo.call('artifact.read', { artifactId, length: 64 * 1024 });
      if (!response.ok) throw new Error(response.error.message);
      diff += fileDiffSections(response.result.text, path);
      truncated ||= !response.result.eof || response.result.text.includes('…');
    }
    return { source: 'artifact', diff, truncated };
  }, []);
  const messages = projection ? projection.ordered() : [];
  // Only a conversation known to be empty opens on the message bar; one still loading shows nothing meanwhile.
  const empty = !messages.length && (!sessionId || Boolean(history?.seeded));
  const runs = projection ? [...projection.runs.values()] : [];
  const captureAnchor = () => {
    const el = container.current;
    const top = el.getBoundingClientRect().top;
    // Articles retain their identity when adjacent tool groups combine across
    // a page boundary. Fall back to the scroll height for tool-only pages.
    const node = [...el.querySelectorAll('[data-message-id]')].find(node => node.getBoundingClientRect().bottom > top);
    return { id: node?.dataset.messageId, offset: node ? node.getBoundingClientRect().top - top : 0, height: el.scrollHeight, scrollTop: el.scrollTop };
  };
  const loadOlder = () => {
    if (!history?.hasOlder || history.loading) return;
    follow.current = false;
    historyAnchor.current = captureAnchor();
    void history.loadOlder();
  };
  useLayoutEffect(() => {
    const el = container.current;
    if (!el) return;
    const anchor = historyAnchor.current;
    if (anchor) {
      const node = [...el.querySelectorAll('[data-message-id]')].find(node => node.dataset.messageId === anchor.id);
      el.scrollTop = node ? el.scrollTop + node.getBoundingClientRect().top - el.getBoundingClientRect().top - anchor.offset
        : anchor.scrollTop + el.scrollHeight - anchor.height;
      adjustedTop.current = el.scrollTop;
      if (!history?.loading) historyAnchor.current = null;
    } else if (follow.current && el.scrollHeight - el.clientHeight - el.scrollTop > 1) el.scrollTop = el.scrollHeight;
    lastScrollTop.current = el.scrollTop;
  });
  useLayoutEffect(() => {
    const el = container.current;
    let frame = 0;
    // Images, diagrams, and expanded tools can grow between React commits.
    // Coalesce those changes and follow only while the reader is at the end.
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!follow.current || historyAnchor.current) return;
        el.scrollTop = el.scrollHeight;
        lastScrollTop.current = el.scrollTop;
      });
    });
    observer.observe(el);
    observer.observe(el.firstElementChild);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, []);
  // A first page too short to scroll never reaches the scroll load, so it fills the view itself without detaching the reader.
  useEffect(() => {
    const el = container.current;
    if (!history?.hasOlder || history.loading || history.error || !el.clientHeight || el.scrollHeight > el.clientHeight + 100) return;
    const following = follow.current;
    loadOlder();
    follow.current = following;
  });
  const activeRun = runs.find(run => ['preparing', 'model', 'tools', 'awaiting_permission', 'cancelling'].includes(run.state));
  const thinking = activeRun?.state === 'model' && messages.some(message => message.runId === activeRun.id && message.kind === 'reasoning' && message.status === 'streaming');
  // Queued messages (and ones removed before starting) have no transcript yet.
  // Their status must not replace the turn the conversation is displaying.
  const lastRun = activeRun ?? projection?.runs.get(messages.at(-1)?.runId) ?? runs.filter(run => ['failed', 'interrupted'].includes(run.state)).at(-1);
  // A run is replaced whenever it changes and kept otherwise, so the identities say whether the
  // signature must be rebuilt; a streaming tick then serializes nothing.
  const runsSeen = useRef({ runs: /** @type {any[]} */ ([]), signature: '[]' });
  if (runsSeen.current.runs.length !== runs.length || runs.some((run, index) => run !== runsSeen.current.runs[index])) {
    runsSeen.current = { runs, signature: JSON.stringify(runs.map(({ id, state, changedPaths, changeEvents }) => ({ id, state, changedPaths, changeEvents }))) };
  }
  const changesSignature = runsSeen.current.signature;
  useEffect(() => {
    setChangeCards(cards => updateChangeCards(cards, JSON.parse(changesSignature)));
  }, [changesSignature]);
  useEffect(() => { saveChangeCards(sessionId, changeCards); }, [sessionId, changeCards]);
  const identityFor = run => activityIdentity(run, { assistantName, assistantAgentId, providerModel, agents });
  const guestFor = run => guestName(run, { assistantAgentId, agents });
  const lastGuest = guestFor(lastRun);
  // The lines depend on the messages (their text, by how much of it is in, and their state) and the runs' windows, not on
  // the activity: an activity snapshot alone, up to four a second during background work, reuses them and every call
  // parsed in them, so only the Workflow cards, whose tasks it carries, render again.
  const groupingKey = `${messages.map(m => `${m.id}\u0001${m.status}\u0001${m.renderedBytes ?? 0}\u0001${m.committedBytes ?? 0}\u0001${m.evicted ? 1 : 0}\u0001${m.loadError ? 1 : 0}`).join('\u0002')}\u0003${runs.map(run => `${run.id}\u0001${run.state ?? ''}\u0001${run.createdAt ?? ''}\u0001${run.updatedAt ?? ''}`).join('\u0002')}`;
  const grouped = useMemo(() => groupMessages(messages, projection?.runs), [groupingKey]);
  // Each Workflow call's card is about the task of its workflow's name that started during its run (see workflowTasksFor).
  const workflowTasks = useMemo(() => {
    const callTasks = workflowTasksFor(grouped.workflowCalls, activity);
    return new Map(grouped.workflowCalls.map((slot, index) => [slot.id, callTasks[index]]));
  }, [grouped, activity]);
  // A Workflow card stays only while it is worth showing (see workflowCardShown). Where one leaves, the actions of its run
  // on either side of it read as one group again, as they would have with no card between them.
  /** @type {any[]} */
  const groups = [];
  for (const group of grouped.groups) {
    if (group.type === "workflow") {
      const run = projection?.runs.get(group.runId);
      // A paused run is not going: one a later prompt superseded never resumes, and its launch's task is long gone.
      const runGoing = Boolean(run && (WORKING_RUN_STATES.includes(run.state) || ['queued', 'awaiting_permission'].includes(run.state)));
      const shown = workflowCardShown(workflowTasks.get(group.id) ?? null, { status: group.message.status, reply: group.call.reply, runGoing });
      if (!shown) continue;
    }
    const before = groups.at(-1);
    if (group.type === "activity" && before?.type === "activity" && before.runId === group.runId) groups[groups.length - 1] = { ...before, messages: [...before.messages, ...group.messages] };
    else groups.push(group);
  }
  if (lastRun && !["completed", "paused", "cancelled"].includes(lastRun.state)) groups.push({ type: 'run-note', id: 'run-note', runId: lastRun.id });
  for (const card of changeCards) {
    const end = groups.findLastIndex(group => (group.runId ?? group.message?.runId) === card.runId);
    if (end >= 0) groups.splice(end + 1, 0, { type: 'changes', id: `changes:${card.runId}`, runId: card.runId });
  }
  return <div className="conversation" ref={container} tabIndex={0}
    onWheelCapture={event => { if (!event.ctrlKey && event.deltaY < 0) follow.current = false; }}
    onTouchStart={event => { touchY.current = event.touches[0]?.clientY ?? null; }}
    onTouchMove={event => {
      const y = event.touches[0]?.clientY;
      if (touchY.current !== null && y > touchY.current) follow.current = false;
      touchY.current = y ?? null;
    }}
    onKeyDownCapture={event => {
      if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable=true]')) return;
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || event.key === ' ' && event.shiftKey) follow.current = false;
    }}
    onPointerDown={event => {
      const el = container.current;
      if (event.clientX >= el.getBoundingClientRect().left + el.clientWidth) follow.current = false;
    }}
    onScroll={() => {
    const el = container.current;
    if (historyAnchor.current && el.scrollTop !== adjustedTop.current) historyAnchor.current = captureAnchor();
    // A small upward gesture must detach immediately, even within 100px of
    // the end. Only a downward scroll all the way back resumes following.
    if (el.scrollTop < lastScrollTop.current) follow.current = false;
    else if (el.scrollTop > lastScrollTop.current && !history?.loading && el.scrollHeight - el.scrollTop - el.clientHeight <= 2) follow.current = true;
    lastScrollTop.current = el.scrollTop;
    if (el.scrollTop < 100 && !history?.error) loadOlder();
  }}>
    <div className={`transcript${empty ? " empty-transcript" : ""}`}>
      {history?.hasOlder && (history.loading || history.error) && <div className="history-loader">
        {history.error ? <p role="alert">Couldn’t load earlier messages · <button type="button" onClick={loadOlder}>Retry</button></p> : <p className="hint deferred" role="status" aria-label="Loading earlier messages">…</p>}
      </div>}
      {empty && <div className="empty-state"><JoloLogo className="welcome-wordmark" /><p className="empty-tagline">A little help. A lot of possibility.</p>{!hasProject && <button onClick={onOpenFolder} className="outline"><Icon name="folder" />Open a folder</button>}</div>}
      {groups.map((group) => {
        if (group.type === 'changes') {
          const card = changeCards.find(card => card.runId === group.runId);
          return <ChangeSummary key={group.id} runId={group.runId} files={card.files} initialCounts={card.counts} onCounts={counts => recordCounts(group.runId, counts)} onLoadDiff={loadRunDiff} onReview={onReview} />;
        }
        if (group.type === 'run-note') return <div key={group.id} className={`run-note ${lastRun.state === "failed" ? "negative" : ""}`} role="status" title={identityFor(lastRun)}><ActivityIcon name={runIcons[lastRun.state] ?? 'clock'} active={WORKING_RUN_STATES.includes(lastRun.state)} /><span>{thinking ? 'Thinking…' : runLabel(lastRun)}{lastGuest ? ` · ${lastGuest}` : ''}{lastRun.failure ? `: ${lastRun.failure}` : ""}</span></div>;
        if (group.type === "subagent") return <SubagentBlock key={group.id} text={group.message.text} status={group.message.status} messageId={group.message.id} sessionId={sessionId} onReview={onReview} />;
        if (group.type === "delegation") return <DelegationBlock key={group.id} text={group.message.text} status={group.message.status} delegations={delegations} wakeReason={group.wakeReason} onOpenSession={onOpenSession} />;
        if (group.type === "workflow") {
          // Only a card still worth showing is in the groups: once its workflow ended, the Activity panel is where it is.
          return <WorkflowCallBlock key={group.id} call={group.call} task={workflowTasks.get(group.id) ?? null} onOpenActivity={onOpenActivity} />;
        }
        if (group.type === "activity") return <ActivityGroup key={group.id} messages={group.messages} runState={projection?.runs.get(group.runId)?.state} identity={identityFor(projection?.runs.get(group.runId))} guest={guestFor(projection?.runs.get(group.runId))} hasRunStatus={Boolean(activeRun && activeRun.id === group.runId)} />;
        const message = group.message;
        if (message.evicted) return <div key={message.id} className="message evicted">Older text was released from memory.</div>;
        if (message.loadError) return <div key={message.id} className="message" role="alert"><p>Couldn’t load saved {message.kind === "tool" ? "tool output" : message.kind === "reasoning" ? "reasoning" : "message"}.</p><button onClick={() => { void projection.fill(message.id).catch(() => {}); }}>Retry loading</button></div>;
        // A turn someone else was called into says so, so a reply is never read as the usual answerer's (§6.5).
        const run = projection?.runs.get(message.runId);
        return <MessageArticle key={message.id} message={message} text={message.text} status={message.status} committedBytes={message.committedBytes} renderedBytes={message.renderedBytes} createdAt={message.createdAt} now={now} run={run} guestName={guestFor(run)} assistantName={assistantName} sessionId={sessionId} />;
      })}
    </div>
  </div>;
}
