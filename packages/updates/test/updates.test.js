import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assetName, assetUrl, checkForUpdate, compareVersions, downloadAsset, fetchChecksum, fetchLatestVersion, isNewer, latestVersionUrl, releaseLayout } from '@jolo/updates';
import { createUpdateCache } from '@jolo/updates/cache';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const directories = [];
const temporary = () => { const path = mkdtempSync(join(tmpdir(), 'jolo-updates-')); directories.push(path); return path; };
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

/** A release server that answers exactly the URLs a published GitHub release serves. */
function release({ version = '0.2.0', archive = Buffer.from('archive bytes'), product = 'cli', platform = 'darwin', arch = 'arm64' } = {}) {
  const name = `jolo-${product}-${platform}-${arch}.${product === 'desktop' ? 'dmg' : 'tar.gz'}`;
  const bodies = new Map([
    [`https://github.com/jolo-build/jolo/releases/latest/download/latest.txt`, Buffer.from(`${version}\n`)],
    [`https://github.com/jolo-build/jolo/releases/download/v${version}/${name}`, archive],
    [`https://github.com/jolo-build/jolo/releases/download/v${version}/${name}.sha256`, Buffer.from(`${digest(archive)}  ${name}\n`)],
  ]);
  const calls = [];
  const fetchImpl = async url => { calls.push(url); const body = bodies.get(url); return body ? new Response(body) : new Response('Not found', { status: 404 }); };
  return { version, name, archive, bodies, calls, fetchImpl, sha256: digest(archive) };
}

test('versions order by release, then prerelease, the way published tags do', () => {
  expect(compareVersions('0.2.0', '0.1.9')).toBe(1);
  expect(compareVersions('0.1.10', '0.1.9')).toBe(1);
  expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  // A prerelease precedes the release it leads to, so `jolo update` never offers rc over final.
  expect(compareVersions('0.2.0-rc.1', '0.2.0')).toBe(-1);
  expect(compareVersions('0.2.0-rc.2', '0.2.0-rc.10')).toBe(-1);
  expect(compareVersions('0.2.0-rc.2', '0.2.0-beta.9')).toBe(1);
  expect(compareVersions('0.2.0-rc-1', '0.2.0-rc-2')).toBe(-1); // this project's tags also allow `-`
  expect(isNewer('0.1.1', '0.1.0')).toBe(true);
  expect(isNewer('0.1.0', '0.1.1')).toBe(false);
});

test('a malformed version is an error, never silently equal', () => {
  for (const value of ['0.2', '0.2.0\nmalformed', 'v0.2.0', '', '01.2.0', 'latest', null]) {
    expect(() => compareVersions(value, '0.1.0')).toThrow();
  }
});

test('asset names and URLs follow the published GitHub release layout', () => {
  expect(assetName({ product: 'cli', platform: 'linux', arch: 'x64' })).toBe('jolo-cli-linux-x64.tar.gz');
  expect(assetName({ product: 'desktop', platform: 'darwin', arch: 'arm64' })).toBe('jolo-desktop-darwin-arm64.dmg');
  expect(() => assetName({ product: 'desktop', platform: 'linux', arch: 'x64' })).toThrow('No Jolo desktop release');
  expect(() => assetName({ product: 'desktop', platform: 'win32', arch: 'x64' })).toThrow();
  expect(() => assetName({ product: 'installer', platform: 'darwin', arch: 'arm64' })).toThrow();
  expect(latestVersionUrl()).toBe('https://github.com/jolo-build/jolo/releases/latest/download/latest.txt');
  expect(assetUrl('0.2.0', 'a.tar.gz')).toBe('https://github.com/jolo-build/jolo/releases/download/v0.2.0/a.tar.gz');
  // Any other origin serves the same files under the versioned path the installer already uses.
  expect(latestVersionUrl('https://jolo.build')).toBe('https://jolo.build/releases/latest.txt');
  expect(assetUrl('0.2.0', 'a.tar.gz', 'https://jolo.build/')).toBe('https://jolo.build/releases/0.2.0/a.tar.gz');
  expect(() => assetUrl('0.2.0', 'a.tar.gz', 'http://releases.example.com')).toThrow(/HTTPS/);
  expect(() => assetUrl('../../etc', 'a.tar.gz')).toThrow();
  // The installer is told which layout to use rather than inferring it a second time.
  expect(releaseLayout()).toBe('github');
  expect(releaseLayout('https://jolo.build')).toBe('origin');
  expect(releaseLayout('http://127.0.0.1:8080')).toBe('origin');
  // A lookalike host must not be treated as GitHub's release layout.
  expect(releaseLayout('https://github.com.example.test/a/b')).toBe('origin');
});

test('a check reports the newer release and the checksum its download must match', async () => {
  const server = release();
  const result = await checkForUpdate({ current: '0.1.0', product: 'cli', platform: 'darwin', arch: 'arm64', fetchImpl: server.fetchImpl });
  expect(result).toMatchObject({ current: '0.1.0', latest: '0.2.0', available: true, name: server.name, sha256: server.sha256 });
  expect(result.releaseUrl).toBe('https://github.com/jolo-build/jolo/releases/tag/v0.2.0');
});

