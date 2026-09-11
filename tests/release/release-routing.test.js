import { expect, test } from 'bun:test';
import { githubAssetRedirect, latestRelease, latestDesktopRelease } from '../../deploy/github-releases.js';
import worker from '../../deploy/website-worker.js';

const request = new Request('https://jolo.build/releases/latest.txt');
const legacy = { ASSETS: { fetch: async () => new Response('0.1.0\n') } };
const release = () => ({ tag_name: 'v1.2.3', draft: false, prerelease: false, assets: ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'].flatMap(target => ['', '.sha256'].map(suffix => ({ name: `jolo-cli-${target}.tar.gz${suffix}`, state: 'uploaded', size: 123 }))) });

test('desktop choices contain only complete published DMGs and fixed versioned URLs', async () => {
  const published = release();
  published.assets.push(...['arm64', 'x64'].flatMap(arch => ['', '.sha256'].map(suffix => ({ name: `jolo-desktop-darwin-${arch}.dmg${suffix}`, state: 'uploaded', size: 123 }))));
  const response = await latestDesktopRelease(request, async () => Response.json(published));
  expect(await response.json()).toEqual({ version: '1.2.3', downloads: ['arm64', 'x64'].map(arch => ({ arch, url: `/releases/1.2.3/jolo-desktop-darwin-${arch}.dmg`, checksum: `/releases/1.2.3/jolo-desktop-darwin-${arch}.dmg.sha256` })) });
  expect(await (await latestDesktopRelease(new Request(request, { method: 'HEAD' }), async () => Response.json(published))).text()).toBe('');
  for (const assets of [release().assets, published.assets.slice(0, -1), published.assets.map(asset => ({ ...asset, state: 'new' }))]) {
    expect(await (await latestDesktopRelease(request, async () => Response.json({ ...published, assets }))).json()).toEqual({ version: null, downloads: [] });
  }
  expect(await (await latestDesktopRelease(request, async () => new Response(null, { status: 404 }))).json()).toEqual({ version: null, downloads: [] });
  for (const bad of [{ ...published, draft: true }, { ...published, prerelease: true }, { ...published, tag_name: 'v1.2.3-rc.1' }]) {
    expect((await latestDesktopRelease(request, async () => Response.json(bad))).status).toBe(503);
  }
  expect((await latestDesktopRelease(request, async () => { throw new Error('offline'); })).status).toBe(503);
  expect((await worker.fetch(new Request('https://jolo.build/releases/desktop.json', { method: 'POST' }), legacy)).status).toBe(405);
});

test('latest selects only a complete stable GitHub release', async () => {
  const response = await latestRelease(request, legacy, async url => { expect(url).toBe('https://api.github.com/repos/jolo-build/jolo/releases/latest'); return Response.json(release()); });
  expect(await response.text()).toBe('1.2.3\n');
  expect(response.headers.get('cache-control')).toContain('max-age=300');
  const head = await latestRelease(new Request(request, { method: 'HEAD' }), legacy, async () => Response.json(release()));
  expect(await head.text()).toBe('');
  expect(head.status).toBe(200);
});

test('the original release remains available before any GitHub release exists', async () => {
  expect(await (await latestRelease(request, legacy, async () => new Response(null, { status: 404 }))).text()).toBe('0.1.0\n');
});

test('outages, incomplete assets, drafts, prereleases and bad tags cannot silently downgrade latest', async () => {
  for (const bad of [{ ...release(), draft: true }, { ...release(), prerelease: true }, { ...release(), tag_name: 'v1.2.3-rc.1' }, { ...release(), tag_name: '../../x' }, { ...release(), assets: release().assets.slice(1) }]) {
    const response = await latestRelease(request, legacy, async () => Response.json(bad));
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
  }
  expect((await latestRelease(request, legacy, async () => new Response(null, { status: 403 }))).status).toBe(503);
  expect((await latestRelease(request, legacy, async () => { throw new Error('offline'); })).status).toBe(503);
});

test('only supported versioned download paths redirect to the fixed GitHub repository', () => {
  for (const target of ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']) for (const suffix of ['', '.sha256']) {
    const name = `jolo-cli-${target}.tar.gz${suffix}`;
    const response = githubAssetRedirect(`/releases/1.2.3-rc.1/${name}`);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`https://github.com/jolo-build/jolo/releases/download/v1.2.3-rc.1/${name}`);
  }
  for (const url of ['/releases/../../evil', '/releases/bogus/jolo-cli-linux-x64.tar.gz', '/releases/1.2.3/jolo-cli-windows-x64.tar.gz', '/releases/1.2.3/evil.sh']) expect(githubAssetRedirect(url)).toBeNull();
});

test('desktop bundles download through the same versioned path, macOS only', () => {
  for (const arch of ['arm64', 'x64']) for (const suffix of ['', '.sha256']) {
    const name = `jolo-desktop-darwin-${arch}.dmg${suffix}`;
    expect(githubAssetRedirect(`/releases/1.2.3/${name}`).headers.get('location')).toBe(`https://github.com/jolo-build/jolo/releases/download/v1.2.3/${name}`);
  }
  for (const url of ['/releases/1.2.3/jolo-desktop-linux-x64.dmg', '/releases/1.2.3/jolo-desktop-darwin-arm64.tar.gz', '/releases/1.2.3/jolo-desktop-darwin-arm64.dmg.sig']) expect(githubAssetRedirect(url)).toBeNull();
});

test('a release that published only the CLI still resolves as the latest installable version', async () => {
  // Desktop bundles are additional, so their absence must not make a release look incomplete.
  const response = await latestRelease(request, legacy, async () => Response.json(release()));
  expect(await response.text()).toBe('1.2.3\n');
});

test('static archives and checksums win; new archives and checksums redirect; write requests are rejected', async () => {
  for (const suffix of ['', '.sha256']) {
    const download = new Request(`https://jolo.build/releases/1.2.3/jolo-cli-linux-x64.tar.gz${suffix}`);
    expect(await (await worker.fetch(download, legacy)).text()).toBe('0.1.0\n');
    const absent = { ASSETS: { fetch: async () => new Response('missing', { status: 404 }) } };
    const response = await worker.fetch(download, absent);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toEndWith(`/v1.2.3/jolo-cli-linux-x64.tar.gz${suffix}`);
    expect((await worker.fetch(new Request(download, { method: 'POST' }), absent)).status).toBe(405);
  }
});
