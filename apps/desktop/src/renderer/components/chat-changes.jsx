import { useEffect, useState } from 'react';
import { Icon } from './icon.jsx';
import { DiffLines } from './diff-lines.jsx';
import { loadRecordedDiff, readEditView, saveEditView } from '../chat-edits.js';
import { projectFileKind } from '../project-file-kind.js';
import { diffSummary } from '../diff-lines.js';

export function ChatChanges({ sessionId, cards, request, visible, working }) {
  const [selection, setSelection] = useState(() => readEditView(sessionId).selection ?? null);
  const [result, setResult] = useState(null), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  const latest = cards.at(-1);
  const card = cards.find(card => card.runId === selection?.runId) ?? latest;
  const file = card?.files.find(file => (file.newPath ?? file.path) === selection?.path) ?? card?.files.at(-1);
  const path = file?.newPath ?? file?.path;
  const versions = file?.diffArtifactIds ?? [];
  const artifactId = versions.includes(selection?.artifactId) ? selection.artifactId : versions.at(-1);
  const revision = artifactId ?? '';
  const pin = (card, file) => ({ runId: card.runId, path: file.newPath ?? file.path, artifactId: file.diffArtifactIds?.at(-1) });
  const choose = value => { setSelection(value); saveEditView(sessionId, { selection: value }); };
  useEffect(() => {
    if (request?.sessionId !== sessionId) return;
    const requestedCard = cards.find(card => card.runId === request.runId);
    const requestedFile = requestedCard?.files.find(file => (file.newPath ?? file.path) === request.path) ?? requestedCard?.files.at(-1);
    if (requestedFile) choose({ ...pin(requestedCard, requestedFile), ...(request.artifactId ? { artifactId: request.artifactId } : {}) });
  }, [request]);
  useEffect(() => {
    if (!visible || !file) return;
    let live = true;
    setResult(null); setError('');
    loadRecordedDiff(path, { ...file, diffArtifactIds: artifactId ? [artifactId] : [] }).then(value => { if (live) setResult(value); }).catch(error => { if (live) setError(error.message); });
    return () => { live = false; };
  }, [visible, path, revision, card?.runId, retry]);
  const counts = result?.diff ? diffSummary(result.diff) : null;
  return <section className="chat-changes" aria-label="Code changes from this chat">
    <div className="chat-changes-toolbar"><strong>Code changes</strong>{working && <span className="hint">Live</span>}<span className="grow" />
      <button aria-pressed={!selection} title="Follow the latest edit" onClick={() => choose(null)}>Follow latest</button>
    </div>
    {!cards.length ? <div className="panel-empty"><Icon name="fileDiff" size={26} /><h2>No recorded edits yet</h2><p>File edits from this chat appear here as the agent works.</p></div> : <>
      <div className="chat-change-selection"><label>Reply <select aria-label="Changes from reply" value={card?.runId ?? ''} onChange={event => choose({ runId: event.target.value })}>{cards.map((item, index) => <option value={item.runId} key={item.runId}>{index === cards.length - 1 ? 'Latest reply' : `Reply ${index + 1}`} · {item.files.length} files</option>)}</select></label></div>
      <div className="chat-change-files" aria-label="Edited files">{card?.files.map(entry => {
        const target = entry.newPath ?? entry.path, visual = projectFileKind(target);
        return <button key={target} aria-pressed={path === target} onClick={() => choose(pin(card, entry))} title={target}><Icon name={visual.icon} size={15} className={`project-file-icon ${visual.tone}`} /><span>{target}</span><small>{entry.op === 'create' ? 'A' : entry.op === 'delete' ? 'D' : entry.op === 'rename' ? 'R' : 'M'}</small></button>;
      })}</div>
      <div className="chat-change-heading">{versions.length > 1 && <select aria-label="Recorded edit" value={artifactId} onChange={event => choose({ runId: card.runId, path, artifactId: event.target.value })}>{versions.map((id, index) => <option key={id} value={id}>Edit {index + 1}{index === versions.length - 1 ? ' · latest' : ''}</option>)}</select>}<code title={path}>{path}</code>{counts && <><span className="diff-added">+{counts.added}</span><span className="diff-removed">−{counts.removed}</span></>}</div>
      <div className="diff chat-change-diff" key={`${card?.runId}:${path}`} onWheel={() => { if (!selection && card && path) choose(pin(card, file)); }}>
        {error ? <div role="alert"><p>{error}</p><button onClick={() => setRetry(value => value + 1)}>Retry</button></div> : !result ? <p className="hint">Loading recorded edit…</p> : !result.diff ? <p className="hint">The agent recorded this file change without a diff.</p> : <DiffLines text={result.diff} path={path} />}
        {result?.truncated && <p className="panel-note">This recorded diff is truncated.</p>}
      </div>
      <footer className="chat-change-footer">{selection ? 'Reviewing selected edit' : 'Following latest edit'}<span className="grow" />Recorded edits · this chat</footer>
    </>}
  </section>;
}
