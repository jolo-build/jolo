import { modelLabel } from '../model-options.js';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { engineCall } from '../engine-context.jsx';
import { Icon } from './icon.jsx';
import { StopIndicator } from './stop-indicator.jsx';
import { IMAGE_LIMITS as LIMITS } from '@jolo/protocol/attachments';
import { readFileAttachment } from '../file-attachments.js';
import { isLongPaste, readTextAttachment, attachmentSummary } from '../text-attachments.js';
import { TextAttachment } from './text-attachment.jsx';

const RADIUS = 6;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const tokens = (value) => (value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k` : String(value));

/**
 * How full the model's window is, and what the task has cost so far. The ring is only ever filled from a
 * number the model itself reported; when an agent does not report one, it stays empty and says so (§7.2).
 */
function UsageButton({ usage, answererName }) {
  const [at, setAt] = useState(null); // where to put the panel, and whether it is open at all
  const wrap = useRef(null);
  const panel = useRef(null);
  const open = at !== null;
  useEffect(() => {
    if (!open) return;
    const dismiss = (event) => { if (!wrap.current?.contains(event.target) && !panel.current?.contains(event.target)) setAt(null); };
    const escape = (event) => { if (event.key === 'Escape') setAt(null); };
    window.addEventListener('pointerdown', dismiss);
    window.addEventListener('keydown', escape);
    window.addEventListener('resize', () => setAt(null), { once: true });
    return () => { window.removeEventListener('pointerdown', dismiss); window.removeEventListener('keydown', escape); };
  }, [open]);
  // The composer sits inside panes that clip their contents, so the panel is placed against the window.
  const toggle = () => {
    if (open) { setAt(null); return; }
    const rect = wrap.current?.getBoundingClientRect();
    if (!rect) return;
    setAt({ left: Math.max(8, Math.min(rect.left - 8, window.innerWidth - 236)), bottom: Math.max(8, window.innerHeight - rect.top + 8) });
  };
  const known = usage?.contextWindow > 0 && usage?.contextUsed !== null && usage?.contextUsed !== undefined;
  const fraction = known ? Math.min(1, usage.contextUsed / usage.contextWindow) : null;
  const percent = known ? Math.round(fraction * 100) : null;
  const level = fraction === null ? '' : fraction >= 0.9 ? ' full' : fraction >= 0.75 ? ' warn' : '';
  const title = known ? `Context ${percent}% full · click for usage` : 'Usage · this agent does not report how full its context is';
  return <span className="usage" ref={wrap}>
    <button type="button" className={`usage-ring${level}`} aria-expanded={open} aria-label={title} title={title} onClick={toggle}>
      <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
        <circle cx="8" cy="8" r={RADIUS} className="usage-track" />
        {fraction !== null && <circle cx="8" cy="8" r={RADIUS} className="usage-fill" strokeDasharray={`${(CIRCUMFERENCE * fraction).toFixed(2)} ${CIRCUMFERENCE.toFixed(2)}`} transform="rotate(-90 8 8)" />}
      </svg>
    </button>
    {open && createPortal(<div className="usage-panel" role="dialog" aria-label="Model usage" ref={panel} style={{ left: `${at.left}px`, bottom: `${at.bottom}px` }}>
      <div className="usage-head">{answererName}</div>
      <dl>
        <div><dt>Context</dt><dd>{known ? `${tokens(usage.contextUsed)} of ${tokens(usage.contextWindow)} · ${percent}%` : 'not reported'}</dd></div>
        <div><dt>Tokens in</dt><dd>{usage?.inputTokens ? tokens(usage.inputTokens) : '—'}</dd></div>
        <div><dt>Tokens out</dt><dd>{usage?.outputTokens ? tokens(usage.outputTokens) : '—'}</dd></div>
        <div><dt>Model turns</dt><dd>{usage?.iterations ? String(usage.iterations) : '—'}</dd></div>
      </dl>
      <div className="hint">{usage?.runs ? `Across ${usage.runs} ${usage.runs === 1 ? 'run' : 'runs'} in this task.` : 'Nothing has run in this task yet.'}</div>
    </div>, document.body)}
  </span>;
}
/** The agents a message can call in by name, matching what has been typed after "@" (§6.5). */
function mentionable(agents, typed, answerer) {
  const options = [{ id: "jolo", name: "Jolo", detail: "Jolo's own loop" }, ...agents.filter((entry) => entry.available && entry.transport !== "pty").map((entry) => ({ id: entry.id, name: entry.displayName, detail: modelLabel(entry.model) }))];
  const query = typed.toLowerCase();
  return options.filter((option) => option.id !== (answerer ?? "jolo") && (option.id.startsWith(query) || option.name.toLowerCase().startsWith(query))).slice(0, 6);
}

/** The "@name" being typed at the caret, or null. Only at the start of the message: that is where it routes. */
function typingMention(value, caret) {
  const match = /^\s*@([a-z0-9._-]*)$/i.exec(value.slice(0, caret));
  return match ? match[1] : null;
}

export function Composer({ standalone = false, disabled, autoFocusOnType = false, running, queuedRuns = [], onSend, onSendNow, onRemoveQueued, onStop, model, answerer, answererId = null, answererName = "Jolo", onPickAnswerer = null, modelControl = null, projectName, changesCount, usage, onReview, onSettings, agents = [] }) {
  const input = useRef(null);
  const fileInput = useRef(null);
  const submitting = useRef(false);
  const lastQueued = useRef(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState([]);
  const attachmentsRef = useRef([]);
  const pasteQueue = useRef(Promise.resolve());
  const pendingPastes = useRef(0);
  const mounted = useRef(true);
  const [readingImages, setReadingImages] = useState(false);
  const [attachmentError, setAttachmentError] = useState('');
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const updateAttachments = images => { attachmentsRef.current = images; setAttachments(images); };
  const addFiles = files => {
    if (disabled || sending || !files.length) return;
    enqueue(files);
  };
  const paste = event => {
    const files = Array.from(event.clipboardData?.files ?? []);
    const pastedText = event.clipboardData.getData('text/plain');
    const attachText = isLongPaste(pastedText);
    if ((!files.length && !attachText) || disabled) return; // short text keeps native selection/undo
    event.preventDefault();
    lastQueued.current = null;
    if (pastedText && !attachText) {
      const start = input.current.selectionStart, end = input.current.selectionEnd;
      setText(current => current.slice(0, start) + pastedText + current.slice(end));
    }
    enqueue(files, attachText ? pastedText : null);
  };
  const enqueue = (files, pastedText = null) => {
    lastQueued.current = null;
    pendingPastes.current++;
    setReadingImages(true);
    setAttachmentError('');
    pasteQueue.current = pasteQueue.current.then(async () => {
      if (pastedText !== null) {
        if (!mounted.current) return;
        const count = attachmentsRef.current.filter(item => item.mimeType === 'text/plain').length;
        if (count >= LIMITS.textAttachments) throw new Error('Attach up to 4 text files per message.');
        const attachment = await readTextAttachment(pastedText, count ? `Pasted text ${count + 1}.txt` : 'Pasted text.txt');
        if (mounted.current) updateAttachments([...attachmentsRef.current, attachment]);
      }
      for (const file of files) {
        if (!mounted.current) return;
        const image = await readFileAttachment(file);
        if (attachmentsRef.current.filter(item => item.mimeType === image.mimeType || (image.mimeType.startsWith('image/') && item.mimeType.startsWith('image/'))).length >= 4) throw new Error('Attach up to 4 images, 4 text files, and 4 other files per message.');
        if (mounted.current) updateAttachments([...attachmentsRef.current, image]);
      }
    }).catch(error => { if (mounted.current) setAttachmentError(error.message); }).finally(() => {
      pendingPastes.current--;
      if (mounted.current) setReadingImages(pendingPastes.current > 0);
    });
  };
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [listAt, setListAt] = useState(null);
  const typed = disabled ? null : typingMention(text, caret);
  const taskMatch = !disabled && /(?:^|[\s(\[])#([A-Z][A-Z0-9]{0,23}(?:-[0-9]{0,15})?|)$/i.exec(text.slice(0, caret));
  const taskQuery = taskMatch ? taskMatch[1].toUpperCase() : null;
  const [taskResults, setTaskResults] = useState({ query: null, tasks: [], error: '' });
  useEffect(() => {
    if (taskQuery === null) return;
    let current = true;
    const timer = setTimeout(() => {
      engineCall('task.list', { q: taskQuery }).then(({ tasks }) => {
        if (current) { setTaskResults({ query: taskQuery, tasks, error: '' }); setHighlight(0); }
      }).catch(error => { if (current) setTaskResults({ query: taskQuery, tasks: [], error: error.message }); });
    }, 250);
    return () => { current = false; clearTimeout(timer); };
  }, [taskQuery]);
  const choices = taskQuery !== null ? (taskResults.query === taskQuery ? taskResults.tasks.slice(0, 6).map(task => ({ id: task.url, key: task.key, name: task.title, detail: task.team?.name ?? 'Personal', task: true })) : []) : typed === null ? [] : mentionable(agents, typed, answererId);
  const picking = choices.length > 0;
  // The compose area hides what overflows it, so the list is placed against the window instead of the form.
  useEffect(() => {
    if (!picking) { setListAt(null); return; }
    const rect = input.current?.getBoundingClientRect();
    if (rect) setListAt({ left: Math.round(rect.left), width: Math.round(rect.width), bottom: Math.round(window.innerHeight - rect.top + 6) });
  }, [picking, choices.length, text]);
  const choose = (option) => {
    if (!option) return;
    if (option.task) {
      const start = caret - taskQuery.length - 1;
      const insert = `#${option.key} `;
      setText(text.slice(0, start) + insert + text.slice(caret));
      setCaret(0);
      requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(start + insert.length, start + insert.length); });
      return;
    }
    const next = text.replace(/^\s*@[a-z0-9._-]*/i, `@${option.id}`);
    setText(next.endsWith(" ") ? next : `${next} `);
    setCaret(0);
    input.current?.focus();
  };
  useEffect(() => {
    if (!autoFocusOnType || disabled) return;
    const focusPrompt = event => {
      // Move focus before the browser inserts the first character. Native input
      // then handles text, selection, undo, and dead keys without replaying keys.
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.isComposing || (event.key.length !== 1 && event.key !== 'Dead')) return;
      if (document.querySelector('dialog[open], .settings-page')) return;
      const target = event.target instanceof Element ? event.target : document.activeElement;
      // Selecting a task leaves focus on its sidebar button; typing should continue in that task.
      // Other buttons keep their keyboard behavior, including task options and unselected rows.
      const selectedTask = target?.closest('.sidebar .task[aria-current="page"], .sidebar .recent-chat[aria-current="page"]');
      if (!selectedTask && target?.closest('input, textarea, select, button, a[href], summary, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="listbox"], [role="menu"], [role="tab"], [role="separator"], .terminal, .inspector')) return;
      const pane = target?.closest('.pane-slot');
      if (pane && pane !== input.current?.closest('.pane-slot')) return;
      input.current?.focus({ preventScroll: true });
    };
    window.addEventListener('keydown', focusPrompt);
    return () => window.removeEventListener('keydown', focusPrompt);
  }, [autoFocusOnType, disabled]);
  const submit = async () => {
    const images = attachmentsRef.current;
    const prompt = text.trim() || (images.some(item => !item.mimeType.startsWith('image/')) ? 'Please inspect the attached content.' : images.length ? 'Please inspect the attached images.' : '');
    if (!prompt || disabled || submitting.current || pendingPastes.current) return;
    submitting.current = true;
    setSending(true);
    try {
      const operation = onSend(prompt, { queue: running, ...(images.length ? { attachments: images } : {}) });
      lastQueued.current = running ? { operation, at: Date.now(), draft: text } : null;
      await operation;
      setText(current => current === text ? '' : current);
      if (mounted.current) updateAttachments(attachmentsRef.current.filter(image => !images.includes(image)));
    }
    catch { /* The app displays the error; retain the draft for retry. */ }
    finally { submitting.current = false; setSending(false); }
  };
  return <div className="compose-dock"><div className="compose-wrap"><div className="compose-column">
    {queuedRuns.length > 0 && <section className="message-queue" aria-label="Queued messages">
      <div className="message-queue-heading">Queued · {queuedRuns.length}</div>
      <ul>{queuedRuns.map(run => <li key={run.id}>
        <span title={run.prompt ?? run.promptPreview}>{run.prompt ?? run.promptPreview ?? 'Queued message'}{run.attachments?.length ? ` · ${attachmentSummary(run.attachments)}` : ''}</span>
        <button type="button" disabled={disabled} onClick={() => onSendNow?.(run.id)} title="Interrupt the current turn and send this message">Send now</button>
        <button type="button" disabled={disabled} onClick={() => onRemoveQueued?.(run.id)} aria-label="Remove queued message" title="Remove queued message"><Icon name="close" size={12} /></button>
      </li>)}</ul>
    </section>}
    <form className="composer" onDragOver={event => { if (Array.from(event.dataTransfer.types).includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = disabled || sending ? 'none' : 'copy'; } }} onDrop={event => { if (event.dataTransfer.files.length) { event.preventDefault(); addFiles(Array.from(event.dataTransfer.files)); } }} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    {attachments.length > 0 && <div className="composer-attachments" aria-label="Attachments">{attachments.map(image => <div className={`composer-attachment${!image.mimeType.startsWith('image/') ? ' text-file' : ''}`} key={image.id}>
      {!image.mimeType.startsWith('image/') ? <TextAttachment attachment={image} /> : <img src={image.dataUrl} alt={image.name} />}
      <button type="button" disabled={sending} onClick={() => { updateAttachments(attachmentsRef.current.filter(entry => entry.id !== image.id)); setAttachmentError(''); lastQueued.current = null; }} aria-label={`Remove ${image.name}`} title={`Remove ${image.name}`}><Icon name="close" size={12} /></button>
      {image.mimeType.startsWith('image/') && <span title={image.name}>{image.name}</span>}
    </div>)}</div>}
    {readingImages && <p className="attachment-note" role="status">Reading attachment…</p>}
    {attachmentError && <p className="attachment-note negative" role="alert">{attachmentError}</p>}
    {picking && listAt && createPortal(<ul className="mention-list" role="listbox" aria-label={taskQuery !== null ? "Reference a web task" : "Call another agent into this task"} style={{ left: `${listAt.left}px`, width: `${listAt.width}px`, bottom: `${listAt.bottom}px` }}>
      {choices.map((option, index) => <li key={option.id}>
        <button type="button" role="option" aria-selected={index === highlight} className={index === highlight ? "selected" : ""} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(option)}>
          <span className="mention-name">{option.task ? "#" : "@"}{option.task ? option.key : option.id}</span><span className="mention-detail">{option.name}{option.detail ? ` · ${option.detail}` : ""}</span>
        </button>
      </li>)}
      <li className="mention-hint">{taskQuery !== null ? "Attaches this task’s current description when you send." : `answers this one message, then ${answererName} carries on`}</li>
    </ul>, document.body)}
    {taskQuery !== null && taskResults.query === taskQuery && taskResults.error && <p className="attachment-note" role="status">{taskResults.error} <button type="button" onClick={onSettings}>Settings</button></p>}
    <textarea ref={input} aria-label="Message Jolo" value={text} placeholder={disabled ? standalone ? 'Connecting…' : 'Open a folder to start…' : running ? 'Queue a message… Enter twice to send now' : standalone ? 'Ask anything…' : `Ask ${answererName} to build, fix, or explore…`} disabled={disabled}
      onPaste={paste}
      onChange={(e) => { lastQueued.current = null; setText(e.target.value); setCaret(e.target.selectionStart ?? e.target.value.length); setHighlight(0); }}
      onSelect={(e) => setCaret(/** @type {HTMLTextAreaElement} */ (e.target).selectionStart ?? 0)}
      onBlur={() => { setCaret(0); lastQueued.current = null; }}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (picking && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); setHighlight((current) => (current + (e.key === 'ArrowDown' ? 1 : choices.length - 1)) % choices.length); return; }
        if (picking && (e.key === 'Tab' || e.key === 'Enter') && !e.shiftKey) { e.preventDefault(); choose(choices[highlight]); return; }
        if (picking && e.key === 'Escape') { e.preventDefault(); setCaret(0); return; }
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault();
          if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
          const queued = lastQueued.current;
          if (queued && Date.now() - queued.at <= 500 && (!text.trim() || text === queued.draft)) {
            lastQueued.current = null;
            void Promise.resolve(queued.operation).then(run => onSendNow?.(run.id)).catch(() => {});
          } else { void submit(); }
        }
      }} />
    <input ref={fileInput} type="file" multiple hidden aria-label="Choose attachments" onChange={event => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
    <div className="composer-controls">
      <button type="button" disabled={disabled || sending} aria-label="Attach files" title="Attach files" onClick={() => fileInput.current?.click()}><Icon name="plus" size={15} /></button>
      <div className="composer-context">{changesCount ? <button type="button" onClick={onReview} title="Review current changes"><Icon name="changes" size={13} /><span>{changesCount} {changesCount === 1 ? 'file' : 'files'}</span></button> : <span title={projectName ?? 'No project selected'}><Icon name={standalone ? 'chat' : 'folder'} size={13} /><span>{projectName ?? 'No project'}</span></span>}</div>
      <span className="composer-divider" aria-hidden="true" />
      <UsageButton usage={usage} answererName={answerer ?? answererName} />
      {modelControl ?? <button type="button" className="model-select" onClick={onPickAnswerer ?? onSettings} aria-label="Choose agent" title={answerer ? `Answering: ${answerer}. Click to choose an agent.` : "Choose an agent"}><span>{answerer ?? model}</span><Icon name="down" size={12} /></button>}<span className="grow" />
      {running ? <button type="button" className="stop-button composer-submit" onClick={onStop} aria-label="Stop task" title="Working · Stop task">
        <StopIndicator />
      </button> : null}
      {(!running || text.trim() || attachments.length > 0) && <button type="submit" className="primary composer-submit" disabled={disabled || sending || readingImages || (!text.trim() && !attachments.length)} aria-label={sending ? 'Sending message' : running ? 'Queue message' : 'Send message'} title={running ? 'Queue message · Enter. Enter twice to interrupt and send now.' : 'Send message · Enter'}><Icon name="arrow" size={15} /></button>}
    </div>
  </form></div></div></div>;
}
