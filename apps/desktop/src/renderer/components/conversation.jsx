import { modelLabel } from '../model-options.js';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "./markdown.jsx";
import { Icon } from "./icon.jsx";
import { diffSummary } from "../diff-lines.js";
import { DiffLines } from './diff-lines.jsx';
import { JoloLogo, JoloMark } from "./brand.jsx";
import { runLabel, screenshotArtifactId } from "../presentation.js";
import { ChangeSummary } from './change-summary.jsx';
import { fileDiffSections, readChangeCards, saveChangeCards, updateChangeCards } from '../change-cards.js';
import { ImageAttachment } from './image-attachment.jsx';
import { TextAttachment } from './text-attachment.jsx';

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

const runIcons = { queued: 'clock', preparing: 'spinner', model: 'spinner', tools: 'spinner', awaiting_permission: 'shield', cancelling: 'spinner', cancelled: 'stop', completed: 'check', failed: 'alert', interrupted: 'stop' };

function ActivityIcon({ name, active = false }) {
  return <Icon name={name} size={16} className={`activity-icon${active ? name === 'spinner' ? ' activity-spin' : ' activity-pulse' : ''}`} />;
}

function activityIdentity(run, { assistantName, assistantAgentId, agents, providerModel }) {
  const guestId = run?.agentId ?? run?.execution?.agentId;
  const agentId = guestId ?? assistantAgentId;
  const native = !agentId || agentId === 'jolo';
  const agent = agents.find(entry => entry.id === agentId);
  const name = guestId === 'jolo' ? 'Jolo' : agent?.displayName ?? (guestId || assistantName);
  const model = run?.execution?.model || (native ? providerModel : agent?.model);
  return `${name} · ${modelLabel(model) || 'Default model'}`;
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
  if (text === null) return <p className="hint">Loading changes…</p>;
  const counts = diffSummary(text);
  return <div className="tool-diff">
    <div className="tool-diff-head">{counts.files} {counts.files === 1 ? "file" : "files"}<span className="diff-added">+{counts.added}</span><span className="diff-removed">−{counts.removed}</span></div>
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
  return src ? <img className="screenshot" src={src} alt="browser screenshot" /> : <span className="hint">loading screenshot…</span>;
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
      <summary><ActivityIcon name={loading ? 'spinner' : toolIcon(head)} active={loading || status === "streaming"} /><span>{head || (loading ? "Loading tool…" : "Tool")}{status === "streaming" ? " …" : ""}</span><Icon name="chevron" size={12} className="activity-disclosure" /></summary>
      {expanded && <>
        {diffArtifactId && <DiffPreview artifactId={diffArtifactId} />}
        {screenshot ? <ScreenshotPreview artifactId={screenshot} /> : !text && committedBytes > renderedBytes ? <p className="hint" role="status">Loading tool output…</p> : <pre>{rest}</pre>}
      </>}
    </details>
  );
});

const ReasoningBlock = memo(function ReasoningBlock(/** @type {{ text: string, status: string }} */ { text, status }) {
  const working = status === "streaming";
  if (!text.trim()) return <div className="reasoning-pending" role="status"><ActivityIcon name={working ? 'think' : 'spinner'} active /><span>{working ? "Thinking…" : "Loading reasoning…"}</span></div>;
  return (
    <details className="block reasoning">
      <summary><ActivityIcon name="think" active={working} /><span>Reasoning{working ? " …" : ""}</span><Icon name="chevron" size={12} className="activity-disclosure" /></summary>
      <pre>{text}</pre>
    </details>
  );
});

/**
 * One turn of the transcript. Its text grows in place, so what grows is passed beside it for memo to compare.
 * @typedef {{
 *   message: import('@jolo/client/projection').ProjectedMessage,
 *   text: string,
 *   status: string,
 *   committedBytes: number,
 *   renderedBytes: number,
 *   run: any,
 *   guestName: string | null,
 *   assistantName: string,
 *   sessionId?: string | null,
 * }} MessageArticleProps
 */
