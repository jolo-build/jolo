import { useEffect, useState } from 'react';

// Draw in the trusted renderer, outside the page's DOM, hit testing, and screenshots.
export function BrowserCursor({ view, working = false }) {
  const [cursor, setCursor] = useState(null);
  useEffect(() => {
    const element = view.current;
    let sequence = 0;
    const clear = () => setCursor(null);
    const unsubscribe = window.jolo.onBrowserCursor?.(payload => {
      try { if (payload.guestId !== element.getWebContentsId()) return; } catch { return; }
      if (!payload.visible) { clear(); return; }
      if (!Number.isFinite(payload.x) || !Number.isFinite(payload.y) || payload.x < 0 || payload.x > 1 || payload.y < 0 || payload.y > 1) return;
      setCursor({ ...payload, sequence: ++sequence });
    });
    const navigating = event => { if (event.isMainFrame) clear(); };
    element.addEventListener('did-start-navigation', navigating);
    element.addEventListener('render-process-gone', clear);
    return () => {
      unsubscribe?.();
      element.removeEventListener('did-start-navigation', navigating);
      element.removeEventListener('render-process-gone', clear);
    };
  }, [view]);
  // A browser call can finish quickly while the agent continues reading or planning its next action.
  // Hold its last position throughout that run and only fade once both the call and run are idle.
  useEffect(() => {
    if (!cursor?.visible || cursor.busy || working) return;
    const timer = setTimeout(() => setCursor(current => current && { ...current, visible: false }), 1800);
    return () => clearTimeout(timer);
  }, [cursor, working]);
  if (!cursor) return null;
  return <div className="browser-agent-cursor-layer" aria-hidden="true">
    <div className="browser-agent-cursor" data-visible={cursor.visible} style={{ left: `${cursor.x * 100}%`, top: `${cursor.y * 100}%` }}>
      {cursor.action === 'click' && <span key={cursor.sequence} className="browser-agent-cursor-click" />}
      <svg width="24" height="28" viewBox="0 0 24 28"><path d="M2 2L21 16L12 17L8 25Z" fill="currentColor" stroke="white" strokeWidth="2" strokeLinejoin="round" /></svg>
      <span className="browser-agent-cursor-label">Jolo{({ type: ' · Typing', scroll: ' · Scrolling', navigate: ' · Navigating', inspect: ' · Inspecting', screenshot: ' · Capturing', network: ' · Checking network', working: ' · Working' })[cursor.action] ?? ''}</span>
    </div>
  </div>;
}
