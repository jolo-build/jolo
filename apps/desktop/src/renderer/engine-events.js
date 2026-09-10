// One relay consumer partitions high-volume previews by session before notifying
// panes. Durable project/session changes remain broadcast for sidebar refreshes.
const panes = new Set();
let disconnect = null;
export function subscribePaneEvents(session, receive) {
  const pane = { session, receive }; panes.add(pane);
  if (!disconnect) disconnect = window.jolo.onEvents((items, meta) => {
    const durable = [], previews = new Map();
    for (const item of items) {
      if (item.kind !== 'preview') durable.push(item);
      else { const id = item.value.sessionId; if (!previews.has(id)) previews.set(id, []); previews.get(id).push(item); }
    }
    for (const pane of panes) {
      const selected = previews.get(pane.session());
      // Retain original event/preview ordering when both are present.
      const batch = selected ? items.filter(item => item.kind !== 'preview' || item.value.sessionId === pane.session()) : durable;
      if (batch.length || meta?.resyncRequired) pane.receive(batch, meta);
    }
  });
  return () => { panes.delete(pane); if (!panes.size) { disconnect?.(); disconnect = null; } };
}