const MessageArticle = memo(function MessageArticle(/** @type {MessageArticleProps} */ { message, text, status, committedBytes, renderedBytes, run, guestName, assistantName, sessionId }) {
  const assistant = message.role === "assistant";
  return <article data-message-id={message.id} className={`message ${message.role} ${message.kind}${status === "streaming" ? " streaming" : ""}`} aria-label={message.role === "user" ? "Your message" : undefined}>
    {message.role === 'user' && run?.attachments?.length > 0 && <div className="message-attachments">{run.attachments.map((attachment, index) => !attachment.mimeType.startsWith('image/') ? <TextAttachment key={attachment.artifactId} attachment={attachment} /> : <ImageAttachment key={`${attachment.artifactId}:${index}`} attachment={attachment} />)}</div>}
    {message.role === 'user' && run?.taskReferences?.length > 0 && <div className="message-task-references" aria-label="Referenced web tasks">{run.taskReferences.map(task => <button type="button" key={task.url} title={`${task.team?.name ?? 'Personal'} · ${task.title} · revision ${task.revision}`} onClick={() => window.jolo.openExternal(task.url).catch(() => {})}><strong>#{task.key}</strong> {task.title}<span>{task.team?.name ?? 'Personal'} · r{task.revision} ↗</span></button>)}</div>}
    {message.role !== "user" && <div className="message-label">{assistant && !guestName && assistantName === "Jolo" && <JoloMark className="agent-mark" />}{assistant ? guestName ?? assistantName : message.role}{assistant && guestName && <span className="called-in">called in for this message</span>}</div>}
    {!text && committedBytes > renderedBytes ? <p className="hint" role="status">Loading message…</p> : assistant && message.kind === "text" ? <Markdown text={text} cacheKey={message.id} sessionId={run?.sessionId ?? sessionId} streaming={status === "streaming"} /> : <div className="message-text">{text}</div>}
  </article>;
});

function ActivityGroup({ messages, identity, runState, hasRunStatus = false }) {
  const working = messages.some((message) => message.status === "streaming");
  const tools = messages.filter((message) => message.kind === "tool").length;
  if (!tools && !messages.some((message) => message.text.trim())) {
    if (working && hasRunStatus) return null;
    return <div className="activity-pending" role="status"><ActivityIcon name="spinner" active /><span>{working ? `Thinking… · ${identity}` : "Loading reasoning…"}</span></div>;
  }
  // Background commands may span several replies. Their individual rows stay
  // live, while the task has one authoritative progress line below the transcript.
  // A completed tool is only a gap in the run, not task completion. Keep
  // the disclosure icon steady until the owning run explicitly completes.
  const label = `Task activity${tools ? ` · ${tools} ${tools === 1 ? 'action' : 'actions'}` : ' · Reasoning'}`;
  return <details className="activity-group"><summary><ActivityIcon name={runState === 'completed' ? 'check' : tools ? 'tools' : 'think'} /><span className="activity-label" title={identity}>{label}</span><span className="activity-line" /><Icon name="down" size={13} /></summary><div className="activity-steps">{messages.map((message) => message.kind === "tool"
    ? <ToolBlock key={message.id} text={message.text} status={message.status} committedBytes={message.committedBytes} renderedBytes={message.renderedBytes} diffArtifactId={message.diffArtifactId} />
    : <ReasoningBlock key={message.id} text={message.text} status={message.status} />)}</div></details>;
}

export function Conversation({ projection, sessionId, history, hasProject, standalone = false, onReview, onOpenFolder, assistantName = "Jolo", assistantAgentId = null, providerModel = null, agents = [] }) {
  const container = useRef(null);
  const follow = useRef(true);
  const lastScrollTop = useRef(0);
  const touchY = useRef(null);
  const historyAnchor = useRef(null);
  const adjustedTop = useRef(null);
  const [changeCards, setChangeCards] = useState(() => readChangeCards(sessionId));
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
  const groups = [];
  for (const message of messages) {
    // A provider may complete a thinking block without a displayable summary.
    // Keep pending artifact loads visible, but never leave an empty disclosure.
    if (message.kind === "reasoning" && !message.evicted && !message.loadError && !message.text.trim() && message.status !== "streaming" && (message.renderedBytes ?? 0) >= (message.committedBytes ?? 0)) continue;
    if (!message.evicted && !message.loadError && ["tool", "reasoning"].includes(message.kind)) {
      if (groups.at(-1)?.type === "activity" && groups.at(-1).runId === message.runId) groups.at(-1).messages.push(message);
      else groups.push({ type: "activity", id: message.id, runId: message.runId, messages: [message] });
    } else groups.push({ type: "message", id: message.id, message });
  }
  if (lastRun && !["completed", "paused"].includes(lastRun.state)) groups.push({ type: 'run-note', id: 'run-note', runId: lastRun.id });
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
    <div className={`transcript${messages.length ? "" : " empty-transcript"}`}>
      {history?.hasOlder && <div className="history-loader">
        <button type="button" onClick={loadOlder} disabled={history.loading}>{history.loading ? 'Loading earlier messages…' : 'Load earlier messages'}</button>
        {history.error && <p role="alert">Couldn’t load earlier messages. Try again.</p>}
      </div>}
      {!messages.length && <div className="empty-state"><JoloLogo className="welcome-wordmark" /><h2>A little help. A lot of possibility.</h2><p>{standalone ? "Ask a question, explore an idea, or work through something together." : hasProject ? "Describe what you have in mind. Jolo can explore your project, make changes, and help you check the result." : "Open a project and turn an idea into your next working change."}</p>{!hasProject && <button onClick={onOpenFolder} className="outline"><Icon name="folder" />Open a folder</button>}</div>}
      {groups.map((group) => {
        if (group.type === 'changes') {
          const card = changeCards.find(card => card.runId === group.runId);
          return <ChangeSummary key={group.id} runId={group.runId} files={card.files} initialCounts={card.counts} onCounts={counts => recordCounts(group.runId, counts)} onLoadDiff={loadRunDiff} onReview={onReview} />;
        }
        if (group.type === 'run-note') return <div key={group.id} className={`run-note ${lastRun.state === "failed" ? "negative" : ""}`} role="status"><ActivityIcon name={runIcons[lastRun.state] ?? 'clock'} active={['preparing', 'model', 'tools', 'cancelling'].includes(lastRun.state)} /><span>{thinking ? 'Thinking…' : runLabel(lastRun)}{activeRun?.id === lastRun.id ? ` · ${identityFor(lastRun)}` : ''}{lastRun.failure ? `: ${lastRun.failure}` : ""}</span></div>;
        if (group.type === "activity") return <ActivityGroup key={group.id} messages={group.messages} runState={projection?.runs.get(group.runId)?.state} identity={identityFor(projection?.runs.get(group.runId))} hasRunStatus={Boolean(activeRun && activeRun.id === group.runId)} />;
        const message = group.message;
        if (message.evicted) return <div key={message.id} className="message evicted">Older text was released from memory.</div>;
        if (message.loadError) return <div key={message.id} className="message" role="alert"><p>Couldn’t load saved {message.kind === "tool" ? "tool output" : message.kind === "reasoning" ? "reasoning" : "message"}.</p><button onClick={() => { void projection.fill(message.id).catch(() => {}); }}>Retry loading</button></div>;
        // A turn someone else was called into says so, so a reply is never read as the usual answerer's (§6.5).
        const run = projection?.runs.get(message.runId);
        const calledIn = run?.agentId ?? null;
        const guestName = calledIn === "jolo" ? "Jolo" : calledIn ? agents.find((entry) => entry.id === calledIn)?.displayName ?? calledIn : null;
        return <MessageArticle key={message.id} message={message} text={message.text} status={message.status} committedBytes={message.committedBytes} renderedBytes={message.renderedBytes} run={run} guestName={guestName} assistantName={assistantName} sessionId={sessionId} />;
      })}
    </div>
  </div>;
}
