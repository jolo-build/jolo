import { useEffect, useRef, useState } from 'react';
import { Icon } from './icon.jsx';
const ALLOWED = /^https?:\/\//i;
export function BrowserPane({ workspaceId, initialUrl, onTitle, onNavigate }) {
  const view = useRef(null);
  const editingAddress = useRef(false);
  const callbacks = useRef({ onTitle, onNavigate });
  callbacks.current = { onTitle, onNavigate };
  const [address, setAddress] = useState(initialUrl ?? '');
  const [src] = useState(initialUrl && ALLOWED.test(initialUrl) ? initialUrl : 'about:blank');
  const [pageUrl, setPageUrl] = useState(initialUrl ?? 'about:blank');
  const [title, setTitle] = useState('');
  const [navigation, setNavigation] = useState({ back: false, forward: false });
  const [error, setError] = useState(null);
  useEffect(() => {
    const element = view.current;
    const titleUpdated = (event) => { setTitle(event.title); callbacks.current.onTitle?.(event.title); };
    const navigated = (event) => { if (event.isMainFrame === false) return; setPageUrl(event.url); if (!editingAddress.current) setAddress(event.url); callbacks.current.onNavigate?.(event.url); setNavigation({ back: element.canGoBack(), forward: element.canGoForward() }); setError(null); };
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
    editingAddress.current = false;
    setAddress(target);
    setError(null);
    if (target === pageUrl) view.current?.reload(); else view.current?.loadURL(target).catch(() => {});
  };
  const discardAddress = () => { editingAddress.current = false; setAddress(pageUrl); setError(null); };
  return <section className="browser" aria-label="Inline browser">
    <form className="browser-bar" noValidate onSubmit={(event) => { event.preventDefault(); go(); }}><button type="button" onClick={() => { discardAddress(); view.current?.goBack(); }} aria-label="Back" disabled={!navigation.back}><Icon name="back" size={14} /></button><button type="button" onClick={() => { discardAddress(); view.current?.goForward(); }} aria-label="Forward" disabled={!navigation.forward}><Icon name="forward" size={14} /></button><button type="button" onClick={() => { discardAddress(); view.current?.reload(); }} aria-label="Reload"><Icon name="refresh" size={14} /></button><input type="url" aria-label="Browser address" inputMode="url" autoCorrect="off" autoCapitalize="none" autoComplete="off" spellCheck={false} value={address === 'about:blank' ? '' : address} onChange={(event) => { editingAddress.current = true; setAddress(event.target.value); }} onKeyDown={event => { if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); discardAddress(); } }} placeholder="Enter a URL or localhost:3000" /><button type="submit" aria-label="Navigate"><Icon name="right" size={14} /></button></form>
    {error && <div className="panel-note negative" role="alert">{error}</div>}
    <div className="browser-content"><webview ref={view} src={src} partition={`jolo-browser-${workspaceId}`} title={title || 'Browser page'} />{(!pageUrl || pageUrl === 'about:blank') && <div className="browser-start panel-empty"><Icon name="browser" size={30} /><h2>Your app, right here.</h2><p>Open a website or ask your agent to navigate, inspect, and interact with it.</p></div>}</div>
  </section>;
}
