// Shows the reply to a web prompt as the device writes it, and reloads the page when the
// prompt's status or the request it waits on changes, so the server-rendered state (approval,
// result) takes over. Text is set with textContent only. Without this script, the page refreshes itself.
(() => {
  const panes = [...document.querySelectorAll('[data-live]')];
  if (!panes.length) return;
  const poll = async pane => {
    try {
      const response = await fetch(pane.dataset.live, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (response.ok) {
        const { status, permission, text } = await response.json();
        if (status !== pane.dataset.status || (permission ?? '') !== pane.dataset.permission) { location.reload(); return; }
        if (text) { pane.hidden = false; pane.textContent = text; }
      }
    } catch { /* offline for a moment */ }
    // A failed poll, or a server error, is retried; only a reload ends polling.
    setTimeout(() => poll(pane), 1500);
  };
  for (const pane of panes) void poll(pane);
})();
