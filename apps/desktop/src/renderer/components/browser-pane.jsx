import { useEffect, useRef, useState } from 'react';
import { Icon } from './icon.jsx';
const ALLOWED = /^https?:\/\//i;
export function BrowserPane({ workspaceId, initialUrl, onTitle, onNavigate }) {
  const view = useRef(null);
  const callbacks = useRef({ onTitle, onNavigate });
  callbacks.current = { onTitle, onNavigate };
  const [address, setAddress] = useState(initialUrl ?? '');
  const [src, setSrc] = useState(initialUrl && ALLOWED.test(initialUrl) ? initialUrl : 'about:blank');
  const [title, setTitle] = useState('');
  const [navigation, setNavigation] = useState({ back: false, forward: false });
  const [error, setError] = useState(null);
  useEffect(() => {
    const element = view.current;
    const titleUpdated = (event) => { setTitle(event.title); callbacks.current.onTitle?.(event.title); };
    const navigated = (event) => { setAddress(event.url); callbacks.current.onNavigate?.(event.url); setNavigation({ back: element.canGoBack(), forward: element.canGoForward() }); setError(null); };
    const failed = (event) => { if (event.isMainFrame && event.errorCode !== -3) setError(event.errorDescription); };
    element.addEventListener('page-title-updated', titleUpdated);
    element.addEventListener('did-navigate', navigated);
    element.addEventListener('did-navigate-in-page', navigated);
    element.addEventListener('did-fail-load', failed);
    return () => { element.removeEventListener('page-title-updated', titleUpdated); element.removeEventListener('did-navigate', navigated); element.removeEventListener('did-navigate-in-page', navigated); element.removeEventListener('did-fail-load', failed); };
  }, []);
  const go = () => {
    let target = address.trim();
    if (!target) return;
    if (!/^[a-z][a-z\d+.-]*:/i.test(target) || /^(localhost|127\.0\.0\.1):\d+/i.test(target)) target = `${/^(localhost|127\.0\.0\.1)(:|\/|$)/.test(target) ? 'http' : 'https'}://${target}`;
    if (!ALLOWED.test(target)) { setError('Enter an http or https address.'); return; }
    setError(null);
    if (target === src) view.current?.reload(); else setSrc(target);
  };
  return <section className="browser" aria-label="Inline browser">
    <form className="browser-bar" onSubmit={(event) => { event.preventDefault(); go(); }}><button type="button" onClick={() => view.current?.goBack()} aria-label="Back" disabled={!navigation.back}><Icon name="back" size={14} /></button><button type="button" onClick={() => view.current?.goForward()} aria-label="Forward" disabled={!navigation.forward}><Icon name="forward" size={14} /></button><button type="button" onClick={() => view.current?.reload()} aria-label="Reload"><Icon name="refresh" size={14} /></button><input aria-label="Browser address" value={address === 'about:blank' ? '' : address} onChange={(event) => setAddress(event.target.value)} placeholder="Search by URL or localhost:3000" /><button type="submit" aria-label="Navigate"><Icon name="right" size={14} /></button></form>
    {error && <div className="panel-note negative" role="alert">{error}</div>}
    <div className="browser-content"><webview ref={view} src={src} partition={`jolo-browser-${workspaceId}`} title={title || 'Browser page'} />{src === 'about:blank' && <div className="browser-start panel-empty"><Icon name="browser" size={30} /><h2>Your app, right here.</h2><p>Open a local preview or a website to explore it with Jolo.</p></div>}</div>
  </section>;
}
