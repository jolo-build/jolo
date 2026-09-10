import { useEffect, useRef, useState } from "react";
import { Markdown } from "./markdown.jsx";
import { Icon } from "./icon.jsx";
import { diffSummary } from "../diff-lines.js";
import { DiffLines } from './diff-lines.jsx';
import { JoloMark } from "./brand.jsx";
import { runLabel, verificationLabel } from "../presentation.js";
import { ImageAttachment } from './image-attachment.jsx';

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
  return `${name} · ${model || 'Default model'}`;
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

function ToolBlock({ message }) {
  const [head, ...rest] = message.text.split("\n");
  const [expanded, setExpanded] = useState(false);
  const loading = !head && message.committedBytes > message.renderedBytes;
  let screenshot = null;
  if (head.startsWith("browser_screenshot") && message.status !== "streaming") {
    try { const parsed = JSON.parse(rest[0] ?? ""); if (parsed.ok && parsed.mimeType === "image/png" && parsed.artifactId) screenshot = parsed.artifactId; } catch { /* not JSON yet */ }
  }
  return (
    <details className="block tool" onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary><ActivityIcon name={loading ? 'spinner' : toolIcon(head)} active={loading || message.status === "streaming"} /><span>{head || (loading ? "Loading tool…" : "Tool")}{message.status === "streaming" ? " …" : ""}</span><Icon name="chevron" size={12} className="activity-disclosure" /></summary>
      {expanded && <>
        {message.diffArtifactId && <DiffPreview artifactId={message.diffArtifactId} />}
        {screenshot ? <ScreenshotPreview artifactId={screenshot} /> : !message.text && message.committedBytes > message.renderedBytes ? <p className="hint" role="status">Loading tool output…</p> : <pre>{rest.join("\n")}</pre>}
      </>}
    </details>
  );
}

function ReasoningBlock({ message }) {
  const working = message.status === "streaming";
  if (!message.text.trim()) return <div className="reasoning-pending" role="status"><ActivityIcon name={working ? 'think' : 'spinner'} active /><span>{working ? "Thinking…" : "Loading reasoning…"}</span></div>;
  return (
    <details className="block reasoning">
      <summary><ActivityIcon name="think" active={working} /><span>Reasoning{working ? " …" : ""}</span><Icon name="chevron" size={12} className="activity-disclosure" /></summary>
      <pre>{message.text}</pre>
    </details>
  );
}

function ActivityGroup({ messages, identity }) {
  const working = messages.some((message) => message.status === "streaming");
  const tools = messages.filter((message) => message.kind === "tool").length;
  if (!tools && !messages.some((message) => message.text.trim())) return <div className="activity-pending" role="status"><ActivityIcon name="spinner" active /><span>{working ? `Thinking… · ${identity}` : "Loading reasoning…"}</span></div>;
  const label = `${working ? `Working · ${identity}` : 'Task activity'}${tools ? ` · ${tools} ${tools === 1 ? 'action' : 'actions'}` : ' · Reasoning'}`;
  return <details className="activity-group"><summary><ActivityIcon name={working ? "spinner" : "check"} active={working} /><span className="activity-label" title={label}>{label}</span><span className="activity-line" /><Icon name="down" size={13} /></summary><div className="activity-steps">{messages.map((message) => message.kind === "tool" ? <ToolBlock key={message.id} message={message} /> : <ReasoningBlock key={message.id} message={message} />)}</div></details>;
}

