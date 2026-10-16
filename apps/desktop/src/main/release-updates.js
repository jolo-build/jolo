// Watches this project's GitHub releases for a newer desktop build.
//
// Distinct from engine-updates.js, which reloads a source-run engine during development.
// This module is about the shipped application, and it runs only in a packaged build.
//
// Explicit in-app updates use the same verified archives as first installs. The installer stages
// the replacement while Jolo runs; a detached helper swaps it only after the user asks to restart.
import { RELEASE_BASE_URL, VERSION_PATTERN, checkForUpdate } from "@jolo/updates";
import { createUpdateCache } from "@jolo/updates/cache";

const HOUR_MS = 60 * 60 * 1000;
const releasePage = (version) => `${RELEASE_BASE_URL}/releases/tag/v${version}`;

/**
 * @param {{ currentVersion: string, cacheFile: string, notice: (update: { latest: string, releaseUrl: string }) => void,
 *   log: { info: Function, warn: Function }, fetchImpl?: typeof fetch, now?: () => number,
 *   platform?: string, arch?: string, baseUrl?: string, intervalMs?: number,
 *   installer?: ReturnType<typeof import('./desktop-installer.js').createDesktopInstaller>,
 *   changed?: (state: any) => void }} options
 */
export function createReleaseUpdates({ currentVersion, cacheFile, notice, log, fetchImpl = fetch, now = Date.now, platform = process.platform, arch = process.arch, baseUrl, intervalMs = 6 * HOUR_MS, installer, changed = () => {} }) {
  const cache = createUpdateCache({ file: cacheFile, now });
  let stopped = false, inflight = null, announced = null, first = null, repeat = null;
  let downloadInflight = null, installInflight = null, prepared = null;
  let installation = { status: 'idle', error: installer?.previousError() };
  /** @type {Omit<Awaited<ReturnType<typeof checkForUpdate>>, 'releaseUrl'> & { releaseUrl?: string, checked: boolean, error?: string }} */
  let lastResult = recorded();
  const snapshot = (result = lastResult) => installer ? { ...result, installable: true, ...installation, error: installation.error ?? result.error } : result;
  const publish = (fields) => { installation = { ...installation, ...fields }; const state = snapshot(); if (!stopped) changed(state); return state; };

  /** What the last check found, trusted only when it was made about this very build. */
  function recorded() {
    const entry = cache.read();
    const latest = entry?.current === currentVersion && VERSION_PATTERN.test(entry.latest ?? "") ? entry.latest : currentVersion;
    const available = Boolean(entry?.available) && latest !== currentVersion;
    return { current: currentVersion, latest, available, ...(available ? { releaseUrl: releasePage(latest) } : {}), checked: false };
  }

  /** Once per release per application launch: a relaunch is reminded, a repeated check is not. */
  function announce(result) {
    if (!result.available || announced === result.latest) return;
    announced = result.latest;
    log.info("desktop release available", { current: result.current, latest: result.latest });
    notice({ latest: result.latest, releaseUrl: result.releaseUrl });
  }

  /**
   * @param {{ force?: boolean }} [options] force ignores the once-a-day rate limit, for a check the user asked for.
   * @returns {Promise<{ current: string, latest: string, available: boolean, releaseUrl?: string, checked: boolean, error?: string }>}
   */
  async function check({ force = false } = {}) {
    if (stopped) return snapshot(recorded());
    if (inflight) return inflight; // a second caller gets the answer already on its way, not an older one
    if (!force && !cache.due()) {
      const result = recorded();
      announce(result);
      lastResult = result;
      return snapshot(result);
    }
    inflight = (async () => {
      try {
        // The desktop archive's checksum is read too, so a release that published only the CLI
        // for this platform is never announced as a desktop update.
        const result = await checkForUpdate({ current: currentVersion, product: "desktop", platform, arch, baseUrl, fetchImpl });
        cache.record(result);
        lastResult = { ...result, checked: true };
        announce(result);
        return snapshot();
      } catch (error) {
        cache.record({ failed: true });
        // Being offline, behind a proxy, or ahead of the published release are all ordinary.
        log.warn("release update check failed", { error: String(error?.message ?? error) });
        lastResult = { current: currentVersion, latest: currentVersion, available: false, checked: true, error: String(error?.message ?? error) };
        return snapshot();
      } finally { inflight = null; }
    })();
    return inflight;
  }

  return {
    check,
    download() {
      if (downloadInflight) return downloadInflight;
      if (prepared || installInflight) return Promise.resolve(snapshot());
      if (stopped || !installer) return Promise.reject(new Error('This installation cannot update itself.'));
      publish({ status: 'downloading', error: undefined, received: 0, total: null });
      downloadInflight = (async () => {
        try {
          const release = await check({ force: true });
          if (release.error) throw new Error(release.error);
          if (!release.available) return publish({ status: 'idle' });
          let progressAt = -Infinity;
          prepared = await installer.prepare(release, (received, total) => {
            if (now() - progressAt >= 250 || received === total) { progressAt = now(); publish({ received, total }); }
          });
          if (stopped) { installer.discard(prepared); prepared = null; return snapshot(); }
          return publish({ status: 'ready', latest: prepared.version });
        } catch (error) {
          log.warn('desktop update download failed', { error: String(error.message ?? error) });
          return publish({ status: 'idle', error: String(error.message ?? error) });
        } finally { downloadInflight = null; }
      })();
      return downloadInflight;
    },
    install() {
      if (installInflight) return installInflight;
      if (installation.status === 'installing') return Promise.resolve(snapshot());
      if (stopped || !installer || !prepared) return Promise.reject(new Error('Download the update before restarting.'));
      publish({ status: 'installing', error: undefined });
      installInflight = (async () => {
        try { await installer.install(prepared); return snapshot(); }
        catch (error) { return publish({ status: 'ready', error: String(error.message ?? error) }); }
        finally { installInflight = null; }
      })();
      return installInflight;
    },
    /** Begin periodic checks. The first runs after a delay so it never competes with startup. */
    start(delayMs = 45_000) {
      if (stopped || first || repeat) return;
      const tick = () => { if (!stopped) void check(); };
      first = setTimeout(() => { tick(); repeat = setInterval(tick, intervalMs); repeat.unref?.(); }, delayMs);
      first.unref?.();
    },
    stop() {
      stopped = true;
      clearTimeout(first);
      clearInterval(repeat);
      first = repeat = null;
      if (prepared && installation.status !== 'installing') { installer?.discard(prepared); prepared = null; }
    },
  };
}
