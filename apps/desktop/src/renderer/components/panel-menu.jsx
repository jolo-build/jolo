import { useEffect, useId, useRef, useState } from 'react';
import { Icon } from './icon.jsx';

export const CONTEXT_PANELS = [
  ['changes', 'Changes', 'changes'], ['browser', 'Browser', 'browser'], ['files', 'Files', 'file'],
  ['terminal', 'Terminal', 'terminal'], ['plans', 'Plans', 'plan'], ['checks', 'Checks', 'circleCheck'],
];

export function PanelMenu({ selected, panels, disabled, details, onSelect, onHide, onOpenChange }) {
  const trigger = useRef(null), menu = useRef(null);
  const menuId = useId();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const element = menu.current;
    const changed = () => {
      const shown = element.matches(':popover-open');
      setOpen(shown); onOpenChange(shown);
      if (shown) (element.querySelector('[aria-checked=true]') ?? element.querySelector('[role=menuitemradio]'))?.focus();
    };
    const close = () => element.hidePopover();
    element.addEventListener('toggle', changed);
    window.addEventListener('resize', close);
    return () => { element.removeEventListener('toggle', changed); window.removeEventListener('resize', close); onOpenChange(false); };
  }, [onOpenChange]);
  const dismiss = () => { menu.current.hidePopover(); trigger.current.focus(); };
  return <>
    {/* The native invoker toggles without light-dismiss reopening the menu on a second click. */}
    <button ref={trigger} className={selected ? 'active' : ''} aria-label="Panels" title="Panels" aria-haspopup="menu" aria-expanded={open} popoverTarget={menuId} disabled={disabled} onClick={() => {
      const rect = trigger.current.getBoundingClientRect();
      menu.current.style.top = `${rect.bottom + 6}px`;
      menu.current.style.left = `${Math.max(8, Math.min(innerWidth - 252, rect.right - 244))}px`;
    }}><Icon name="sidebarRight" /><span className="header-action-label">Panels</span><Icon name="down" size={12} /></button>
    <div ref={menu} id={menuId} className="panel-menu" popover="auto" role="menu" aria-label="Panels" onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(); return; }
      if (event.key === 'Tab') { menu.current.hidePopover(); return; }
      const items = [...event.currentTarget.querySelectorAll('button')];
      const index = items.findIndex(item => item === document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowDown' ? (index + 1) % items.length : event.key === 'ArrowUp' ? (index - 1 + items.length) % items.length : -1;
      if (next >= 0) { event.preventDefault(); items[next].focus(); }
    }}>
      {panels.map(([id, label, icon]) => <button key={id} role="menuitemradio" aria-label={label} aria-checked={selected === id} tabIndex={-1} onClick={() => { dismiss(); onSelect(id); }}>
        <Icon name={icon} size={16} /><span>{label}</span>{details[id] && <small>{details[id]}</small>}{selected === id && <Icon name="check" size={14} />}
      </button>)}
      {selected && <><hr /><button role="menuitem" tabIndex={-1} onClick={() => { dismiss(); onHide(); }}><Icon name="close" size={16} /><span>Hide panel</span></button></>}
    </div>
  </>;
}
