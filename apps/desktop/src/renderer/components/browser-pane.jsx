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
  const [hasPage, setHasPage] = useState(false);
  const [loading, setLoading] = useState(src !== 'about:blank');
  useEffect(() => {
    const element = view.current;
    const titleUpdated = (event) => { setTitle(event.title); callbacks.current.onTitle?.(event.title); };
    const navigated = (event) => { if (event.isMainFrame === false) return; setHasPage(event.url !== 'about:blank'); setPageUrl(event.url); if (!editingAddress.current) setAddress(event.url); callbacks.current.onNavigate?.(event.url); setNavigation({ back: element.canGoBack(), forward: element.canGoForward() }); setError(null); };
    const failed = (event) => { if (event.isMainFrame && event.errorCode !== -3) { setHasPage(false); setError(event.errorDescription); } };
    const focused = () => window.dispatchEvent(new Event('jolo:browser-focus'));
    const started = () => setLoading(true);
    const stopped = () => setLoading(false);
    element.addEventListener('page-title-updated', titleUpdated);
    element.addEventListener('did-navigate', navigated);
    element.addEventListener('did-navigate-in-page', navigated);
    element.addEventListener('did-fail-load', failed);
    element.addEventListener('focus', focused);
    element.addEventListener('did-start-loading', started);
    element.addEventListener('did-stop-loading', stopped);
    return () => { element.removeEventListener('page-title-updated', titleUpdated); element.removeEventListener('did-navigate', navigated); element.removeEventListener('did-navigate-in-page', navigated); element.removeEventListener('did-fail-load', failed); element.removeEventListener('focus', focused); element.removeEventListener('did-start-loading', started); element.removeEventListener('did-stop-loading', stopped); };
  }, []);
  const go = () => {
    let target = address.trim();
    if (!target) return;
    if (!/^[a-z][a-z\d+.-]*:/i.test(target) || /^(localhost|127\.0\.0\.1):\d+/i.test(target)) target = `${/^(localhost|127\.0\.0\.1)(:|\/|$)/.test(target) ? 'http' : 'https'}://${target}`;
    if (!ALLOWED.test(target)) { setError('Enter an http or https address.'); return; }
    editingAddress.current = false;
    setAddress(target);
    setError(null);
    setLoading(true);
    if (target === pageUrl) view.current?.reload(); else view.current?.loadURL(target).catch(() => setLoading(view.current?.isLoading() ?? false));
  };
  const discardAddress = () => { editingAddress.current = false; setAddress(pageUrl); setError(null); };
  return <section className="browser" aria-label="Inline browser">
    <form className="browser-bar" noValidate onSubmit={(event) => { event.preventDefault(); go(); }}><button type="button" onClick={() => { discardAddress(); view.current?.goBack(); }} aria-label="Back" disabled={!navigation.back}><Icon name="back" size={14} /></button><button type="button" onClick={() => { discardAddress(); view.current?.goForward(); }} aria-label="Forward" disabled={!navigation.forward}><Icon name="forward" size={14} /></button><button type="button" onClick={() => { if (loading) view.current?.stop(); else { discardAddress(); view.current?.reload(); } }} aria-label={loading ? 'Stop loading' : 'Reload'} title={loading ? 'Loading website — click to stop' : 'Reload'}><Icon name={loading ? 'spinner' : 'refresh'} className={loading ? 'activity-spin' : ''} size={14} /></button><input type="url" aria-label="Browser address" inputMode="url" autoCorrect="off" autoCapitalize="none" autoComplete="off" spellCheck={false} value={address === 'about:blank' ? '' : address} onChange={(event) => { editingAddress.current = true; setAddress(event.target.value); }} onKeyDown={event => { if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); discardAddress(); } }} placeholder="Enter a URL or localhost:3000" /><button type="submit" aria-label="Navigate"><Icon name="right" size={14} /></button></form>
    {error && <div className="panel-note negative" role="alert">{error}</div>}
    <div className="browser-content" aria-busy={loading} data-has-page={hasPage}><webview ref={view} src={src} partition={`jolo-browser-${workspaceId}`} title={title || 'Browser page'} />{(!pageUrl || pageUrl === 'about:blank') && <div className="browser-start panel-empty"><Icon name="browser" size={30} /><h2>Your app, right here.</h2><p>Open a website or ask your agent to navigate, inspect, and interact with it.</p></div>}</div>
  </section>;
}
