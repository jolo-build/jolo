import { useEffect, useRef, useState } from 'react';
import { Icon } from './icon.jsx';

/** Fetch only visible thumbnails; release binary data when history scrolls away. */
export function ImageAttachment({ attachment }) {
  const element = useRef(null);
  const [visible, setVisible] = useState(false);
  const [src, setSrc] = useState(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const observer = new IntersectionObserver(entries => setVisible(entries[0].isIntersecting), { rootMargin: '200px' });
    observer.observe(element.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    setFailed(false);
    if (visible) (async () => {
      let offset = 0;
      const chunks = [];
      while (offset < attachment.bytes && !cancelled) {
        const response = await window.jolo.call('artifact.read', { artifactId: attachment.artifactId, offset, length: Math.min(65535, attachment.bytes - offset), encoding: 'base64' });
        if (!response.ok || !response.result.bytes) throw new Error('image unavailable');
        chunks.push(response.result.text);
        offset += response.result.bytes;
      }
      if (!cancelled) setSrc(`data:${attachment.mimeType};base64,${chunks.join('')}`);
    })().catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [visible, attachment.artifactId, attachment.mimeType, attachment.bytes, attempt]);
  return <div className="message-attachment" ref={element} aria-label={`Attached image: ${attachment.name}`}>
    {src && !failed ? <img src={src} alt={attachment.name} onError={() => setFailed(true)} /> : failed ? <button type="button" onClick={() => setAttempt(value => value + 1)}>Retry image</button> : <span className="hint"><Icon name="image" />{attachment.name}</span>}
  </div>;
}
