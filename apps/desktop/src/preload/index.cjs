// Narrow renderer bridge: explicit operations only, no raw ipcRenderer.
const { contextBridge, ipcRenderer } = require("electron");

const eventListeners = new Set();
const engineListeners = new Set();
const focusListeners = new Set();
const noticeListeners = new Set();
const browserOpenListeners = new Set();
const browserOpens = new Set();

ipcRenderer.on("jolo:events", (_event, batch) => {
  for (const listener of eventListeners) {
    try { listener(batch.items, { resyncRequired: batch.resyncRequired, previewsDropped: batch.previewsDropped, terminalDropped: batch.terminalDropped }); } catch { /* renderer bug must not break the relay */ }
  }
  ipcRenderer.send("jolo:ack", batch.id); // credit returned only after the renderer consumed the batch (§4.1)
});
ipcRenderer.on("jolo:engine", (_event, state) => { for (const listener of engineListeners) listener(state); });
ipcRenderer.on("jolo:focus", (_event, payload) => { for (const listener of focusListeners) listener(payload); }); // a notification was clicked
ipcRenderer.on("jolo:notice", (_event, payload) => { for (const listener of noticeListeners) listener(payload); }); // news for a window the user is looking at
ipcRenderer.on('jolo:browserOpenCancel', (_event, { invocationId }) => browserOpens.delete(invocationId));
ipcRenderer.on('jolo:browserOpen', (_event, payload) => {
  browserOpens.add(payload.invocationId);
  Promise.resolve().then(() => {
    if (!browserOpens.has(payload.invocationId)) return;
    if (Date.now() >= payload.expiresAt) throw new Error('browser open request expired');
    const listener = browserOpenListeners.values().next().value;
    if (!listener) throw new Error('desktop workspace is not ready');
    return listener(payload);
  }).then(() => finish(), error => finish(String(error?.message ?? error).slice(0, 1000), error?.code));
  function finish(error, errorCode) {
    if (browserOpens.delete(payload.invocationId)) ipcRenderer.send('jolo:browserOpened', { invocationId: payload.invocationId, ...(error ? { error } : {}), ...(errorCode === 'browser_busy' ? { errorCode } : {}) });
  }
});

contextBridge.exposeInMainWorld("jolo", {
  platform: process.platform,
  call: (method, params) => ipcRenderer.invoke("jolo:call", { method, params: params ?? {} }),
  onEvents: (listener) => { eventListeners.add(listener); return () => eventListeners.delete(listener); },
  onEngine: (listener) => { engineListeners.add(listener); return () => engineListeners.delete(listener); },
  onFocusRequest: (listener) => { focusListeners.add(listener); return () => focusListeners.delete(listener); },
  onNotice: (listener) => { noticeListeners.add(listener); return () => noticeListeners.delete(listener); },
  onBrowserOpen: listener => { browserOpenListeners.add(listener); return () => browserOpenListeners.delete(listener); },
  setBrowserWorkspaces: workspaceIds => ipcRenderer.send('jolo:browserWorkspaces', { workspaceIds }),
  openFolder: () => ipcRenderer.invoke("jolo:dialog:openFolder"),
  answererMenu: (options) => ipcRenderer.invoke("jolo:answererMenu", { items: (options?.items ?? []).map((item) => ({ id: String(item.id), label: String(item.label), checked: Boolean(item.checked), enabled: item.enabled !== false })) }),
  taskMenu: (options) => ipcRenderer.invoke("jolo:taskMenu", typeof options === "boolean" ? { archived: options } : { archived: Boolean(options?.archived), worktree: Boolean(options?.worktree) }),
  openExternal: (url) => ipcRenderer.invoke("jolo:openExternal", url),
  resync: () => ipcRenderer.invoke("jolo:resync"),
  setOverlay: (active) => ipcRenderer.send("jolo:overlay", Boolean(active)),
  smoke: process.env.JOLO_DESKTOP_SMOKE === "1",
});
