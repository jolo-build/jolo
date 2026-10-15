import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { createDesktopInstaller, desktopInstallLayout } from '../src/main/desktop-installer.js';
import { acknowledgeDesktopUpdate, applyDesktopUpdate } from '../src/main/update-helper.js';
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
  /** @type {(value?: any) => void} the gate's resolve, captured below so the test can release both checks */
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

function installationFixture({ failDownload = false, failInstall = false } = {}) {
  const calls = [], changes = [];
  const prepared = { version: '0.2.0' };
  const installer = /** @type {any} */ ({
    previousError() {},
    async prepare(release, progress) { calls.push('prepare'); expect(release.sha256).toHaveLength(64); progress(10, 100); if (failDownload) throw new Error('download interrupted'); return prepared; },
    async install(value) { expect(value).toBe(prepared); calls.push('install'); if (failInstall) throw new Error('Finish active tasks first'); },
    discard() { calls.push('discard'); },
  });
  return { calls, changes, monitor: updates({ currentVersion: '0.1.0', fetchImpl: server().fetchImpl, installer, changed: value => changes.push(value) }) };
}

test('an in-app update downloads once, reports progress and only installs on a separate restart request', async () => {
  const f = installationFixture();
  const [one, two] = await Promise.all([f.monitor.download(), f.monitor.download()]);
  expect(one).toMatchObject({ status: 'ready', latest: '0.2.0', installable: true });
  expect(two).toEqual(one);
  expect(f.calls).toEqual(['prepare']);
  expect(f.changes.some(value => value.received === 10 && value.total === 100)).toBe(true);
  expect(await f.monitor.check()).toMatchObject({ status: 'ready' });
  expect(await f.monitor.install()).toMatchObject({ status: 'installing' });
  await f.monitor.install(); // another request during the quit delay must not spawn a second worker
  f.monitor.stop();
  expect(f.calls).toEqual(['prepare', 'install']); // the worker owns staging during restart
});

test('a failed download can be retried, and a network error is shown before any archive is installed', async () => {
  const f = installationFixture({ failDownload: true });
  expect(await f.monitor.download()).toMatchObject({ status: 'idle', error: 'download interrupted' });
  await f.monitor.download();
  expect(f.calls).toEqual(['prepare', 'prepare']);
  const monitor = updates({ currentVersion: '0.1.0', fetchImpl: async () => { throw new Error('offline'); }, installer: /** @type {any} */ ({ previousError() {}, prepare() { throw new Error('should not download'); } }) });
  expect(await monitor.download()).toMatchObject({ error: 'offline', status: 'idle' });
});

test('active work leaves the staged update ready to retry, and quitting without installing discards it', async () => {
  const f = installationFixture({ failInstall: true });
  await f.monitor.download();
  expect(await f.monitor.install()).toMatchObject({ status: 'ready', error: 'Finish active tasks first' });
  f.monitor.stop();
  expect(f.calls).toEqual(['prepare', 'install', 'discard']);
});

test('installation locations match the macOS, Linux and Windows release layouts', () => {
  expect(desktopInstallLayout('/Applications/Jolo.app/Contents/MacOS/Jolo', 'darwin')).toEqual({ target: '/Applications/Jolo.app', executable: 'Contents/MacOS/Jolo' });
  expect(desktopInstallLayout('/opt/Jolo-linux-x64/Jolo', 'linux')).toEqual({ target: '/opt/Jolo-linux-x64', executable: 'Jolo' });
  expect(desktopInstallLayout('C:\\Apps\\Jolo-win32-x64\\Jolo.exe', 'win32')).toEqual({ target: 'C:\\Apps\\Jolo-win32-x64', executable: 'Jolo.exe' });
  expect(() => desktopInstallLayout('/usr/local/bin/electron', 'darwin')).toThrow('installed Jolo');
});

function swapFixture() {
  const root = temporary(), target = path.join(root, 'Jolo.app');
  const stage = mkdtempSync(path.join(root, '.jolo-update-')), replacement = path.join(stage, 'replacement');
  for (const [dir, text] of [[target, 'old'], [replacement, 'new']]) { mkdirSync(dir); writeFileSync(path.join(dir, 'Jolo'), text); }
  const config = { pid: 2147483647, target, stage, replacement, executable: 'Jolo', version: '2.0.0', resultFile: path.join(root, 'result.json') };
  writeFileSync(path.join(stage, 'update.json'), JSON.stringify(config));
  const child = /** @type {any} */ ({ exitCode: null, kill() {} });
  return { root, config, child, contents: () => readFileSync(path.join(target, 'Jolo'), 'utf8') };
}

