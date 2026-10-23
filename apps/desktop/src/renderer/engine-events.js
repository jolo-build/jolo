// One relay consumer partitions high-volume previews and activity ticks by session before
// notifying panes. Durable project/session changes remain broadcast for sidebar refreshes.
const panes = new Set();
let disconnect = null;
const perSession = item => item.kind === 'preview' || item.kind === 'activity';
export function subscribePaneEvents(session, receive) {
  const pane = { session, receive }; panes.add(pane);
  if (!disconnect) disconnect = window.jolo.onEvents((items, meta) => {
    const durable = [], scoped = new Map();
    for (const item of items) {
      if (!perSession(item)) durable.push(item);
      else { const id = item.value.sessionId; if (!scoped.has(id)) scoped.set(id, []); scoped.get(id).push(item); }
    }
    for (const pane of panes) {
      const selected = scoped.get(pane.session());
      // Retain the original ordering of events and per-session items when both are present.
      const batch = selected ? items.filter(item => !perSession(item) || item.value.sessionId === pane.session()) : durable;
      if (batch.length || meta?.resyncRequired) pane.receive(batch, meta);
    }
  });
  return () => { panes.delete(pane); if (!panes.size) { disconnect?.(); disconnect = null; } };
}
