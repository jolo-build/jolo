import { useEffect, useState } from 'react';
import { Modal } from './modal.jsx';
import { Icon } from './icon.jsx';
import { engineCall } from '../engine-context.jsx';

export function TextAttachment({ attachment }) {
  const binary = attachment.mimeType === 'application/octet-stream';
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(attachment.text ?? null);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!open || text !== null) return;
    let cancelled = false;
    (async () => {
      const bytes = new Uint8Array(attachment.bytes);
      let offset = 0;
      while (offset < bytes.length) {
        const result = await engineCall('artifact.read', { artifactId: attachment.artifactId, offset, length: Math.min(65535, bytes.length - offset), encoding: 'base64' });
        if (cancelled) return;
        const chunk = Uint8Array.from(atob(result.text), char => char.charCodeAt(0));
        if (!chunk.length) throw new Error('The attachment is incomplete.');
        bytes.set(chunk, offset); offset += chunk.length;
      }
      if (!cancelled) setText(new TextDecoder().decode(bytes));
    })().catch(error => { if (!cancelled) setError(error.message); });
    return () => { cancelled = true; };
  }, [open, text, attachment.artifactId, attachment.bytes]);
  if (binary) return <div className="text-attachment-card" title={attachment.name}><Icon name="file" size={22} /><span><strong>{attachment.name}</strong><small>File · {Math.max(1, Math.ceil(attachment.bytes / 1024))} KB</small></span></div>;
  return <>
    <button className="text-attachment-card" type="button" onClick={() => { setError(null); setOpen(true); }} aria-label={`Open ${attachment.name}`}>
      <Icon name="file" size={22} /><span><strong>{attachment.name}</strong><small>Text · {Math.max(1, Math.ceil(attachment.bytes / 1024))} KB</small></span>
    </button>
    {open && <Modal label={attachment.name} className="text-attachment-preview" onClose={() => setOpen(false)}>
      <div className="text-attachment-heading"><strong>{attachment.name}</strong><button type="button" aria-label="Close text preview" onClick={() => setOpen(false)}><Icon name="close" /></button></div>
      {error ? <p role="alert">{error}</p> : text === null ? <p role="status">Loading text…</p> : <pre>{text}</pre>}
    </Modal>}
  </>;
}
