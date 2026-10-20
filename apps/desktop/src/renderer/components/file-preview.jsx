import { Fragment, lazy, Suspense, useEffect, useState } from 'react';
import { Markdown } from './markdown.jsx';
import { Icon } from './icon.jsx';

// CodeMirror and its languages load the first time a file is shown as source.
const CodeEditor = lazy(() => import('./code-editor.jsx').then(module => ({ default: module.CodeEditor })));

/**
 * A file as a tab shows: rendered or as source, and for a project file, editable in place. Source is one editor that is
 * read-only until Edit; edits stay in the tab until saved, so leaving edit mode loses nothing; Cmd/Ctrl+S saves, and
 * Revert puts the saved text back. A project file's heading is its path as a breadcrumb, each folder a quiet button that
 * shows it in the tree (`onReveal`); at its right end, `onExpand` lets the panel take the whole pane, or gives it back.
 * A file's `line` is revealed again whenever `file.opened`, or without it the file object, is new.
 * @param {{ file: any, onClose: (() => void) | null, onSave?: ((text: string) => Promise<void>) | null, onDirty?: ((dirty: boolean) => void) | null, onReveal?: ((folder: string) => void) | null, expanded?: boolean, onExpand?: (() => void) | null }} props
 */
export function FilePreview({ file, onClose, onSave = null, onDirty = null, onReveal = null, expanded = false, onExpand = null }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(/** @type {string | null} */ (null));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const dirty = draft !== null && draft !== file.text;
  useEffect(() => { onDirty?.(dirty); }, [dirty]);
  const save = async () => {
    if (!onSave || !dirty || saving) return;
    setSaving(true); setSaveError('');
    try { await onSave(draft); setDraft(null); } catch (error) { setSaveError(error.message); } finally { setSaving(false); }
  };
  const [reverted, setReverted] = useState(0); // counts Reverts, so the editor takes the saved text back even while it has focus
  const revert = () => { setDraft(file.text ?? ''); setSaveError(''); setReverted(count => count + 1); };
  const [source, setSource] = useState(false);
  const showSource = source || file.kind === 'text' || Boolean(file.line);
  const hasLocation = file.line > 0 && typeof file.text === 'string' && file.line <= file.text.split('\n').length;
  const text = file.kind === 'text' || file.kind === 'markdown';
  const code = text && (editing || showSource);
  const parts = file.path.split('/'), folders = onReveal ? parts.slice(0, -1) : [];
  return <>
    {(file.line || file.kind === 'markdown' || onClose || onSave || onExpand) && <div className="file-heading"><code className="file-crumbs" title={file.path}>{folders.map((part, index) => <Fragment key={index}><button type="button" title={`Show ${parts.slice(0, index + 1).join('/')} in the tree`} onClick={() => onReveal(parts.slice(0, index + 1).join('/'))}>{part}</button><span aria-hidden="true">/</span></Fragment>)}{parts.at(-1)}</code>{file.line && <span className="file-location">Line {file.line}{file.column ? `, column ${file.column}` : ''}</span>}
      {file.kind === 'markdown' && !file.line && <div className="file-modes" role="tablist" aria-label="File view"><button role="tab" aria-selected={!source} onClick={() => setSource(false)}>Preview</button><button role="tab" aria-selected={source} onClick={() => setSource(true)}>Source</button></div>}
      {onSave && dirty && <button className="file-revert" aria-label="Revert file" title="Discard unsaved changes" disabled={saving} onClick={revert}>Revert</button>}
      {onSave && dirty && <button className="primary file-save" aria-label="Save file" title="Save (⌘S)" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>}
      {onSave && (editing
        ? <button aria-label="Stop editing" title="Done editing" onClick={() => setEditing(false)}>Done</button>
        : <button aria-label="Edit file" title="Edit this file" onClick={() => { if (draft === null) setDraft(file.text ?? ''); setEditing(true); }}><Icon name="edit" size={14} /></button>)}
      {onClose && <button aria-label="Close file preview" title="Close file preview" onClick={onClose}><Icon name="close" size={14} /></button>}
      {onExpand && <button className="file-expand" aria-label={expanded ? 'Restore panel' : 'Expand panel'} aria-pressed={expanded} title={expanded ? 'Restore (Esc)' : 'Expand to the whole pane'} onClick={onExpand}><Icon name={expanded ? 'collapse' : 'expand'} size={13} /></button>}
    </div>}
    {saveError && <p className="panel-note file-save-error" role="alert">{saveError}</p>}
    <div className={`file-preview-content${text ? ' md-preview' : ''}${code ? ' code' : ''}`} aria-label={`Preview of ${file.path}`}>
      {code && <Suspense fallback={null}><CodeEditor path={file.path} value={draft ?? file.text ?? ''} readOnly={!editing} onChange={setDraft} onSave={() => void save()} line={hasLocation ? file.line : null} column={file.column ?? null} reveal={hasLocation ? file.opened ?? file : null} revision={reverted} /></Suspense>}
      {text && !code && <Markdown text={file.text} cacheKey={file.text} sessionId={file.sessionId} />}
      {file.kind === 'image' && <img src={file.url} alt={file.path.split('/').at(-1)} />}
      {file.kind === 'pdf' && <embed src={file.url} type="application/pdf" title={file.path.split('/').at(-1)} />}
      {file.kind === 'audio' && <audio src={file.url} controls preload="metadata" />}
      {file.kind === 'video' && <video src={file.url} controls preload="metadata" />}
      {file.kind === 'details' && <div className="panel-empty"><Icon name="file" size={28} /><h2>{file.path.split('/').at(-1)}</h2><p>{file.note}</p><p>{file.size.toLocaleString()} bytes · {file.extension || 'File'}</p><code>{file.path}</code></div>}
      {text && file.line && !hasLocation && <p className="panel-note">Line {file.line} is outside this preview.</p>}
      {file.truncated && <p className="panel-note">Only the first 256 KiB of this file is shown.</p>}
    </div>
  </>;
}