test('the detached installer replaces the app and retires the backup only after startup acknowledgement', async () => {
  const f = swapFixture();
  await applyDesktopUpdate(f.config, { launchImpl: async (executable, args) => {
    expect(executable).toBe(path.join(f.config.target, 'Jolo'));
    expect(f.contents()).toBe('new');
    expect(readFileSync(path.join(f.config.stage, 'previous/Jolo'), 'utf8')).toBe('old');
    acknowledgeDesktopUpdate({ target: f.config.target, version: '2.0.0', argv: args });
    return f.child;
  } });
  expect(f.contents()).toBe('new');
  expect(existsSync(f.config.stage)).toBe(false);
  expect(JSON.parse(readFileSync(f.config.resultFile, 'utf8')).installed).toBe(true);
});

test.each(['launch', 'startup', 'replacement'])('a failed %s restores and relaunches the old app', async failure => {
  const f = swapFixture();
  let launches = 0;
  if (failure === 'replacement') rmSync(f.config.replacement, { recursive: true });
  await expect(applyDesktopUpdate(f.config, { waitMs: 10, launchImpl: async () => {
    launches++;
    if (f.contents() === 'new' && failure === 'launch') throw new Error('launch failed');
    return f.child;
  } })).rejects.toThrow();
  expect(f.contents()).toBe('old');
  expect(launches).toBe(failure === 'replacement' ? 1 : 2);
  expect(JSON.parse(readFileSync(f.config.resultFile, 'utf8')).error).toBeTruthy();
});

test('a running application is never replaced before it exits', async () => {
  const f = swapFixture();
  f.config.pid = process.pid;
  await expect(applyDesktopUpdate(f.config, { waitMs: 5 })).rejects.toThrow('did not exit');
  expect(f.contents()).toBe('old');
});

test('startup acknowledgement rejects arbitrary paths and a mismatched version', () => {
  const f = swapFixture();
  const arbitrary = path.join(f.root, 'arbitrary.json');
  acknowledgeDesktopUpdate({ target: f.config.target, version: '2.0.0', argv: [`--jolo-update-ready=${arbitrary}`] });
  expect(existsSync(arbitrary)).toBe(false);
  acknowledgeDesktopUpdate({ target: f.config.target, version: '1.0.0', argv: [`--jolo-update-ready=${path.join(f.config.stage, 'ready.json')}`] });
  expect(existsSync(path.join(f.config.stage, 'ready.json'))).toBe(false);
});

function archiveFixture({ version = '2.0.0', corrupt = false } = {}) {
  const root = temporary(), target = path.join(root, 'installed'), appDirectory = path.join(target, 'resources/app');
  mkdirSync(path.join(appDirectory, 'engine'), { recursive: true });
  writeFileSync(path.join(appDirectory, 'engine/bun'), 'runtime');
  writeFileSync(path.join(appDirectory, 'update-helper.js'), 'helper');
  writeFileSync(path.join(target, 'Jolo'), 'old');
  const source = path.join(root, 'Jolo-linux-arm64');
  mkdirSync(path.join(source, 'resources/app'), { recursive: true });
  writeFileSync(path.join(source, 'Jolo'), 'new');
  writeFileSync(path.join(source, 'resources/app/package.json'), JSON.stringify({ name: 'jolo', version }));
  const archive = path.join(root, 'release.tar.gz');
  expect(Bun.spawnSync(['tar', '-czf', archive, '-C', root, 'Jolo-linux-arm64']).exitCode).toBe(0);
  const bytes = readFileSync(archive);
  const release = { latest: '2.0.0', name: 'jolo-desktop-linux-arm64.tar.gz', sha256: createHash('sha256').update(bytes).digest('hex') };
  const installer = createDesktopInstaller({ appDirectory, execPath: path.join(target, 'Jolo'), userData: root, platform: 'linux', arch: 'arm64', baseUrl: 'http://127.0.0.1', fetchImpl: async () => new Response(corrupt ? 'corrupted' : bytes) });
  return { root, target, installer, release };
}

test('a verified archive is staged beside the app without changing the running installation', async () => {
  const f = archiveFixture();
  const progress = [];
  const prepared = await f.installer.prepare(f.release, received => progress.push(received));
  expect(readFileSync(path.join(f.target, 'Jolo'), 'utf8')).toBe('old');
  expect(readFileSync(path.join(prepared.replacement, 'Jolo'), 'utf8')).toBe('new');
  expect(path.dirname(prepared.stage)).toBe(f.root);
  expect(progress.at(-1)).toBeGreaterThan(0);
  f.installer.discard(prepared);
  expect(existsSync(prepared.stage)).toBe(false);
});

test.each(['checksum', 'version'])('a mismatched %s leaves the existing app intact and no staged replacement', async mismatch => {
  const f = archiveFixture(mismatch === 'checksum' ? { corrupt: true } : { version: '1.0.0' });
  await expect(f.installer.prepare(f.release)).rejects.toThrow(mismatch === 'checksum' ? 'checksum mismatch' : 'does not match');
  expect(readFileSync(path.join(f.target, 'Jolo'), 'utf8')).toBe('old');
  expect(readdirSync(f.root).some(name => name.startsWith('.jolo-update-'))).toBe(false);
});
