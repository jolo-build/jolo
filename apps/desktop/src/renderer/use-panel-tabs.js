import { useEffect, useRef, useState } from 'react';

export function usePanelTabs(scope, dispose = null) {
  const [state, setState] = useState(/** @type {{scope: any, items: any[], activeId: string | null}} */ ({ scope, items: [], activeId: null }));
  const previous = useRef([]);
  const cleanup = useRef(dispose);
  cleanup.current = dispose;
  useEffect(() => { setState({ scope, items: [], activeId: null }); }, [scope]);
  useEffect(() => {
    for (const item of previous.current) if (!state.items.includes(item)) cleanup.current?.(item, state.items);
    previous.current = state.items;
  }, [state.items]);
  useEffect(() => () => { for (const item of previous.current) cleanup.current?.(item, []); }, []);
  // Do not briefly mount an old page or shell against a newly selected workspace.
  const visible = state.scope === scope ? state : { scope, items: [], activeId: null };
  return {
    ...visible,
    active: visible.items.find(item => item.id === visible.activeId),
    select: id => setState(value => ({ ...value, activeId: id })),
    add: item => setState(value => ({ scope, items: value.scope !== scope ? [item] : value.items.some(old => old.id === item.id) ? value.items.map(old => old.id === item.id ? item : old) : [...value.items, item], activeId: item.id })),
    update: (id, patch) => setState(value => ({ ...value, items: value.items.map(item => item.id === id ? { ...item, ...patch } : item) })),
    close: id => setState(value => {
      const index = value.items.findIndex(item => item.id === id);
      const items = value.items.filter(item => item.id !== id);
      return { ...value, items, activeId: value.activeId === id ? (items[Math.min(index, items.length - 1)]?.id ?? null) : value.activeId };
    }),
    reset: () => setState({ scope, items: [], activeId: null }),
    removeType: type => setState(value => { const items = value.items.filter(item => item.panelType !== type); return { ...value, items, activeId: items.some(item => item.id === value.activeId) ? value.activeId : items.at(-1)?.id ?? null }; }),
  };
}
