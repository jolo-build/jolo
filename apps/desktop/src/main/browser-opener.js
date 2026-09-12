// A chat tool can request a visible, blank inline tab. Only the trusted renderer
// chooses a workspace pane; the result waits for the guest's host registration.
import { BrowserOpenSchema, BrowserOpenerSchema } from '@jolo/protocol';

/**
 * One open request while its guest attaches. The lease timer is hung on the entry a moment after it is
 * made, which is why it is optional here, and `acknowledged` turns true when the renderer reports the pane.
 * @typedef {{ invocationId: string, workspaceId: string, leaseMs: number, expiresAt: number, controller: AbortController, acknowledged: boolean, timer?: ReturnType<typeof setTimeout> }} PendingOpen
 */

export function createBrowserOpener({ bridge, agent, send, isOverlayActive, waitForOverlay = null, log }) {
  let workspaceIds = [];
  let publishing = Promise.resolve();
  const pending = new Map();
  const publish = () => {
    const ids = workspaceIds;
    publishing = publishing.catch(() => {}).then(() => bridge.rawCall('browser.setOpener', { workspaceIds: ids }));
    return publishing.catch(error => log.warn('browser opener registration failed', { error: String(error?.message ?? error) }));
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
    const host = [...agent.hosts.values()].find(host => host.workspaceId === entry.workspaceId && host.capabilityId && !host.guest.isDestroyed());
    if (host) finish(entry, { capabilityId: host.capabilityId });
  };
  agent.onRegistered(() => { for (const entry of pending.values()) ready(entry); });
  const open = (entry) => {
    if (!pending.has(entry.invocationId)) return;
    if (!workspaceIds.includes(entry.workspaceId)) return finish(entry, { error: 'open this workspace in Jolo desktop to use its inline browser' });
    // Reserve the browser while waiting for approval and while its guest attaches.
    if ([...pending.values()].some(other => other.workspaceId !== entry.workspaceId)
      || [...agent.hosts.values()].some(host => host.workspaceId !== entry.workspaceId && !host.guest.isDestroyed())) {
      return finish(entry, { errorCode: 'browser_busy', error: 'the inline browser is open or opening in another workspace; its page has been left untouched' });
    }
    if (isOverlayActive()) {
      if (!waitForOverlay) return finish(entry, { error: 'a host dialog is open; browser opening is suspended' });
      void waitForOverlay(entry.controller.signal).then(() => open(entry)).catch(() => {});
      return;
    }
    send('jolo:browserOpen', { invocationId: entry.invocationId, workspaceId: entry.workspaceId, expiresAt: entry.expiresAt });
  };
  return {
    setWorkspaces(params) {
      const checked = BrowserOpenerSchema.safeParse(params);
      if (!checked.success) return;
      workspaceIds = [...new Set(checked.data.workspaceIds)];
      for (const entry of pending.values()) if (!workspaceIds.includes(entry.workspaceId)) finish(entry, { error: 'workspace pane closed while opening the browser' });
      if (bridge.client && !bridge.client.closed) void publish();
    },
    onConnected: publish,
    // Runs sample browser availability once when their hosted process starts.
    // Publish the pane list before admission, including after a fast pane switch.
    beforeRun: publish,
    onDisconnected() { for (const entry of pending.values()) finish(entry, {}, false); },
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
      entry.acknowledged = true;
      ready(entry);
    },
    handleCancel({ invocationId }) { const entry = pending.get(invocationId); if (entry) finish(entry, {}, false); },
  };
}
