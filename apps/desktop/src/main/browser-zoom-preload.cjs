// Sandboxed, isolated guest input bridge. No API is exposed to page scripts.
const { ipcRenderer } = require('electron');
window.addEventListener('wheel', event => {
  if (!event.isTrusted || !(event.ctrlKey || event.metaKey) || !event.deltaY) return;
  event.preventDefault();
  ipcRenderer.send('jolo:browser:wheel-zoom', event.deltaY < 0 ? 'in' : 'out');
}, { passive: false, capture: true });
