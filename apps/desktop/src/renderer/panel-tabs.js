const empty = () => ({ items: [], activeId: null, context: null });

// Updates capture their originating conversation so late page titles or file
// responses cannot change the conversation now on screen.
export class PanelTabs {
  constructor(dispose = null) {
    this.scopes = new Map();
    this.dispose = dispose;
    this.revision = 0;
    this.listeners = new Set();
  }
  get(scope) { return this.scopes.get(scope) ?? empty(); }
  subscribe = listener => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  snapshot = () => this.revision;
  change(scope, update) {
    const previous = this.get(scope);
    const next = update(previous);
    this.scopes.set(scope, next);
    const retained = [...this.scopes.values()].flatMap(value => value.items);
    for (const item of previous.items) if (!next.items.includes(item)) this.dispose?.(item, retained);
    this.revision++;
    for (const listener of this.listeners) listener();
  }
  add(scope, item) { this.change(scope, value => ({ ...value, items: value.items.some(old => old.id === item.id) ? value.items.map(old => old.id === item.id ? item : old) : [...value.items, item], activeId: item.id })); }
  update(scope, id, patch) { this.change(scope, value => ({ ...value, items: value.items.map(item => item.id === id ? { ...item, ...patch } : item) })); }
  select(scope, id) { this.change(scope, value => ({ ...value, activeId: value.items.some(item => item.id === id) ? id : value.activeId })); }
  setContext(scope, context) { this.change(scope, value => ({ ...value, context })); }
  close(scope, id) {
    this.change(scope, value => {
      const index = value.items.findIndex(item => item.id === id);
      const items = value.items.filter(item => item.id !== id);
      return { ...value, items, activeId: value.activeId === id ? (items[Math.min(index, items.length - 1)]?.id ?? null) : value.activeId };
    });
  }
  removeType(scope, type) { this.change(scope, value => { const items = value.items.filter(item => item.panelType !== type); return { ...value, items, activeId: items.some(item => item.id === value.activeId) ? value.activeId : items.at(-1)?.id ?? null }; }); }
  reset(scope) { this.change(scope, empty); }
  clear() {
    const items = [...this.scopes.values()].flatMap(value => value.items);
    this.scopes.clear();
    for (const item of items) this.dispose?.(item, []);
  }
}
