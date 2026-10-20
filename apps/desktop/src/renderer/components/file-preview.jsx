import { lazy, Suspense, useEffect, useState } from 'react';
import { Markdown } from './markdown.jsx';
import { Icon } from './icon.jsx';

// CodeMirror and its languages load the first time a file is shown as source.
const CodeEditor = lazy(() => import('./code-editor.jsx').then(module => ({ default: module.CodeEditor })));

/**
 * A file as a tab shows: rendered or as source, and for a project file, editable in place. Source is one editor that is
 * read-only until Edit; edits stay in the tab until saved, so leaving edit mode loses nothing; Cmd/Ctrl+S saves.
 * @param {{ file: any, onClose: (() => void) | null, onSave?: ((text: string) => Promise<void>) | null, onDirty?: ((dirty: boolean) => void) | null }} props
 */
export function FilePreview({ file, onClose, onSave = null, onDirty = null }) {
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
  const [source, setSource] = useState(false);
  const showSource = source || file.kind === 'text' || Boolean(file.line);
  const hasLocation = file.line > 0 && typeof file.text === 'string' && file.line <= file.text.split('\n').length;
  const text = file.kind === 'text' || file.kind === 'markdown';
  const code = text && (editing || showSource);
  return <>
    {(file.line || file.kind === 'markdown' || onClose || onSave) && <div className="file-heading"><code title={file.path}>{file.path.split('/').at(-1)}</code>{file.line && <span className="file-location">Line {file.line}{file.column ? `, column ${file.column}` : ''}</span>}
      {file.kind === 'markdown' && !file.line && <div className="file-modes" role="tablist" aria-label="File view"><button role="tab" aria-selected={!source} onClick={() => setSource(false)}>Preview</button><button role="tab" aria-selected={source} onClick={() => setSource(true)}>Source</button></div>}
      {onSave && dirty && <button className="primary file-save" aria-label="Save file" title="Save (⌘S)" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>}
      {onSave && (editing
        ? <button aria-label="Stop editing" title="Done editing" onClick={() => setEditing(false)}>Done</button>
        : <button aria-label="Edit file" title="Edit this file" onClick={() => { if (draft === null) setDraft(file.text ?? ''); setEditing(true); }}><Icon name="edit" size={14} /></button>)}
      {onClose && <button aria-label="Close file preview" title="Close file preview" onClick={onClose}><Icon name="close" size={14} /></button>}
    </div>}
    {saveError && <p className="panel-note file-save-error" role="alert">{saveError}</p>}
    <div className={`file-preview-content${text ? ' md-preview' : ''}${code ? ' code' : ''}`} aria-label={`Preview of ${file.path}`}>
      {code && <Suspense fallback={null}><CodeEditor path={file.path} value={draft ?? file.text ?? ''} readOnly={!editing} onChange={setDraft} onSave={() => void save()} line={hasLocation ? file.line : null} column={file.column ?? null} reveal={hasLocation ? file : null} /></Suspense>}
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
