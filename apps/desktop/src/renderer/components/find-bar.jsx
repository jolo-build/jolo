import { useEffect, useRef, useState } from 'react';
import { Icon } from './icon.jsx';

const ALL = 'jolo-find', ACTIVE = 'jolo-find-active', MAX_MATCHES = 500;
const highlights = () => /** @type {any} */ (globalThis).CSS?.highlights ?? null;

/** Every visible run of text on the page that contains the query, as ranges, in page order. */
function collect(query) {
  const needle = query.toLowerCase();
  const ranges = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode: node => {
    const element = node.parentElement;
    if (!element || !node.nodeValue?.trim() || element.closest('.find-bar, script, style, textarea, [hidden]')) return NodeFilter.FILTER_REJECT;
    return NodeFilter.FILTER_ACCEPT;
  } });
  for (let node = walker.nextNode(); node && ranges.length < MAX_MATCHES; node = walker.nextNode()) {
    const text = node.nodeValue.toLowerCase();
    for (let at = text.indexOf(needle); at !== -1 && ranges.length < MAX_MATCHES; at = text.indexOf(needle, at + needle.length)) {
      const range = new Range(); range.setStart(node, at); range.setEnd(node, at + needle.length);
      const rect = range.getBoundingClientRect();
      if (rect.width > 0 || rect.height > 0) ranges.push(range); // text that is not drawn is not a match
    }
  }
  return ranges;
}

/**
 * Find on the page: Cmd/Ctrl+F opens it, Enter and Shift+Enter step through the matches, Esc closes it. Matching
 * happens in the page itself and the marks are highlights, so the chat, the sidebar and any open panel are covered
 * without the page changing underneath.
 * @param {{ open: boolean, onClose: () => void }} props
 */
export function FindBar({ open, onClose }) {
  const input = useRef(/** @type {HTMLInputElement | null} */ (null));
  const [query, setQuery] = useState('');
  const [found, setFound] = useState({ total: 0, active: 0 });
  const ranges = useRef(/** @type {Range[]} */ ([]));
  const show = (list, active) => {
    ranges.current = list;
    const api = highlights(), Mark = /** @type {any} */ (globalThis).Highlight;
    if (api && Mark) { api.set(ALL, new Mark(...list)); api.set(ACTIVE, new Mark(...(list[active] ? [list[active]] : []))); }
    list[active]?.startContainer.parentElement?.scrollIntoView({ block: 'center' });
    setFound({ total: list.length, active: list.length ? active : 0 });
  };
  const clear = () => { ranges.current = []; highlights()?.delete(ALL); highlights()?.delete(ACTIVE); setFound({ total: 0, active: 0 }); };
  const step = (direction) => { const list = ranges.current; if (!list.length) return; show(list, (found.active + direction + list.length) % list.length); };
  useEffect(() => {
    if (!open) { clear(); return; }
    input.current?.focus(); input.current?.select();
    if (!query.trim()) { clear(); return; }
    show(collect(query.trim()), 0);
    // The page keeps changing while a reply streams in, so the marks follow it, a little behind.
    let timer = null;
    const observer = new MutationObserver(() => { if (timer) return; timer = setTimeout(() => { timer = null; const list = collect(query.trim()); show(list, Math.min(found.active, Math.max(0, list.length - 1))); }, 300); });
    observer.observe(document.body, { childList: true, characterData: true, subtree: true });
    return () => { observer.disconnect(); if (timer) clearTimeout(timer); };
  }, [open, query]);
  if (!open) return null;
  const count = query.trim() ? (found.total ? `${found.active + 1}/${found.total}` : '0/0') : '';
  return <div className="find-bar" role="search" aria-label="Find in page">
    <div className="find-field">
      <input ref={input} type="text" value={query} placeholder="Find in page" spellCheck={false} aria-label="Find in page" onChange={event => setQuery(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); step(event.shiftKey ? -1 : 1); } else if (event.key === 'Escape') { event.preventDefault(); onClose(); } }} />
      <span className={`find-count${query.trim() && !found.total ? ' none' : ''}`} aria-live="polite">{count}</span>
    </div>
    <button type="button" aria-label="Previous match" title="Previous (⇧↩)" disabled={!found.total} onClick={() => step(-1)}><Icon name="down" size={14} className="find-up" /></button>
    <button type="button" aria-label="Next match" title="Next (↩)" disabled={!found.total} onClick={() => step(1)}><Icon name="down" size={14} /></button>
    <button type="button" aria-label="Close find" title="Close (Esc)" onClick={onClose}><Icon name="close" size={14} /></button>
  </div>;
}
