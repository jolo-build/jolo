import { useEffect, useLayoutEffect, useRef, useState } from 'react';

const DEFAULT = 1 / 1.95;
const KEY = 'jolo.contextSplit';
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const read = () => {
  try { const saved = JSON.parse(localStorage.getItem(KEY)); return typeof saved === 'number' && Number.isFinite(saved) ? clamp(saved, .2, .8) : DEFAULT; }
  catch { return DEFAULT; }
};

/** Resize the conversation and its retained browser, files, or terminal panel together. */
export function ContextSplit({ enabled, children }) {
  const body = useRef(null);
  const drag = useRef(false);
  const [fraction, setFraction] = useState(read);
  const [width, setWidth] = useState(0);
  const [dragging, setDragging] = useState(false);
  const min = width > 600 ? Math.max(.2, 240 / width) : .2;
  const max = width > 600 ? Math.min(.8, 1 - 280 / width) : .8;
  const ratio = clamp(fraction, min, max);
  const resize = value => setFraction(clamp(value, min, max));
  const finish = () => { drag.current = false; setDragging(false); };
  useLayoutEffect(() => {
    const element = body.current;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    setWidth(element.clientWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify(fraction)); } catch { /* storage unavailable */ } }, [fraction]);
  useEffect(() => { window.addEventListener('blur', finish); return () => window.removeEventListener('blur', finish); }, []);
  useEffect(() => { if (!enabled) finish(); }, [enabled]);
  const move = event => {
    if (!drag.current) return;
    const bounds = body.current.getBoundingClientRect();
    if (bounds.width) resize((event.clientX - bounds.left) / bounds.width);
  };
  return <div ref={body} className={`pane-body${dragging ? ' context-resizing' : ''}`} style={/** @type {import('react').CSSProperties} */ ({ '--chat-size': `${ratio}fr`, '--context-size': `${1 - ratio}fr` })}>
    {children}
    {enabled && <div className="context-divider" role="separator" aria-label="Resize chat and panel" aria-orientation="vertical" aria-valuemin={Math.round(min * 100)} aria-valuemax={Math.round(max * 100)} aria-valuenow={Math.round(ratio * 100)} tabIndex={0} title="Drag to resize · Double-click to reset"
      onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); drag.current = true; setDragging(true); event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={move} onPointerUp={event => { move(event); finish(); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
      onPointerCancel={finish} onLostPointerCapture={finish} onDoubleClick={() => setFraction(DEFAULT)}
      onKeyDown={event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); resize(event.key === 'Home' ? min : event.key === 'End' ? max : ratio + (event.key === 'ArrowLeft' ? -.025 : .025)); }} />}
  </div>;
}