test('a build at or ahead of the release reports no update and asks for no checksum', async () => {
  for (const current of ['0.2.0', '0.3.0']) {
    const server = release();
    const result = await checkForUpdate({ current, product: 'cli', platform: 'darwin', arch: 'arm64', fetchImpl: server.fetchImpl });
    expect(result.available).toBe(false);
    expect(server.calls).toHaveLength(1); // only the version lookup
  }
});

test('a release without a build for this platform is not announced as an update', async () => {
  const server = release({ product: 'cli' });
  // The desktop archive is absent from this release, so its checksum 404s.
  await expect(checkForUpdate({ current: '0.1.0', product: 'desktop', platform: 'darwin', arch: 'arm64', fetchImpl: server.fetchImpl })).rejects.toThrow(/HTTP 404/);
});

test('malformed version and checksum metadata is rejected', async () => {
  const bad = body => ({ fetchImpl: async () => new Response(body) });
  await expect(fetchLatestVersion(bad('not-a-version\n'))).rejects.toThrow(/invalid version/);
  await expect(fetchLatestVersion(bad('0.2.0\n0.3.0\n'))).rejects.toThrow(/invalid version/);
  for (const body of ['deadbeef  jolo-cli-darwin-arm64.tar.gz\n', `${'a'.repeat(64)}  other-file.tar.gz\n`, `${'a'.repeat(64)} jolo-cli-darwin-arm64.tar.gz\n`, `${'a'.repeat(64)}  jolo-cli-darwin-arm64.tar.gz\n${'b'.repeat(64)}  x\n`]) {
    await expect(fetchChecksum({ version: '0.2.0', name: 'jolo-cli-darwin-arm64.tar.gz', ...bad(body) })).rejects.toThrow(/checksum file is invalid/);
  }
});

test('a download is returned only when it matches the published checksum', async () => {
  const server = release();
  expect((await downloadAsset({ version: '0.2.0', name: server.name, sha256: server.sha256, fetchImpl: server.fetchImpl })).toString()).toBe('archive bytes');
  await expect(downloadAsset({ version: '0.2.0', name: server.name, sha256: 'a'.repeat(64), fetchImpl: server.fetchImpl })).rejects.toThrow(/checksum mismatch/);
  // Nothing downloads without a checksum to check it against.
  await expect(downloadAsset({ version: '0.2.0', name: server.name, fetchImpl: server.fetchImpl })).rejects.toThrow(/published checksum is required/);
});

test('the network functions fetch only names a release actually publishes', async () => {
  const server = release();
  for (const name of ['../../etc/passwd', 'jolo-cli-darwin-arm64.tar.gz/../x', 'latest.txt', 'jolo-cli-win32-x64.tar.gz', '']) {
    await expect(fetchChecksum({ version: '0.2.0', name, fetchImpl: server.fetchImpl })).rejects.toThrow(/Not a Jolo release asset/);
    await expect(downloadAsset({ version: '0.2.0', name, sha256: server.sha256, fetchImpl: server.fetchImpl })).rejects.toThrow(/Not a Jolo release asset/);
  }
  expect(server.calls).toHaveLength(0); // refused before any request
});

test('an oversized download is abandoned rather than buffered', async () => {
  const server = release({ archive: Buffer.alloc(4096, 7) });
  await expect(downloadAsset({ version: '0.2.0', name: server.name, sha256: server.sha256, maxBytes: 1024, fetchImpl: server.fetchImpl })).rejects.toThrow(/size limit/);
});

test('the cache rate-limits checks, retries failures sooner, and survives damage', () => {
  const file = join(temporary(), 'update.json');
  let time = 1_000_000;
  const cache = createUpdateCache({ file, now: () => time });
  expect(cache.due()).toBe(true); // nothing recorded yet
  cache.record({ current: '0.1.0', latest: '0.2.0', available: true });
  expect(cache.read()).toMatchObject({ current: '0.1.0', latest: '0.2.0', available: true });
  expect(cache.due()).toBe(false);
  time += 23 * 60 * 60 * 1000;
  expect(cache.due()).toBe(false);
  time += 2 * 60 * 60 * 1000;
  expect(cache.due()).toBe(true);
  // A failed check is retried within the hour instead of hiding a release for a day.
  cache.record({ failed: true });
  expect(cache.read().failed).toBe(true);
  expect(cache.due()).toBe(false);
  time += 61 * 60 * 1000;
  expect(cache.due()).toBe(true);
  writeFileSync(file, '{ not json');
  expect(cache.read()).toBe(null);
  expect(cache.due()).toBe(true);
});

test('a clock that moves backwards forces a fresh check instead of freezing one', () => {
  const file = join(temporary(), 'update.json');
  let time = 1_000_000;
  const cache = createUpdateCache({ file, now: () => time });
  cache.record({ current: '0.1.0', latest: '0.1.0', available: false });
  time -= 60_000;
  expect(cache.due()).toBe(true);
  expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(1);
});
