// Narrow renderer bridge: explicit operations only, no raw ipcRenderer.
const { contextBridge, ipcRenderer } = require("electron");
// Only invoke new handlers when the running main process advertises them.
const desktopApi = process.argv.includes('--jolo-desktop-api=1');

const eventListeners = new Set();
const engineListeners = new Set();
const focusListeners = new Set();
const noticeListeners = new Set();
const browserOpenListeners = new Set();
const browserCursorListeners = new Set();
const browserNewTabListeners = new Set();
const closeListeners = new Set();
const scrollGestureListeners = new Set();
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
ipcRenderer.on('jolo:closeRequest', (_event, payload) => { for (const listener of closeListeners) listener(payload); });
ipcRenderer.on('jolo:browserNewTab', (_event, payload) => { for (const listener of browserNewTabListeners) listener(payload); });
ipcRenderer.on('jolo:browserCursor', (_event, payload) => { for (const listener of browserCursorListeners) listener(payload); });
ipcRenderer.on('jolo:browserOpenCancel', (_event, { invocationId }) => browserOpens.delete(invocationId));
ipcRenderer.on('jolo:browserOpen', (_event, payload) => {
  browserOpens.add(payload.invocationId);
  Promise.resolve().then(() => {
    if (!browserOpens.has(payload.invocationId)) return;
    if (Date.now() >= payload.expiresAt) throw new Error('browser open request expired');
    const listener = browserOpenListeners.values().next().value;
    if (!listener) throw new Error('desktop workspace is not ready');
    return listener(payload);
  }).then(result => finish(undefined, undefined, result?.tabId), error => finish(String(error?.message ?? error).slice(0, 1000), error?.code));
  function finish(error, errorCode, tabId) {
    if (browserOpens.delete(payload.invocationId)) ipcRenderer.send('jolo:browserOpened', { invocationId: payload.invocationId, ...(typeof tabId === 'string' ? { tabId } : {}), ...(error ? { error } : {}), ...(errorCode === 'browser_busy' ? { errorCode } : {}) });
  }
});

ipcRenderer.on('jolo:scrollGestureBegin', () => { for (const listener of scrollGestureListeners) listener(); });

contextBridge.exposeInMainWorld("jolo", {
  platform: process.platform,
  onScrollGestureBegin: listener => { scrollGestureListeners.add(listener); return () => scrollGestureListeners.delete(listener); },
  naturalScrolling: process.argv.includes('--jolo-natural-scrolling=1'),
  homeDirectory: () => desktopApi ? ipcRenderer.invoke("jolo:homeDirectory") : Promise.resolve(null),
  prepareVisualization: desktopApi ? params => ipcRenderer.invoke('jolo:visualization:prepare', { sessionId: params.sessionId, path: params.path }) : undefined,
  releaseVisualization: url => ipcRenderer.send('jolo:visualization:release', url),
  call: (method, params) => ipcRenderer.invoke("jolo:call", { method, params: params ?? {} }),
  onEvents: (listener) => { eventListeners.add(listener); return () => eventListeners.delete(listener); },
  onEngine: (listener) => { engineListeners.add(listener); return () => engineListeners.delete(listener); },
  onFocusRequest: (listener) => { focusListeners.add(listener); return () => focusListeners.delete(listener); },
  onNotice: (listener) => { noticeListeners.add(listener); return () => noticeListeners.delete(listener); },
  onCloseRequest: listener => { closeListeners.add(listener); return () => closeListeners.delete(listener); },
  quit: () => ipcRenderer.send('jolo:quit'),
  onBrowserOpen: listener => { browserOpenListeners.add(listener); return () => browserOpenListeners.delete(listener); },
  onBrowserNewTab: listener => { browserNewTabListeners.add(listener); return () => browserNewTabListeners.delete(listener); },
  onBrowserCursor: listener => { browserCursorListeners.add(listener); return () => browserCursorListeners.delete(listener); },
  setBrowserWorkspaces: workspaceIds => ipcRenderer.send('jolo:browserWorkspaces', { workspaceIds }),
  openFolder: () => ipcRenderer.invoke("jolo:dialog:openFolder"),
  answererMenu: (options) => ipcRenderer.invoke("jolo:answererMenu", { items: (options?.items ?? []).map((item) => ({ id: String(item.id), label: String(item.label), checked: Boolean(item.checked), enabled: item.enabled !== false })) }),
  taskMenu: (options) => ipcRenderer.invoke("jolo:taskMenu", typeof options === "boolean" ? { archived: options } : { archived: Boolean(options?.archived), worktree: Boolean(options?.worktree) }),
  fileApplications: params => ipcRenderer.invoke('jolo:fileApplications', { sessionId: params.sessionId, projectId: params.projectId, workspaceId: params.workspaceId, path: params.path, nativePath: true }),
  fileApplicationAction: params => ipcRenderer.invoke('jolo:fileApplicationAction', { sessionId: params.sessionId, projectId: params.projectId, workspaceId: params.workspaceId, path: params.path, nativePath: true, action: params.action, application: params.application }),
  openChatFile: (params) => ipcRenderer.invoke('jolo:openChatFile', { sessionId: params.sessionId, projectId: params.projectId, workspaceId: params.workspaceId, path: params.path, urlEncoded: params.urlEncoded, nativePath: params.nativePath === true, action: params.action === 'reveal' ? 'reveal' : 'open' }),
  previewChatFile: (params) => ipcRenderer.invoke('jolo:previewChatFile', { sessionId: params.sessionId, projectId: params.projectId, workspaceId: params.workspaceId, path: params.path, urlEncoded: params.urlEncoded }),
  listChatFiles: desktopApi ? (params) => ipcRenderer.invoke('jolo:listChatFiles', { sessionId: params.sessionId, projectId: params.projectId, workspaceId: params.workspaceId, path: params.path ?? '' }) : undefined,
  pickChatFile: (params) => ipcRenderer.invoke('jolo:pickChatFile', { sessionId: params.sessionId, projectId: params.projectId, workspaceId: params.workspaceId }),
  releaseChatFile: (url) => ipcRenderer.invoke('jolo:releaseChatFile', url),
  saveImage: params => ipcRenderer.invoke('jolo:image:save', { artifactId: params.artifactId, name: params.name }),
  openExternal: (url) => ipcRenderer.invoke("jolo:openExternal", url),
  checkForUpdate: desktopApi ? (options) => ipcRenderer.invoke("jolo:update:check", { force: Boolean(options?.force) }) : undefined,
  resync: () => ipcRenderer.invoke("jolo:resync"),
  setOverlay: (active) => ipcRenderer.send("jolo:overlay", Boolean(active)),
  smoke: process.env.JOLO_DESKTOP_SMOKE === "1",
});
