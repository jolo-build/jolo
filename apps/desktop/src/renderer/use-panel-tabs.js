import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { PanelTabs } from './panel-tabs.js';

export function usePanelTabs(scope, dispose = null) {
  const cleanup = useRef(dispose);
  cleanup.current = dispose;
  const [store] = useState(() => new PanelTabs((item, remaining) => cleanup.current?.(item, remaining)));
  useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  useEffect(() => () => store.clear(), [store]);
  const visible = store.get(scope);
  return {
    ...visible, scope,
    retained: [...store.scopes].flatMap(([scope, value]) => value.items.map(item => ({ scope, item }))),
    active: visible.items.find(item => item.id === visible.activeId),
    select: id => store.select(scope, id),
    add: item => store.add(scope, item),
    update: (id, patch) => store.update(scope, id, patch),
    close: id => store.close(scope, id),
    reset: () => store.reset(scope),
    removeType: type => store.removeType(scope, type),
    setContext: context => store.setContext(scope, context),
  };
}
