// Opening is acknowledged only after the requested chat's guest is attached.
export class BrowserTabAttachments {
  constructor() { this.tabs = new Map(); this.waiters = new Map(); }
  ready(id, guestId) {
    if (guestId === null) { this.tabs.delete(id); return; }
    const result = { tabId: `tab_${guestId}` };
    this.tabs.set(id, result);
    for (const resolve of this.waiters.get(id) ?? []) resolve(result);
  }
  wait(id, expiresAt) {
    if (this.tabs.has(id)) return Promise.resolve(this.tabs.get(id));
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); const entries = this.waiters.get(id); entries?.delete(done); if (!entries?.size) this.waiters.delete(id); };
      const done = result => { cleanup(); resolve(result); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('The requested chat’s browser did not attach before the request expired')); }, Math.max(0, expiresAt - Date.now()));
      if (!this.waiters.has(id)) this.waiters.set(id, new Set());
      this.waiters.get(id).add(done);
    });
  }
}
