import { Icon } from './icon.jsx';
import { useEffect, useRef } from 'react';

export function PanelItemTabs({ label, tabs, activeId, onSelect, onClose, newControl, paneId }) {
  const list = useRef(null);
  useEffect(() => { list.current?.querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [activeId]);
  return <div className="panel-item-bar">
    <div ref={list} className="panel-item-tabs" role="tablist" aria-label={label} onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const buttons = /** @type {HTMLButtonElement[]} */ ([...event.currentTarget.querySelectorAll('[role=tab]')]);
      const index = buttons.findIndex(button => button === document.activeElement);
      if (index < 0) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.click(); buttons[next]?.focus();
    }}>
      {tabs.map(tab => <div className="panel-item-tab" key={tab.id} data-active={tab.id === activeId}>
        <button id={`${paneId}-item-${encodeURIComponent(tab.id)}`} role="tab" aria-label={tab.title} aria-controls={`${paneId}-context-content`} data-panel-type={tab.panelType} aria-selected={tab.id === activeId} tabIndex={tab.id === activeId ? 0 : -1} title={tab.path || tab.url || tab.title} onClick={() => onSelect(tab.id)}><Icon name={tab.icon || 'file'} size={13} /><span>{tab.title}</span></button>
        {tab.closable !== false && <button className="panel-item-close" aria-label={`Close ${tab.title}`} title={`Close ${tab.title}`} onClick={() => onClose(tab.id)}><Icon name="close" size={12} /></button>}
      </div>)}
    </div>
    {newControl}
  </div>;
}
