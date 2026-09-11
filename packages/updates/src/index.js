// Release updates for the CLI and the desktop application. Metadata and archives
// come from this project's GitHub Releases, which CI publishes only after every
// platform build has been verified (scripts/ci-release.js).
//
// Nothing here installs anything. Callers decide what to do with a result, and an
// update is applied only by an explicit user action. The SHA-256 published beside
// each archive is the integrity boundary, so a download is verified in full
// before any caller is allowed to see its bytes.
import { createHash } from "node:crypto";

export const REPOSITORY = "jolo-build/jolo";
/** Assets are read straight from the GitHub release; no project server is involved. */
export const RELEASE_BASE_URL = `https://github.com/${REPOSITORY}`;
/** Matches scripts/ci-release.js: a release tag is always `v` + this. */
export const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$/;
export const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_METADATA_BYTES = 4096;
/**
 * How a caller may substitute the network. Tests and the desktop pass a plain function, so this is
 * the call signature these helpers actually use rather than the full `fetch` interface, which on
 * Bun also carries `preconnect`.
 * @typedef {(input: any, init?: any) => Promise<Response>} FetchLike
 */

const PRODUCTS = Object.freeze({ cli: "tar.gz", desktop: "dmg" });
const PLATFORMS = Object.freeze(["darwin", "linux"]);
const ARCHITECTURES = Object.freeze(["arm64", "x64"]);
// The only names the network functions will fetch; a caller cannot turn them into a path walk.
const ASSET_NAME = /^jolo-(?:cli|desktop)-(?:darwin|linux)-(?:arm64|x64)\.(?:tar\.gz|dmg)$/;
function requireAssetName(name) {
  if (!ASSET_NAME.test(name ?? "")) throw new Error(`Not a Jolo release asset: ${String(name).slice(0, 80)}`);
  return name;
}

/** Split a release version into its numeric parts and prerelease identifiers, or null when malformed. */
export function parseVersion(value) {
  if (typeof value !== "string" || value.length > 64 || !VERSION_PATTERN.test(value)) return null;
  const [release, prerelease = ""] = value.split(/-(.*)/s);
  return {
    release: release.split(".").map(Number),
    // Semantic versioning compares dot-separated identifiers; this project's tags also allow `-`
    // inside a prerelease (`0.2.0-rc-1`), so both separators divide identifiers.
    prerelease: prerelease ? prerelease.split(/[.-]/) : [],
  };
}

/**
 * Order two versions the way semantic versioning does: numerically by release, and a prerelease
 * before the release it leads to. Returns -1, 0 or 1. Throws on a version that failed validation,
 * so a malformed value can never be silently treated as equal.
 */
export function compareVersions(left, right) {
  const a = parseVersion(left), b = parseVersion(right);
  if (!a || !b) throw new Error(`Invalid release version: ${!a ? left : right}`);
  for (let i = 0; i < 3; i += 1) if (a.release[i] !== b.release[i]) return a.release[i] < b.release[i] ? -1 : 1;
  if (!a.prerelease.length !== !b.prerelease.length) return a.prerelease.length ? -1 : 1;
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i += 1) {
    const one = a.prerelease[i], two = b.prerelease[i];
    if (one === undefined || two === undefined) return one === undefined ? -1 : 1;
    if (one === two) continue;
    const numeric = /^\d+$/.test(one), other = /^\d+$/.test(two);
    if (numeric && other) return Number(one) < Number(two) ? -1 : 1;
    if (numeric !== other) return numeric ? -1 : 1; // numeric identifiers rank below alphanumeric ones
    return one < two ? -1 : 1;
  }
  return 0;
}

export const isNewer = (candidate, current) => compareVersions(candidate, current) > 0;

/**
 * The published asset filename for a product on a platform. Callers may pass any strings: the
 * combination is checked against the published matrix here and refused if nothing was built for it.
 * @param {{ product?: string, platform?: string, arch?: string }} [target]
 */
export function assetName({ product = "cli", platform = process.platform, arch = process.arch } = {}) {
  if (!PRODUCTS[product] || !PLATFORMS.includes(platform) || !ARCHITECTURES.includes(arch) || product === 'desktop' && platform !== 'darwin') {
    throw new Error(`No Jolo ${product} release is published for ${platform}-${arch}.`);
  }
  return `jolo-${product}-${platform}-${arch}.${PRODUCTS[product]}`;
}

function base(baseUrl) {
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" && !["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("The release origin must use HTTPS.");
  // A GitHub release lays its assets out by tag; a plain origin (jolo.build, or a test server)
  // serves them under /releases/<version>/. Both resolve to the same published bytes.
  return { origin: baseUrl.replace(/\/$/, ""), github: url.hostname === "github.com" };
}

/**
 * Which asset layout an origin serves. scripts/install.sh understands the same two names, so
 * an update tells the installer exactly where to look instead of both guessing separately.
 * @returns {'github'|'origin'}
 */