export function Conversation({ projection, hasProject, changesCount, verification, onReview, onOpenFolder, assistantName = "Jolo", assistantAgentId = null, providerModel = null, agents = [] }) {
  const container = useRef(null);
  const follow = useRef(true);
  const messages = projection ? projection.ordered() : [];
  const runs = projection ? [...projection.runs.values()] : [];
  useEffect(() => {
    if (follow.current && container.current) container.current.scrollTop = container.current.scrollHeight;
  });
  const activeRun = runs.find(run => ['preparing', 'model', 'tools', 'awaiting_permission', 'cancelling'].includes(run.state));
  // Queued messages (and ones removed before starting) have no transcript yet.
  // Their status must not replace the turn the conversation is displaying.
  const lastRun = activeRun ?? projection?.runs.get(messages.at(-1)?.runId) ?? runs.filter(run => ['failed', 'interrupted'].includes(run.state)).at(-1);
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
  return <div className="conversation" ref={container} onScroll={() => { const el = container.current; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100; }}>
    <div className={`transcript${messages.length ? "" : " empty-transcript"}`}>
      {!messages.length && <div className="empty-state"><JoloMark className="welcome-mark" /><h2>A little help. A lot of possibility.</h2><p>{hasProject ? "Describe what you have in mind. Jolo can explore your project, make changes, and help you check the result." : "Open a project and turn an idea into your next working change."}</p>{!hasProject && <button onClick={onOpenFolder} className="outline"><Icon name="folder" />Open a folder</button>}</div>}
      {groups.map((group) => {
        if (group.type === "activity") return <ActivityGroup key={group.id} messages={group.messages} identity={identityFor(projection?.runs.get(group.runId))} />;
        const message = group.message;
        if (message.evicted) return <div key={message.id} className="message evicted">Older text was released from memory.</div>;
        if (message.loadError) return <div key={message.id} className="message" role="alert"><p>Couldn’t load saved {message.kind === "tool" ? "tool output" : message.kind === "reasoning" ? "reasoning" : "message"}.</p><button onClick={() => { void projection.fill(message.id).catch(() => {}); }}>Retry loading</button></div>;
        const assistant = message.role === "assistant";
        // A turn someone else was called into says so, so a reply is never read as the usual answerer's (§6.5).
        const calledIn = projection?.runs.get(message.runId)?.agentId ?? null;
        const guestName = calledIn === "jolo" ? "Jolo" : calledIn ? agents.find((entry) => entry.id === calledIn)?.displayName ?? calledIn : null;
        return <article key={message.id} className={`message ${message.role} ${message.kind}${message.status === "streaming" ? " streaming" : ""}`} aria-label={message.role === "user" ? "Your message" : undefined}>
          {message.role === 'user' && projection?.runs.get(message.runId)?.attachments?.length > 0 && <div className="message-attachments">{projection.runs.get(message.runId).attachments.map((attachment, index) => <ImageAttachment key={`${attachment.artifactId}:${index}`} attachment={attachment} />)}</div>}
          {message.role === 'user' && projection?.runs.get(message.runId)?.taskReferences?.length > 0 && <div className="message-task-references" aria-label="Referenced web tasks">{projection.runs.get(message.runId).taskReferences.map(task => <button type="button" key={task.key} title={`${task.title} · revision ${task.revision}`} onClick={() => window.jolo.openExternal(task.url).catch(() => {})}><strong>#{task.key}</strong> {task.title}<span>r{task.revision} ↗</span></button>)}</div>}
          {message.role !== "user" && <div className="message-label">{assistant && !guestName && assistantName === "Jolo" && <JoloMark className="agent-mark" />}{assistant ? guestName ?? assistantName : message.role}{assistant && guestName && <span className="called-in">called in for this message</span>}</div>}
          {!message.text && message.committedBytes > message.renderedBytes ? <p className="hint" role="status">Loading message…</p> : assistant && message.kind === "text" ? <Markdown text={message.text} cacheKey={message.id} /> : <div className="message-text">{message.text}</div>}
        </article>;
      })}
      {lastRun && !["completed", "paused"].includes(lastRun.state) && <div className={`run-note ${lastRun.state === "failed" ? "negative" : ""}`} role="status"><ActivityIcon name={runIcons[lastRun.state] ?? 'clock'} active={['preparing', 'model', 'tools', 'cancelling'].includes(lastRun.state)} /><span>{runLabel(lastRun)}{activeRun?.id === lastRun.id ? ` · ${identityFor(lastRun)}` : ''}{lastRun.failure ? `: ${lastRun.failure}` : ""}</span></div>}
      {changesCount > 0 && <div className="change-summary"><div><Icon name="changes" /><strong>Changes ready to inspect</strong><span className="grow" /><span className={verification?.status === "passed" ? "good" : "muted"}>{verificationLabel(verification)}</span></div><div><span className="muted">{changesCount} {changesCount === 1 ? "file changed" : "files changed"}</span><span className="grow" /><button onClick={onReview}>Review changes<Icon name="right" size={14} /></button></div></div>}
    </div>
  </div>;
}
