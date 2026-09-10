// Engine lifetime: stay alive while clients, active runs, or retained work exist.
export function createLifetime({ idleMs, onIdle, log }) {
  let clients = 0;
  let activeWork = 0;
  let timer = null;
  let stopped = false;
  const schedule = () => {
    if (stopped) return;
    log?.info("lifetime", { clients, activeWork, idleTimer: clients === 0 && activeWork === 0 });
    if (timer) { clearTimeout(timer); timer = null; }
    if (clients === 0 && activeWork === 0) timer = setTimeout(() => { timer = null; if (!stopped && clients === 0 && activeWork === 0) onIdle(); }, idleMs);
  };
  return {
    clientConnected() { clients += 1; schedule(); },
    clientDisconnected() { clients = Math.max(0, clients - 1); schedule(); },
    workStarted() { activeWork += 1; schedule(); },
    workFinished() { activeWork = Math.max(0, activeWork - 1); schedule(); },
    start() { schedule(); },
    stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; },
    get clients() { return clients; },
    get activeWork() { return activeWork; },
  };
}
