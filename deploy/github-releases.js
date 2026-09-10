// Public release metadata is cached at the edge; downloads redirect to GitHub's CDN.
// Keep the repository fixed so a request cannot turn this into an arbitrary redirect.
const REPOSITORY = 'jolo-build/jolo';
const VERSION = '(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?';
const ASSET_PATH = new RegExp(`^/releases/(${VERSION})/(jolo-cli-(?:darwin|linux)-(?:arm64|x64)\\.tar\\.gz(?:\\.sha256)?)$`);
const REQUIRED = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'].flatMap(target => [`jolo-cli-${target}.tar.gz`, `jolo-cli-${target}.tar.gz.sha256`]);

export function githubAssetRedirect(pathname) {
  const match = pathname.match(ASSET_PATH);
  return match ? new Response(null, { status: 302, headers: {
    Location: `https://github.com/${REPOSITORY}/releases/download/v${match[1]}/${match[2]}`,
    'Cache-Control': 'public, max-age=300',
  } }) : null;
}
export async function latestRelease(request, env, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'jolo-release-installer', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(10000), cf: { cacheEverything: true, cacheTtl: 300 },
    });
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
