// Source-mode reloads are coalesced and only requested through the engine's
// atomic idle/admission gate. The shared client owns reconnect and replay.
export function createEngineUpdates({ roots, newestSourceTime, client, notice, log, now = Date.now, quietMs = 2000 }) {
  let stopped = false, checking = false, observed = null, observedAt = 0, requestedBoot = null, warnedBoot = null;
  return {
    async check() {
      if (stopped || checking) return;
      const connection = client();
      if (!connection?.connected) return;
      checking = true;
      try {
        const newest = newestSourceTime(roots);
        if (newest === null) return;
        if (newest !== observed) { observed = newest; observedAt = now(); return; }
        if (now() - observedAt < quietMs) return;
        const status = await connection.call("engine.status", {});
        if (stopped || !Number.isFinite(Date.parse(status.startedAt)) || newest <= Date.parse(status.startedAt) || requestedBoot === status.engineBootId) return;
        if (!connection.hello?.supportedMethods.includes("engine.reload")) {
          if (warnedBoot !== status.engineBootId) {
            warnedBoot = status.engineBootId;
            notice("Restart the engine once to enable automatic updates: jolo engine stop");
          }
          return;
        }
        await connection.call("engine.reload", {});
        requestedBoot = status.engineBootId;
        log.info("reloading idle engine after source update", { engineBootId: status.engineBootId });
      } catch (error) {
        // A busy engine is retried on the next tick; no work is cancelled.
        if (!["conflict", "unavailable"].includes(error.code)) log.warn("engine update check failed", { error: String(error.message ?? error) });
      } finally { checking = false; }
    },
    stop() { stopped = true; },
  };
}
