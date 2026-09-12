import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './icon.jsx';
import { Modal } from './modal.jsx';
import { readArtifactImage } from '../../shared/artifact-images.js';

function ImagePreview({ src, name, saving, saveError, onDownload, onClose }) {
  const canvas = useRef(null);
  const [zoom, setZoom] = useState(1);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = canvas.current;
    const measure = () => setViewport({ width: element.clientWidth, height: element.clientHeight });
    const observer = new ResizeObserver(measure);
    observer.observe(element); measure();
    return () => observer.disconnect();
  }, []);
  const fit = natural.width && viewport.width ? Math.min(1, viewport.width / natural.width, viewport.height / natural.height) : 0;
  useLayoutEffect(() => {
    const element = canvas.current;
    element.scrollLeft = (element.scrollWidth - element.clientWidth) / 2;
    element.scrollTop = (element.scrollHeight - element.clientHeight) / 2;
  }, [zoom]);
  return <Modal label={`Preview ${name}`} className={`image-preview-modal${window.jolo.platform === 'darwin' ? ' macos' : ''}`} onClose={onClose}>
    <div className="image-preview-toolbar"><span className="image-preview-title">{name}</span>
      <button type="button" aria-label="Zoom in image" title="Zoom in" disabled={zoom >= 4} onClick={() => setZoom(value => Math.min(4, value + .25))}><Icon name="zoomIn" size={18} /></button>
      <button type="button" aria-label="Zoom out image" title="Zoom out" disabled={zoom <= .25} onClick={() => setZoom(value => Math.max(.25, value - .25))}><Icon name="zoomOut" size={18} /></button>
      <button type="button" aria-label="Fit image to screen" title="Fit to screen" onClick={() => setZoom(1)}><Icon name="maximize" size={18} /></button>
      <button type="button" aria-label={saving ? 'Saving image' : 'Download image'} title={saving ? 'Saving…' : 'Download image'} onClick={onDownload} disabled={saving}><Icon name={saving ? 'spinner' : 'download'} size={18} /></button><button type="button" aria-label="Close image preview" onClick={onClose}><Icon name="close" size={18} /></button>
    </div>
    {saveError && <p className="image-save-error" role="alert">{saveError}</p>}
    <div ref={canvas} className="image-preview-canvas"><img src={src} alt={name} className={fit ? 'image-preview-scaled' : ''} style={fit ? { width: natural.width * fit * zoom, height: natural.height * fit * zoom } : undefined} onLoad={event => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} /></div>
  </Modal>;
}

/** Fetch only visible thumbnails; release binary data when history scrolls away. */
export function ImageAttachment({ attachment, generated = false }) {
  const element = useRef(null);
  const [visible, setVisible] = useState(false);
  const [src, setSrc] = useState(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false), [saveError, setSaveError] = useState(null);
  const active = visible || expanded;
  const download = async () => {
    setSaving(true); setSaveError(null);
    try {
      if (!window.jolo.saveImage) throw new Error('Restart Jolo to enable image downloads.');
      const response = await window.jolo.saveImage({ artifactId: attachment.artifactId, name: attachment.name });
      if (!response.ok) throw new Error(response.error || 'Couldn’t download this image.');
    } catch (error) {
      setSaveError(/No handler registered|jolo:image:save/.test(error.message) ? 'Restart Jolo to enable image downloads.' : error.message);
    } finally { setSaving(false); }
  };
  useEffect(() => {
    const observer = new IntersectionObserver(entries => setVisible(entries[0].isIntersecting), { rootMargin: '200px' });
    observer.observe(element.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    setFailed(false);
    if (active) (async () => {
      const data = await readArtifactImage(async (method, params) => {
        const response = await window.jolo.call(method, params);
        if (!response.ok) throw new Error('image unavailable');
        return response.result;
      }, attachment.artifactId, () => cancelled);
      if (!cancelled) setSrc(data);
    })().catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [active, attachment.artifactId, attachment.mimeType, attachment.bytes, attempt]);
  return <span className={`message-attachment${generated ? ' generated-image' : ''}${src && !failed ? ' image-ready' : ''}`} ref={element} aria-label={`${generated ? 'Generated' : 'Attached'} image: ${attachment.name}`}>
    {src && !failed ? <>
      <button type="button" className="image-preview-open" aria-label={`Preview ${attachment.name}`} title="Click to enlarge" onClick={() => setExpanded(true)}><img src={src} alt={attachment.name} onError={() => setFailed(true)} /></button>
      {generated && <span className="image-inline-actions"><button type="button" aria-label={saving ? 'Saving image' : 'Download image'} title={saving ? 'Saving…' : 'Download image'} onClick={download} disabled={saving}><Icon name={saving ? 'spinner' : 'download'} size={16} /></button></span>}
    </> : failed ? <button type="button" onClick={() => setAttempt(value => value + 1)}>Retry image</button> : <span className="hint"><Icon name="image" />{attachment.name}</span>}
    {saveError && !expanded && <span className="image-save-error" role="alert">{saveError}</span>}
    {expanded && src && createPortal(<ImagePreview src={src} name={attachment.name} saving={saving} saveError={saveError} onDownload={download} onClose={() => setExpanded(false)} />, document.body)}
  </span>;
}
