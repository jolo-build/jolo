import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useDragCleanup } from '../use-drag-cleanup.js';

// The chat's share of the width. A file beside the chat gets more room, like a split editor, so Files keeps its own share.
const DEFAULTS = { panel: 1 / 1.95, files: .4 };
const KEYS = { panel: 'jolo.contextSplit', files: 'jolo.contextSplit.files' };
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
/** @param {'panel' | 'files'} kind */
const read = kind => {
  try { const saved = JSON.parse(localStorage.getItem(KEYS[kind])); return typeof saved === 'number' && Number.isFinite(saved) ? clamp(saved, .2, .8) : DEFAULTS[kind]; }
  catch { return DEFAULTS[kind]; }
};

/**
 * Resize the conversation and its retained browser, files, or terminal panel together.
 * @param {{ enabled: boolean, kind?: 'panel' | 'files', children: import('react').ReactNode }} props
 */
export function ContextSplit({ enabled, kind = 'panel', children }) {
  const body = useRef(null);
  const drag = useRef(false);
  const [fractions, setFractions] = useState(() => ({ panel: read('panel'), files: read('files') }));
  const fraction = fractions[kind];
  const setFraction = value => setFractions(all => ({ ...all, [kind]: value }));
  const [width, setWidth] = useState(0);
  const [dragging, setDragging] = useState(false);
  const min = width > 600 ? Math.max(.2, 240 / width) : .2;
  const max = width > 600 ? Math.min(.8, 1 - 280 / width) : .8;
  const ratio = clamp(fraction, min, max);
  const resize = value => setFraction(clamp(value, min, max));
  const { capture, end: finish, enter, leave } = useDragCleanup(() => { if (!drag.current) return; drag.current = false; setDragging(false); });
  useLayoutEffect(() => {
    const element = body.current;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    setWidth(element.clientWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { try { localStorage.setItem(KEYS[kind], JSON.stringify(fraction)); } catch { /* storage unavailable */ } }, [kind, fraction]);
  useEffect(() => { if (!enabled) finish(); }, [enabled]);
  const move = event => {
    if (!drag.current) return;
    const bounds = body.current.getBoundingClientRect();
    if (bounds.width) resize((event.clientX - bounds.left) / bounds.width);
  };
  return <div ref={body} className={`pane-body${dragging ? ' context-resizing' : ''}`} style={/** @type {import('react').CSSProperties} */ ({ '--chat-size': `${ratio}fr`, '--context-size': `${1 - ratio}fr` })}>
    {children}
    {enabled && <div className="context-divider" role="separator" aria-label="Resize chat and panel" aria-orientation="vertical" aria-valuemin={Math.round(min * 100)} aria-valuemax={Math.round(max * 100)} aria-valuenow={Math.round(ratio * 100)} tabIndex={0} title="Drag to resize · Double-click to reset"
      onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); drag.current = true; setDragging(true); capture(event); }}
      onPointerEnter={enter} onPointerLeave={leave} onPointerMove={move} onPointerUp={event => { move(event); finish(); }}
      onPointerCancel={finish} onLostPointerCapture={finish} onDoubleClick={() => setFraction(DEFAULTS[kind])}
      onKeyDown={event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); resize(event.key === 'Home' ? min : event.key === 'End' ? max : ratio + (event.key === 'ArrowLeft' ? -.025 : .025)); }} />}
  </div>;
}
