import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './icon.jsx';

/** An editable model choice: advertised options help discovery, custom values stay valid. */
export function Combobox({ label, value, onChange, options = [], disabled = false, allowDefault = true, placeholder = "Default" }) {
  const id = useId();
  const field = useRef(null), input = useRef(null), popup = useRef(null);
  const [open, setOpen] = useState(false), [filter, setFilter] = useState(''), [active, setActive] = useState(0);
  const [position, setPosition] = useState({});
  const choices = [...(allowDefault ? [{ value: '', label: 'Default' }] : []), ...options.filter(option => option.value)];
  const matches = choices.filter(option => `${option.label} ${option.value}`.toLowerCase().includes(filter.toLowerCase()));
  const selected = Math.min(active, Math.max(0, matches.length - 1));
  const choose = (option) => { onChange(option.value); setOpen(false); input.current?.focus(); };
  const show = () => { setFilter(''); setActive(Math.max(0, choices.findIndex(option => option.value === value))); setOpen(true); };

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const box = field.current.getBoundingClientRect();
      const below = innerHeight - box.bottom - 12, above = box.top - 12;
      const upward = below < 180 && above > below;
      const width = Math.min(Math.max(box.width, 210), innerWidth - 24);
      setPosition({ left: Math.max(12, Math.min(box.left, innerWidth - width - 12)), width, maxHeight: Math.max(60, Math.min(250, upward ? above : below)), ...(upward ? { bottom: innerHeight - box.top + 5 } : { top: box.bottom + 5 }) });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = event => { if (!field.current?.contains(event.target) && !popup.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  useEffect(() => { popup.current?.querySelector('[data-active=true]')?.scrollIntoView({ block: 'nearest' }); }, [selected, open]);

  return <span className="combobox" ref={field}>
    <input ref={input} role="combobox" aria-label={label} aria-expanded={open} aria-controls={open ? id : undefined} aria-autocomplete="list" aria-activedescendant={open && matches.length ? `${id}-${selected}` : undefined}
      value={value} placeholder={placeholder} disabled={disabled} autoComplete="off" spellCheck={false}
      onChange={event => { onChange(event.target.value); setFilter(event.target.value); setActive(0); setOpen(true); }}
      onBlur={event => { if (!field.current?.contains(event.relatedTarget) && !popup.current?.contains(event.relatedTarget)) setOpen(false); }}
      onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          if (!open) show();
          else setActive((selected + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % Math.max(1, matches.length));
        } else if (open && event.key === 'Enter' && matches.length) { event.preventDefault(); choose(matches[selected]); }
        else if (open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); }
        else if (event.key === 'Tab') setOpen(false);
      }} />
    <button type="button" tabIndex={-1} aria-label={`Choose ${label.toLowerCase()}`} disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={() => { input.current?.focus(); if (open) setOpen(false); else show(); }}><Icon name="down" size={14} /></button>
    {open && createPortal(<div ref={popup} id={id} role="listbox" aria-label={label} className="combobox-options" style={position}>
      {matches.map((option, index) => <button type="button" key={option.value} id={`${id}-${index}`} role="option" aria-selected={option.value === value} data-active={index === selected} data-value={option.value} tabIndex={-1}
        onMouseDown={event => event.preventDefault()} onPointerMove={() => setActive(index)} onClick={() => choose(option)}>
        <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>{option.value === value && <Icon name="check" size={14} />}
      </button>)}
      {!matches.length && <div className="combobox-empty">Use “{value}” as a custom value.</div>}
    </div>, document.body)}
  </span>;
}
