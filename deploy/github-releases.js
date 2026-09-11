// Public release metadata is cached at the edge; downloads redirect to GitHub's CDN.
// Keep the repository fixed so a request cannot turn this into an arbitrary redirect.
const REPOSITORY = 'jolo-build/jolo';
const VERSION = '(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?';
// The desktop application publishes macOS bundles alongside the CLI archives; both are served
// from the same versioned path so one installer URL scheme covers everything Jolo ships.
const ASSET_PATH = new RegExp(`^/releases/(${VERSION})/(jolo-cli-(?:darwin|linux)-(?:arm64|x64)\\.tar\\.gz(?:\\.sha256)?|jolo-desktop-darwin-(?:arm64|x64)\\.(?:dmg|zip)(?:\\.sha256)?)$`);
// Completeness is judged on the CLI alone: the installer depends on it, and a release that
// published only the CLI must still be installable.
const REQUIRED = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'].flatMap(target => [`jolo-cli-${target}.tar.gz`, `jolo-cli-${target}.tar.gz.sha256`]);

/**
 * How these helpers reach GitHub. Tests inject a plain function, so this is the call signature they
 * actually use rather than the platform `fetch` interface, which carries members no caller here
 * touches and which no test double could supply.
 * @typedef {(url: string, init?: any) => Promise<Response>} FetchLike
 */

/** @param {FetchLike} fetchImpl */
function lookupLatest(fetchImpl) {
  return fetchImpl(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'jolo-release-installer', 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(10000), cf: { cacheEverything: true, cacheTtl: 300 },
  });
}
const stableVersion = release => release.draft === false && release.prerelease === false
  ? release.tag_name?.match(/^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/)?.[1] : null;

/**
 * Advertise desktop links only when both DMGs and their checksums are published.
 * @param {Request} request
 * @param {FetchLike} [fetchImpl]
 */
export async function latestDesktopRelease(request, fetchImpl = fetch) {
  const respond = body => new Response(request.method === 'HEAD' ? null : JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
  });
  try {
    const response = await lookupLatest(fetchImpl);
    if (response.status === 404) return respond({ version: null, downloads: [] });
    if (!response.ok) throw new Error('Release lookup failed');
    const release = await response.json(), version = stableVersion(release);
    if (!version || !Array.isArray(release.assets)) throw new Error('Invalid stable release');
    const names = ['arm64', 'x64'].map(arch => ({ arch, name: `jolo-desktop-darwin-${arch}.dmg` }));
    const present = name => release.assets.some(asset => asset.name === name && asset.state === 'uploaded' && asset.size > 0);
    if (!names.every(({ name }) => present(name) && present(`${name}.sha256`))) return respond({ version: null, downloads: [] });
    return respond({ version, downloads: names.map(({ arch, name }) => ({ arch, url: `/releases/${version}/${name}`, checksum: `/releases/${version}/${name}.sha256` })) });
  } catch {
    return new Response(null, { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '60' } });
  }
}

export function githubAssetRedirect(pathname) {
  const match = pathname.match(ASSET_PATH);
  return match ? new Response(null, { status: 302, headers: {
    Location: `https://github.com/${REPOSITORY}/releases/download/v${match[1]}/${match[2]}`,
    'Cache-Control': 'public, max-age=300',
  } }) : null;
}
/**
 * @param {Request} request
 * @param {Record<string, any>} env
 * @param {FetchLike} [fetchImpl]
 */
export async function latestRelease(request, env, fetchImpl = fetch) {
  try {
    const response = await lookupLatest(fetchImpl);
    // Before the first CI release, the original website-hosted release remains installable.
    if (response.status === 404) return env.ASSETS.fetch(request);
    if (!response.ok) throw new Error('GitHub release lookup failed');
    const release = await response.json();
    const version = release.tag_name?.match(/^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/)?.[1];
    if (!version || release.draft !== false || release.prerelease !== false || !Array.isArray(release.assets) ||
        !REQUIRED.every(name => release.assets.some(asset => asset.name === name && asset.state === 'uploaded' && asset.size > 0))) throw new Error('Incomplete stable release');
    return new Response(request.method === 'HEAD' ? null : `${version}\n`, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=300' } });
  } catch {
    // Never silently downgrade to 0.1.0 on rate limits, outages, or an incomplete newer release.
    return new Response('Release information is temporarily unavailable. Retry or use --version.\n', { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '60' } });
  }
}
