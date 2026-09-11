import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReleaseUpdates } from '../src/main/release-updates.js';

const directories = [];
const temporary = () => { const path = mkdtempSync(join(tmpdir(), 'jolo-release-updates-')); directories.push(path); return path; };
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

function server({ version = '0.2.0', desktop = true } = {}) {
  const calls = [];
  const name = 'jolo-desktop-darwin-arm64.dmg';
  return { calls, name, fetchImpl: async url => {
    calls.push(url);
    if (url.endsWith('/latest.txt')) return new Response(`${version}\n`);
    if (desktop && url.endsWith(`${name}.sha256`)) return new Response(`${createHash('sha256').update(name).digest('hex')}  ${name}\n`);
    return new Response('Not found', { status: 404 });
  } };
}

const quiet = { info() {}, warn() {} };
const updates = (options) => createReleaseUpdates({ cacheFile: join(temporary(), 'updates.json'), platform: 'darwin', arch: 'arm64', log: quiet, notice: () => {}, ...options });

test('a newer release is announced once, not on every check', async () => {
  const feed = server();
  const announced = [];
  let time = 1_000_000;
  const monitor = updates({ currentVersion: '0.1.0', fetchImpl: feed.fetchImpl, notice: update => announced.push(update), now: () => time });
  expect(await monitor.check()).toMatchObject({ current: '0.1.0', latest: '0.2.0', available: true, checked: true });
  expect(announced).toEqual([{ latest: '0.2.0', releaseUrl: 'https://github.com/jolo-build/jolo/releases/tag/v0.2.0' }]);
  // A day later the release is still the same one; the user has already been told.
  time += 25 * 60 * 60 * 1000;
  await monitor.check();
  expect(announced).toHaveLength(1);
});

test('checks are rate-limited, and the last result is still reported without asking again', async () => {
  const feed = server();
  const monitor = updates({ currentVersion: '0.1.0', fetchImpl: feed.fetchImpl });
  await monitor.check();
  const requests = feed.calls.length;
  const repeat = await monitor.check();
  expect(feed.calls).toHaveLength(requests);
  expect(repeat).toMatchObject({ latest: '0.2.0', available: true, checked: false });
  // A check the user asked for ignores the limit.
  expect((await monitor.check({ force: true })).checked).toBe(true);
  expect(feed.calls.length).toBeGreaterThan(requests);
});

test('a release without a desktop bundle for this Mac is not announced', async () => {
  const announced = [];
  const monitor = updates({ currentVersion: '0.1.0', fetchImpl: server({ desktop: false }).fetchImpl, notice: update => announced.push(update) });
  const result = await monitor.check();
  expect(result.available).toBe(false);
  expect(result.error).toContain('404');
  expect(announced).toEqual([]);
});

test('being offline is recorded and reported, never thrown at the window', async () => {
  const warnings = [];
  const monitor = updates({ currentVersion: '0.1.0', fetchImpl: async () => { throw new Error('offline'); }, log: { info() {}, warn: (_, fields) => warnings.push(fields) } });
  expect(await monitor.check()).toMatchObject({ available: false, checked: true });
  expect(warnings[0].error).toContain('offline');
});

test('a build at the published version reports no update', async () => {
  const monitor = updates({ currentVersion: '0.2.0', fetchImpl: server().fetchImpl });
  expect((await monitor.check()).available).toBe(false);
});

test('a cached result still carries the release page, so the download button never goes missing', async () => {
  const monitor = updates({ currentVersion: '0.1.0', fetchImpl: server().fetchImpl });
  await monitor.check();
  expect(await monitor.check()).toEqual({ current: '0.1.0', latest: '0.2.0', available: true, releaseUrl: 'https://github.com/jolo-build/jolo/releases/tag/v0.2.0', checked: false });
});

test('a relaunch is reminded from the cache without asking the network again', async () => {
  const cacheFile = join(temporary(), 'updates.json');
  const feed = server();
  await updates({ currentVersion: '0.1.0', fetchImpl: feed.fetchImpl, cacheFile }).check();
  const requests = feed.calls.length;
  const announced = [];
  const relaunched = updates({ currentVersion: '0.1.0', fetchImpl: feed.fetchImpl, cacheFile, notice: update => announced.push(update) });
  await relaunched.check();
  await relaunched.check(); // once per launch, not once per check
  expect(feed.calls).toHaveLength(requests);
  expect(announced).toEqual([{ latest: '0.2.0', releaseUrl: 'https://github.com/jolo-build/jolo/releases/tag/v0.2.0' }]);
  // What the previous build recorded says nothing about this one.
  const upgraded = updates({ currentVersion: '0.2.0', fetchImpl: feed.fetchImpl, cacheFile, notice: update => announced.push(update) });
  expect(await upgraded.check()).toMatchObject({ available: false, checked: false });
  expect(announced).toHaveLength(1);
});

test('a check asked for while one is in flight receives that answer, not an older one', async () => {
  let open;
  const gate = new Promise(resolve => { open = resolve; });
  let requests = 0;
  const fetchImpl = async url => { requests += 1; await gate; return server().fetchImpl(url); };
  const monitor = updates({ currentVersion: '0.1.0', fetchImpl });
  const background = monitor.check();
  const forced = monitor.check({ force: true });
  open();
  const [first, second] = await Promise.all([background, forced]);
  expect(first).toEqual(second);
  expect(first).toMatchObject({ available: true, latest: '0.2.0', checked: true });
  expect(requests).toBe(2); // one version lookup and one checksum, shared by both callers
});

test('stopping prevents any further check, including one already scheduled', async () => {
  const feed = server();
  const monitor = updates({ currentVersion: '0.1.0', fetchImpl: feed.fetchImpl });
  monitor.start(0);
  monitor.stop();
  expect(await monitor.check({ force: true })).toMatchObject({ checked: false });
  expect(feed.calls).toHaveLength(0);
});
