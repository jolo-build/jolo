import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Markdown } from './markdown.jsx';
import { Icon } from './icon.jsx';
import { DiffLines } from './diff-lines.jsx';
import { FileOpenMenu } from './file-open-menu.jsx';

const SyntaxFile = lazy(() => import('./syntax-file.jsx'));

export function FilePreview({ file, onClose }) {
  const [source, setSource] = useState(false);
  const [mode, setMode] = useState('source');
  const [diff, setDiff] = useState(null);
  const [error, setError] = useState(null);
  const [openError, setOpenError] = useState(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (mode !== 'diff' || !file.diffTarget) return;
    let active = true;
    setDiff(null); setError(null);
    window.jolo.call('workspace.diff', file.diffTarget).then(reply => {
      if (!active) return;
      if (!reply.ok) throw new Error(reply.error?.message || 'Could not load this diff.');
      setDiff(reply.result);
    }).catch(error => { if (active) setError(error.message); });
    return () => { active = false; };
  }, [file, mode, revision]);
  const selected = useRef(null);
  const showSource = source || file.kind === 'text' || (Boolean(file.line) && mode !== 'preview');
  const lines = typeof file.text === 'string' ? file.text.split('\n') : [];
  const hasLocation = file.line > 0 && file.line <= lines.length;
  useLayoutEffect(() => { selected.current?.scrollIntoView({ block: 'center', inline: 'center' }); }, [file, showSource]);
  const text = ['text', 'markdown', 'html'].includes(file.kind);
  const canPreview = ['markdown', 'html'].includes(file.kind);
  const preview = () => { setMode('preview'); setSource(false); };
  return <>
    <div className="file-heading"><code title={file.path}>{file.path.split('/').at(-1)}</code>{file.line && <span className="file-location">Line {file.line}{file.column ? `, column ${file.column}` : ''}</span>}
      {text && <div className="file-modes" role="tablist" aria-label="File view">{canPreview && <button role="tab" aria-selected={mode !== 'diff' && !showSource} onClick={preview}>Preview</button>}<button role="tab" aria-selected={mode !== 'diff' && showSource} onClick={() => { setMode('source'); setSource(true); }}>Source</button>{file.diffTarget && <button role="tab" aria-selected={mode === 'diff'} onClick={() => setMode('diff')}>Diff</button>}</div>}
      {mode === 'diff' && <button className="icon-button" aria-label="Refresh file diff" title="Refresh file diff" onClick={() => setRevision(value => value + 1)}><Icon name="refresh" size={14} /></button>}
      <FileOpenMenu file={file} onError={setOpenError} />
      {onClose && <button aria-label="Close file preview" title="Close file preview" onClick={onClose}><Icon name="close" size={14} /></button>}
    </div>
    {openError && <p className="panel-note" role="alert">{openError}</p>}
    <div className={`file-preview-content${mode === 'diff' ? ' diff' : file.kind === 'markdown' && !showSource ? ' md-preview' : ''}`} aria-label={`Preview of ${file.path}`}>
      {text && (mode === 'diff' ? <>
        <p className="panel-note">Uncommitted changes compared with HEAD.</p>
        {error ? <p role="alert">{error}</p> : !diff ? <p role="status">Loading diff…</p> : diff.diff ? <DiffLines text={diff.diff} path={file.path} /> : <p>{diff.source === 'git' ? 'No uncommitted changes in this file.' : 'Diff unavailable: this workspace is not a Git repository.'}</p>}
        {diff?.truncated && <p className="panel-note">This diff is truncated.</p>}
      </> : showSource ? <Suspense fallback={<pre className="file-preview-source"><code>{file.text}</code></pre>}><SyntaxFile file={file} selected={selected} /></Suspense> : file.kind === 'html' ? <iframe className="file-html-preview" src={file.url} title={`HTML preview of ${file.path.split('/').at(-1)}`} sandbox="allow-scripts" referrerPolicy="no-referrer" allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'" /> : <Markdown text={file.text} cacheKey={file.text} sessionId={file.sessionId} />)}
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
