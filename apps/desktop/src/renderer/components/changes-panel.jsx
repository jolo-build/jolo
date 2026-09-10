import { useEffect, useRef, useState } from 'react';
import { DiffLines } from './diff-lines.jsx';
import { Icon } from './icon.jsx';
import { basename, changeKey, uniqueChanges } from '../presentation.js';
import { Markdown } from './markdown.jsx';

const MARKDOWN_FILE = /\.(md|markdown|mdx)$/i;

/** On-demand, bounded engine diffs. A review applies only to one specific file mutation. */
export function ChangesPanel({ changes, status = {}, onRefresh, view, onSelectFile, onLoadDiff, onLoadFile, onRevert }) {
  const [selected, setSelected] = useState(null);
  const [diff, setDiff] = useState(null);
  const [note, setNote] = useState(null);
  const [reviewed, setReviewed] = useState(new Set());
  const [context, setContext] = useState(true);
  const [reverting, setReverting] = useState(false);
  const [confirmRevert, setConfirmRevert] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [mode, setMode] = useState('diff'); // markdown files can also show a rendered preview of their current content
  const [preview, setPreview] = useState(null);
  const request = useRef(0);
  const files = uniqueChanges(changes);
  const active = files.find((change) => (change.newPath ?? change.path) === selected) ?? files[0];
  const path = active?.newPath ?? active?.path;
  const revision = active ? changeKey(active) : null;
  const visible = view === 'changes';
  const markdown = Boolean(path && MARKDOWN_FILE.test(path) && onLoadFile);
  const showPreview = markdown && mode === 'preview';
  useEffect(() => {
    if (!path || !visible) return;
    const ticket = ++request.current;
    setDiff(null); setPreview(null); setNote(null); setConfirmRevert(false);
    const load = showPreview ? onLoadFile(path).then((result) => { if (request.current === ticket) setPreview(result); }) : onLoadDiff(path).then((result) => { if (request.current === ticket) setDiff(result); });
    load.catch((error) => { if (request.current === ticket) setNote(error.message); });
    return () => { request.current += 1; };
  }, [path, revision, visible, refresh, showPreview, onLoadDiff, onLoadFile]);
  const select = (file) => { setSelected(file.newPath ?? file.path); onSelectFile?.(); };
  const revert = async () => {
    setReverting(true); setNote(null);
    try { await onRevert(active.invocationId, path); await onRefresh?.(); setNote(`Reverted ${path}`); setRefresh((value) => value + 1); }
    catch (error) { setNote(error.message); }
    finally { setReverting(false); setConfirmRevert(false); }
  };
  const markReviewed = () => {
    setReviewed((previous) => new Set([...previous, revision]));
    const next = files.find((file) => changeKey(file) !== revision && !reviewed.has(changeKey(file)));
    if (next) setSelected(next.newPath ?? next.path);
  };
  const reviewedCount = files.filter((file) => reviewed.has(changeKey(file))).length;
  const refreshButton = <button className="icon-button" title="Refresh working changes" aria-label="Refresh working changes" onClick={() => { void onRefresh?.(); setRefresh(value => value + 1); }}><Icon name="refresh" size={14} /></button>;
  const scopeNote = status.source === 'git' ? 'All uncommitted changes in this workspace.' : 'Edits recorded by Jolo in this session. Git is unavailable for this folder.';
  const statusNote = status.error || (status.truncated ? 'Showing the first 1,000 changed files.' : null);
  if (!files.length) return <div className="panel-empty"><Icon name={view === 'files' ? 'folder' : 'changes'} size={26} /><h2>{status.error ? 'Could not load changes' : status.loading ? 'Loading changes…' : status.source === 'git' ? 'No working changes' : 'No recorded changes'}</h2><p>{status.error || (status.loading ? 'Checking this workspace…' : status.source === 'git' ? 'This workspace has no uncommitted changes.' : scopeNote)}</p>{refreshButton}</div>;
  if (view === 'files') return <div className="file-tree"><div className="panel-heading"><strong>Working files</strong><span className="muted">{files.length} changed</span>{refreshButton}</div><p className="hint">{scopeNote}</p>{statusNote && <p className="panel-note" role="status">{statusNote}</p>}{files.map((file) => <button className="tree-file" key={file.newPath ?? file.path} onClick={() => select(file)}><Icon name="file" /><span><strong>{basename(file.newPath ?? file.path)}</strong><small>{(file.newPath ?? file.path).split('/').slice(0, -1).join('/') || '.'}</small></span><span className="file-op">{file.op}</span></button>)}</div>;
  return <section className="changes">
    <div className="panel-heading"><strong>Working changes</strong><span className="muted">{reviewedCount} of {files.length} reviewed</span>{refreshButton}</div>
    <p className="hint">{scopeNote}</p>
    {statusNote && <p className="panel-note" role="status">{statusNote}</p>}
    <div className="changes-list">{files.map((file) => <button key={file.newPath ?? file.path} className="change-file" aria-pressed={(file.newPath ?? file.path) === path} onClick={() => select(file)}><Icon name={reviewed.has(changeKey(file)) ? 'check' : 'file'} size={15} /><span>{file.path}{file.newPath ? ` → ${file.newPath}` : ''}</span><small className="file-op">{file.op}</small></button>)}</div>
    <div className="file-heading"><code>{path}</code>{markdown && <div className="file-modes" role="tablist" aria-label="File view"><button role="tab" aria-selected={!showPreview} onClick={() => setMode('diff')}>Diff</button><button role="tab" aria-selected={showPreview} onClick={() => setMode('preview')}>Preview</button></div>}{!showPreview && <label><input type="checkbox" checked={context} onChange={(event) => setContext(event.target.checked)} />Context</label>}<button title="Refresh diff" aria-label="Refresh diff" onClick={() => { setReviewed((previous) => { const next = new Set(previous); next.delete(revision); return next; }); setRefresh((value) => value + 1); }}><Icon name="refresh" size={13} /></button></div>
    {note && <p className="panel-note" role="status">{note}</p>}
    {showPreview ? <div className="md-preview" aria-label={`Preview of ${path}`}>
      {!preview && !note && <p className="hint">Loading file…</p>}
      {preview?.binary && <p className="hint">This file is binary; nothing to preview.</p>}
      {preview && !preview.binary && <Markdown text={preview.text} cacheKey={`${path}:${revision}:${refresh}`} />}
      {preview?.truncated && <p className="panel-note">Only the first part of this file is shown.</p>}
    </div> : <div className="diff" aria-label={`Diff for ${path}`}>
      {!diff && !note && <p className="hint">Loading changes…</p>}
      {diff && !diff.diff && <p className="hint">{diff.source === 'none' ? 'This folder has no Git repository. A diff is unavailable.' : 'No differences against HEAD.'}</p>}
      {diff?.diff && <DiffLines text={diff.diff} path={path} context={context} />}
      {diff?.truncated && <p className="panel-note">This diff was truncated. Review the full change in your editor.</p>}
    </div>}
    <div className="review-footer">{active.invocationId && active.tool !== 'revert_patch' && <button className="subtle-danger" disabled={reverting} onClick={() => setConfirmRevert(!confirmRevert)}>Revert file</button>}<span className="grow" /><button className="primary" disabled={(!diff && !preview) || reverting || reviewed.has(revision)} onClick={markReviewed}><Icon name="check" size={14} />{reviewed.has(revision) ? 'Reviewed' : 'Mark reviewed'}</button></div>
    {confirmRevert && <div className="revert-confirm"><span>Revert Jolo’s change to <strong>{basename(path)}</strong>?</span><button onClick={() => setConfirmRevert(false)} disabled={reverting}>Keep change</button><button className="danger" disabled={reverting} onClick={revert}>{reverting ? 'Reverting…' : 'Revert'}</button></div>}
  </section>;
}