export const releaseLayout = (baseUrl = RELEASE_BASE_URL) => base(baseUrl).github ? "github" : "origin";

/** Where the current stable version is published. Prereleases are never `latest` (scripts/ci-release.js). */
export function latestVersionUrl(baseUrl = RELEASE_BASE_URL) {
  const { origin, github } = base(baseUrl);
  return github ? `${origin}/releases/latest/download/latest.txt` : `${origin}/releases/latest.txt`;
}

export function assetUrl(version, name, baseUrl = RELEASE_BASE_URL) {
  if (!VERSION_PATTERN.test(version)) throw new Error("Invalid release version.");
  const { origin, github } = base(baseUrl);
  return github ? `${origin}/releases/download/v${version}/${name}` : `${origin}/releases/${version}/${name}`;
}

/** Read a response body with a hard ceiling, so a wrong or hostile URL cannot exhaust memory. */
async function bounded(response, limit, what) {
  if (!response.ok) throw new Error(`${what} request failed: HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new Error(`${what} exceeds the size limit.`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`${what} response was empty.`);
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) { await reader.cancel(); throw new Error(`${what} exceeds the size limit.`); }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * The newest published stable version, as the release itself reports it.
 * @param {{ baseUrl?: string, fetchImpl?: FetchLike, timeoutMs?: number }} [options]
 */
export async function fetchLatestVersion({ baseUrl = RELEASE_BASE_URL, fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  // GitHub answers this with a redirect to the release's own asset; following it is required.
  const body = await bounded(await fetchImpl(latestVersionUrl(baseUrl), { signal: AbortSignal.timeout(timeoutMs) }), MAX_METADATA_BYTES, "Release version");
  const version = body.toString("utf8").trim();
  if (!VERSION_PATTERN.test(version)) throw new Error("The release server returned an invalid version.");
  return version;
}

/**
 * The checksum published beside an archive. Its presence also proves the platform build exists.
 * @param {{ version?: string, name?: string, baseUrl?: string, fetchImpl?: FetchLike, timeoutMs?: number }} [options]
 */
export async function fetchChecksum({ version, name, baseUrl = RELEASE_BASE_URL, fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  requireAssetName(name);
  const body = await bounded(await fetchImpl(`${assetUrl(version, name, baseUrl)}.sha256`, { signal: AbortSignal.timeout(timeoutMs) }), MAX_METADATA_BYTES, "Release checksum");
  const [line, ...rest] = body.toString("utf8").trim().split("\n");
  const match = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line ?? "");
  if (rest.length || !match || match[2] !== name) throw new Error("The release checksum file is invalid.");
  return match[1];
}

/**
 * Download an archive and return it only when its bytes match the published checksum.
 * @param {{ version?: string, name?: string, sha256?: string, baseUrl?: string, fetchImpl?: FetchLike, maxBytes?: number, timeoutMs?: number }} [options]
 * @returns {Promise<Buffer>}
 */
export async function downloadAsset({ version, name, sha256, baseUrl = RELEASE_BASE_URL, fetchImpl = fetch, maxBytes = MAX_ARCHIVE_BYTES, timeoutMs = 300_000 } = {}) {
  requireAssetName(name);
  if (!/^[0-9a-f]{64}$/.test(sha256 ?? "")) throw new Error("A published checksum is required before downloading a release.");
  const bytes = await bounded(await fetchImpl(assetUrl(version, name, baseUrl), { signal: AbortSignal.timeout(timeoutMs) }), maxBytes, "Release download");
  if (createHash("sha256").update(bytes).digest("hex") !== sha256) throw new Error("Release checksum mismatch; the download was discarded.");
  return bytes;
}

/**
 * Compare the running version against the newest published release.
 *
 * With `product`, the platform's checksum is read too, which both confirms that the release
 * really carries a build for this machine and returns what a download must match. A version
 * ahead of the release (a local build) reports no update rather than a downgrade.
 *
 * @param {{ current?: string, product?: string, platform?: string, arch?: string, baseUrl?: string, fetchImpl?: FetchLike }} [options]
 * @returns {Promise<{ current: string, latest: string, available: boolean, name?: string, sha256?: string, url?: string, releaseUrl: string }>}
 */
export async function checkForUpdate({ current, product, platform, arch, baseUrl = RELEASE_BASE_URL, fetchImpl = fetch } = {}) {
  const latest = await fetchLatestVersion({ baseUrl, fetchImpl });
  const available = isNewer(latest, current);
  const releaseUrl = `${RELEASE_BASE_URL}/releases/tag/v${latest}`;
  if (!available || !product) return { current, latest, available, releaseUrl };
  const name = assetName({ product, platform, arch });
  return { current, latest, available, name, sha256: await fetchChecksum({ version: latest, name, baseUrl, fetchImpl }), url: assetUrl(latest, name, baseUrl), releaseUrl };
}
