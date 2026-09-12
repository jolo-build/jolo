import { useState } from 'react';
import { Markdown } from './markdown.jsx';
import { Icon } from './icon.jsx';

export function FilePreview({ file, onClose }) {
  const [source, setSource] = useState(false);
  const text = file.kind === 'text' || file.kind === 'markdown';
  return <>
    <div className="file-heading"><code title={file.path}>{file.path.split('/').at(-1)}</code>
      {file.kind === 'markdown' && <div className="file-modes" role="tablist" aria-label="File view"><button role="tab" aria-selected={!source} onClick={() => setSource(false)}>Preview</button><button role="tab" aria-selected={source} onClick={() => setSource(true)}>Source</button></div>}
      <button aria-label="Close file preview" title="Close file preview" onClick={onClose}><Icon name="close" size={14} /></button>
    </div>
    <div className={`file-preview-content${text ? ' md-preview' : ''}`} aria-label={`Preview of ${file.path}`}>
      {text && (source || file.kind === 'text' ? <pre className="file-preview-source"><code>{file.text}</code></pre> : <Markdown text={file.text} cacheKey={file.text} sessionId={file.sessionId} />)}
      {file.kind === 'image' && <img src={file.url} alt={file.path.split('/').at(-1)} />}
      {file.kind === 'pdf' && <embed src={file.url} type="application/pdf" title={file.path.split('/').at(-1)} />}
      {file.kind === 'audio' && <audio src={file.url} controls preload="metadata" />}
      {file.kind === 'video' && <video src={file.url} controls preload="metadata" />}
      {file.kind === 'details' && <div className="panel-empty"><Icon name="file" size={28} /><h2>{file.path.split('/').at(-1)}</h2><p>{file.note}</p><p>{file.size.toLocaleString()} bytes · {file.extension || 'File'}</p><code>{file.path}</code></div>}
      {file.truncated && <p className="panel-note">Only the first 256 KiB of this file is shown.</p>}
    </div>
  </>;
}
