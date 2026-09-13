import { useLayoutEffect, useRef, useState } from 'react';
import { Markdown } from './markdown.jsx';
import { Icon } from './icon.jsx';

export function FilePreview({ file, onClose }) {
  const [source, setSource] = useState(false);
  const selected = useRef(null);
  const showSource = source || file.kind === 'text' || Boolean(file.line);
  const lines = typeof file.text === 'string' ? file.text.split('\n') : [];
  const hasLocation = file.line > 0 && file.line <= lines.length;
  useLayoutEffect(() => { selected.current?.scrollIntoView({ block: 'center', inline: 'center' }); }, [file, showSource]);
  const text = file.kind === 'text' || file.kind === 'markdown';
  return <>
    <div className="file-heading"><code title={file.path}>{file.path.split('/').at(-1)}</code>{file.line && <span className="file-location">Line {file.line}{file.column ? `, column ${file.column}` : ''}</span>}
      {file.kind === 'markdown' && !file.line && <div className="file-modes" role="tablist" aria-label="File view"><button role="tab" aria-selected={!source} onClick={() => setSource(false)}>Preview</button><button role="tab" aria-selected={source} onClick={() => setSource(true)}>Source</button></div>}
      {onClose && <button aria-label="Close file preview" title="Close file preview" onClick={onClose}><Icon name="close" size={14} /></button>}
    </div>
    <div className={`file-preview-content${text ? ' md-preview' : ''}`} aria-label={`Preview of ${file.path}`}>
      {text && (showSource ? <pre className="file-preview-source"><code>{hasLocation ? <>{lines.slice(0, file.line - 1).join('\n')}{file.line > 1 ? '\n' : ''}<mark className="file-source-location">{lines[file.line - 1].slice(0, Math.max(0, (file.column ?? 1) - 1))}<span ref={selected} className="file-source-caret">{lines[file.line - 1].slice(Math.max(0, (file.column ?? 1) - 1), file.column ?? 1)}</span>{lines[file.line - 1].slice(file.column ?? 1)}</mark>{file.line < lines.length ? '\n' : ''}{lines.slice(file.line).join('\n')}</> : file.text}</code></pre> : <Markdown text={file.text} cacheKey={file.text} sessionId={file.sessionId} />)}
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
