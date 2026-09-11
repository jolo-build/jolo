import { useEffect, useRef, useState } from 'react';
import { Icon } from './icon.jsx';
import { Modal } from './modal.jsx';

const RESTART_MESSAGE = 'Restart Jolo to enable visualization previews. Reloading the page is not enough.';

/**
 * @param {{
 *   preview: { id: string, url: string, height?: number },
 *   title: string,
 *   onHeight?: (height: number) => void,
 *   expanded?: boolean,
 * }} props an expanded frame fills its dialog, so it neither measures nor reports its content height.
 */
function PreviewFrame({ preview, title, onHeight, expanded = false }) {
  const frame = useRef(null);
  useEffect(() => {
    if (!onHeight) return;
    const resize = event => {
      if (event.source !== frame.current?.contentWindow || event.data?.type !== 'jolo:visualization-height' || event.data.id !== preview.id || !Number.isFinite(event.data.height)) return;
      onHeight(Math.max(120, Math.min(1600, event.data.height)));
    };
    window.addEventListener('message', resize);
    return () => window.removeEventListener('message', resize);
  }, [preview.id, onHeight]);
  return <iframe ref={frame} className="visualization-frame" title={title} src={preview.url} sandbox="allow-scripts" referrerPolicy="no-referrer" allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'" style={expanded ? undefined : { height: preview.height }} />;
}

export function Visualization({ block, sessionId, streaming }) {
  const root = useRef(null);
  const [visible, setVisible] = useState(false), [expanded, setExpanded] = useState(false);
  const [preview, setPreview] = useState(null), [error, setError] = useState(null), [attempt, setAttempt] = useState(0);
  const [height, setHeight] = useState(320);
  const title = block.title || block.path?.split(/[\\/]/).at(-1) || 'Visualization';
  const active = visible || expanded;
  useEffect(() => {
    const observer = new IntersectionObserver(entries => setVisible(entries[0].isIntersecting), { rootMargin: '200px' });
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let live = true, url;
    setPreview(null); setError(null);
    if (active && block.status === 'ready' && sessionId) {
      if (!window.jolo.prepareVisualization) setError({ message: RESTART_MESSAGE, restart: true });
      else window.jolo.prepareVisualization({ sessionId, path: block.path }).then(result => {
        if (!result.ok) throw new Error(result.error);
        url = result.result.url;
        if (live) setPreview(result.result);
        else window.jolo.releaseVisualization(url);
      }).catch(error => {
        if (!live) return;
        const restart = /No handler registered for ['"]jolo:visualization:prepare['"]/.test(error.message);
        setError({ message: restart ? RESTART_MESSAGE : error.message || 'Couldn’t load the visualization.', restart });
      });
    }
    return () => { live = false; if (url) window.jolo.releaseVisualization(url); };
  }, [active, block.path, block.status, sessionId, attempt]);
  return <section ref={root} className={`visualization ${block.mode === 'wide' ? 'wide' : ''}`} aria-label={title}>
    <div className="visualization-toolbar"><Icon name="browser" size={14} /><span title={block.path}>{title}</span>{preview && <button type="button" onClick={() => setExpanded(true)} aria-label={`Expand ${title}`}><Icon name="maximize" size={13} />Expand</button>}</div>
    {block.status !== 'ready' ? <p className="visualization-note" role="status">{block.status === 'pending' ? streaming ? 'Preparing visualization…' : 'This visualization reference is incomplete.' : 'This visualization reference is invalid.'}</p>
      : !sessionId ? <p className="visualization-note">Open this chat to preview its visualization.</p>
      : error ? <div className="visualization-note" role="alert"><p>{error.message}</p>{!error.restart && <button type="button" onClick={() => setAttempt(value => value + 1)}>Retry preview</button>}</div>
      : preview ? <PreviewFrame preview={{ ...preview, height }} title={title} onHeight={setHeight} />
      : <div className="visualization-note" style={{ minHeight: height }} role="status">{active ? 'Loading visualization…' : 'Visualization preview'}</div>}
    {expanded && preview && <Modal label={title} className={`visualization-modal${block.mode === 'wide' ? ' wide' : ''}`} onClose={() => setExpanded(false)}><div className="visualization-toolbar"><span>{title}</span><button type="button" onClick={() => setExpanded(false)} aria-label="Close preview"><Icon name="close" size={16} /></button></div><PreviewFrame preview={preview} title={title} expanded /></Modal>}
  </section>;
}
