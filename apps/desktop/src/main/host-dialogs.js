// Browser work waits for a real host dialog to finish, within its existing lease.
// Dismissing a dialog never decides a permission; the engine owns that decision.
export class HostDialogs {
  active = false;
  listeners = new Set();

  set(active) {
    this.active = Boolean(active);
    if (!this.active) for (const clear of [...this.listeners]) clear();
  }

  wait(signal) {
    signal.throwIfAborted();
    if (!this.active) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => { this.listeners.delete(clear); signal.removeEventListener('abort', cancel); };
      const clear = () => { cleanup(); resolve(); };
      const cancel = () => { cleanup(); reject(signal.reason); };
      this.listeners.add(clear);
      signal.addEventListener('abort', cancel, { once: true });
    });
  }
}
