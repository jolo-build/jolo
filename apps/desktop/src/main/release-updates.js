// Watches this project's GitHub releases for a newer desktop build.
//
// Distinct from engine-updates.js, which reloads a source-run engine during development.
// This module is about the shipped application, and it runs only in a packaged build.
//
// It does not install anything. macOS refuses to hand an update to an application whose
// signature it cannot attribute, and Jolo's bundle is ad-hoc signed rather than signed with
// a Developer ID and notarized, so replacing it silently is not something the system will
// vouch for. Until that changes the honest behaviour is to say a release exists and let the
// user fetch it; `apply` is the seam where an installer goes once signing is in place.
import { RELEASE_BASE_URL, VERSION_PATTERN, checkForUpdate } from "@jolo/updates";
import { createUpdateCache } from "@jolo/updates/cache";

const HOUR_MS = 60 * 60 * 1000;
const releasePage = (version) => `${RELEASE_BASE_URL}/releases/tag/v${version}`;

/**
 * @param {{ currentVersion: string, cacheFile: string, notice: (update: { latest: string, releaseUrl: string }) => void,
 *   log: { info: Function, warn: Function }, fetchImpl?: typeof fetch, now?: () => number,
 *   platform?: string, arch?: string, baseUrl?: string, intervalMs?: number }} options
 */
export function createReleaseUpdates({ currentVersion, cacheFile, notice, log, fetchImpl = fetch, now = Date.now, platform = process.platform, arch = process.arch, baseUrl, intervalMs = 6 * HOUR_MS }) {
  const cache = createUpdateCache({ file: cacheFile, now });
  let stopped = false, inflight = null, announced = null, first = null, repeat = null;

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
    if (stopped) return recorded();
    if (inflight) return inflight; // a second caller gets the answer already on its way, not an older one
    if (!force && !cache.due()) {
      const result = recorded();
      announce(result);
      return result;
    }
    inflight = (async () => {
      try {
        // The desktop archive's checksum is read too, so a release that published only the CLI
        // for this platform is never announced as a desktop update.
        const result = await checkForUpdate({ current: currentVersion, product: "desktop", platform, arch, baseUrl, fetchImpl });
        cache.record(result);
        announce(result);
        return { ...result, checked: true };
      } catch (error) {
        cache.record({ failed: true });
        // Being offline, behind a proxy, or ahead of the published release are all ordinary.
        log.warn("release update check failed", { error: String(error?.message ?? error) });
        return { current: currentVersion, latest: currentVersion, available: false, checked: true, error: String(error?.message ?? error) };
      } finally { inflight = null; }
    })();
    return inflight;
  }

  return {
    check,
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
    },
  };
}
