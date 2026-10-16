// A chat tool can request a visible, blank inline tab. Only the trusted renderer
// chooses a workspace pane; the result waits for the guest's host registration.
import { BrowserOpenSchema, BrowserOpenerSchema } from '@jolo/protocol';

/**
 * One open request while its guest attaches. The lease timer is hung on the entry a moment after it is
 * made, which is why it is optional here, and `acknowledged` turns true when the renderer reports the pane.
 * @typedef {{ invocationId: string, workspaceId: string, sessionId?: string, tabId?: string, leaseMs: number, expiresAt: number, controller: AbortController, acknowledged: boolean, timer?: ReturnType<typeof setTimeout> }} PendingOpen
 */

export function createBrowserOpener({ bridge, agent, send, isOverlayActive, waitForOverlay = null, log, retryMs = 500 }) {
  let workspaceIds = [];
  let publishing = Promise.resolve();
  let retryTimer = null;
  const pending = new Map();
  const publish = () => {
    const ids = workspaceIds;
    publishing = publishing.catch(() => {}).then(() => bridge.rawCall('browser.setOpener', { workspaceIds: ids }));
    return publishing;
  };
  const publishInBackground = () => {
    clearTimeout(retryTimer); retryTimer = null;
    return publish().catch(error => {
      log.warn('browser opener registration failed', { error: String(error?.message ?? error) });
      // A transient rejection must not leave a visible chat without an opener
      // until its workspace changes or the user restarts the whole app.
      if (workspaceIds.length && bridge.client && !bridge.client.closed && bridge.client.connected !== false && !retryTimer) {
        retryTimer = setTimeout(() => { retryTimer = null; void publishInBackground(); }, retryMs);
        retryTimer.unref?.();
      }
    });
  };
  const finish = (entry, result, reply = true) => {
    if (!pending.delete(entry.invocationId)) return;
    clearTimeout(entry.timer);
    entry.controller.abort();
    send('jolo:browserOpenCancel', { invocationId: entry.invocationId });
    if (reply) void bridge.rawCall('browser.openResult', { invocationId: entry.invocationId, ...result }).catch(error => log.warn('browser open result failed', { error: String(error?.message ?? error) }));
  };
  const ready = entry => {
    if (!entry.acknowledged) return;
    const hosts = [...agent.hosts.values()].filter(host => host.workspaceId === entry.workspaceId && (!entry.tabId || host.tabId === entry.tabId) && !host.guest.isDestroyed());
    const host = hosts.find(host => host.capabilityId);
    if (host) finish(entry, { capabilityId: host.capabilityId });
    else if (hosts.length && hosts.every(host => host.registrationError)) finish(entry, { error: hosts[0].registrationError });
  };
  agent.onRegistered(() => { for (const entry of pending.values()) ready(entry); });
  agent.onRegistrationFailed?.(() => { for (const entry of pending.values()) ready(entry); });
  const open = (entry) => {
    if (!pending.has(entry.invocationId)) return;
    if (!workspaceIds.includes(entry.workspaceId)) return finish(entry, { error: 'open this workspace in Jolo desktop to use its inline browser' });
    // Each workspace has its own guest and capability. Another workspace's retained
    // page must neither block this request nor be closed to satisfy it.
    if (isOverlayActive()) {
      if (!waitForOverlay) return finish(entry, { error: 'a host dialog is open; browser opening is suspended' });
      void waitForOverlay(entry.controller.signal).then(() => open(entry)).catch(() => {});
      return;
    }
    agent.retryRegistration?.(entry.workspaceId);
    send('jolo:browserOpen', { invocationId: entry.invocationId, workspaceId: entry.workspaceId, ...(entry.sessionId ? { sessionId: entry.sessionId } : {}), expiresAt: entry.expiresAt });
  };
  return {
    setWorkspaces(params) {
      const checked = BrowserOpenerSchema.safeParse(params);
      if (!checked.success) return;
      workspaceIds = [...new Set(checked.data.workspaceIds)];
      for (const entry of pending.values()) if (!workspaceIds.includes(entry.workspaceId)) finish(entry, { error: 'workspace pane closed while opening the browser' });
      if (bridge.client && !bridge.client.closed) void publishInBackground();
    },
    onConnected: publishInBackground,
    // Do not admit a run with a failed or stale pane registration. A pane can
    // change while its previous publication is still waiting on the socket.
    async beforeRun() {
      let ids;
      do { ids = workspaceIds; await publish(); } while (ids !== workspaceIds);
    },
    onDisconnected() { clearTimeout(retryTimer); retryTimer = null; for (const entry of pending.values()) finish(entry, {}, false); },
    handleOpen(params) {
      const checked = BrowserOpenSchema.safeParse(params);
      if (!checked.success || pending.has(params.invocationId)) return;
      /** @type {PendingOpen} */
      const entry = { ...checked.data, expiresAt: Date.now() + checked.data.leaseMs, controller: new AbortController(), acknowledged: false };
      entry.timer = setTimeout(() => finish(entry, { error: isOverlayActive() ? 'browser opening timed out while waiting for a host approval dialog to close' : 'inline browser did not attach within the lease' }), entry.leaseMs);
      pending.set(entry.invocationId, entry);
      open(entry);
    },
    acknowledge(params) {
      const entry = pending.get(params?.invocationId);
      if (!entry) return;
      if (typeof params.error === 'string') return finish(entry, { error: params.error.slice(0, 1000), ...(params.errorCode === 'browser_busy' ? { errorCode: params.errorCode } : {}) });
      if (entry.sessionId && typeof params.tabId !== 'string') return finish(entry, { error: 'The desktop did not identify the browser tab for this chat; restart Jolo to update it.' });
      entry.tabId = typeof params.tabId === 'string' ? params.tabId : undefined;
      entry.acknowledged = true;
      ready(entry);
    },
    handleCancel({ invocationId }) { const entry = pending.get(invocationId); if (entry) finish(entry, {}, false); },
  };
}
