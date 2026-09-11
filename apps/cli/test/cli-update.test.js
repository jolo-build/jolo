import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { commandUpdate, detectInstall } from '../src/update.js';
import { EXIT } from '../src/exit-codes.js';

const directories = [];
const temporary = () => { const directory = mkdtempSync(path.join(tmpdir(), 'jolo-cli-update-')); directories.push(directory); return directory; };
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

/** Build the directory layout scripts/install.sh creates, so detection is checked against the real shape. */
function installed({ version = '0.1.0', linked = true, installer = true } = {}) {
  const prefix = temporary();
  const releaseName = `${version}-darwin-arm64-abc123`;
  const releaseDir = path.join(prefix, 'share', 'jolo', 'releases', releaseName);
  mkdirSync(path.join(releaseDir, 'lib'), { recursive: true });
  mkdirSync(path.join(releaseDir, 'bin'), { recursive: true });
  mkdirSync(path.join(prefix, 'bin'), { recursive: true });
  writeFileSync(path.join(releaseDir, 'VERSION'), `${version}\n`);
  writeFileSync(path.join(releaseDir, 'lib', 'jolo.js'), '// bundle\n');
  writeFileSync(path.join(releaseDir, 'bin', 'jolo'), '#!/bin/sh\n');
  if (installer) writeFileSync(path.join(releaseDir, 'lib', 'install.sh'), '#!/usr/bin/env bash\nexit 0\n');
  if (linked) symlinkSync(`../share/jolo/releases/${releaseName}/bin/jolo`, path.join(prefix, 'bin', 'jolo'));
  return { prefix, releaseDir, mainPath: path.join(releaseDir, 'lib', 'jolo.js') };
}

const release = (version = '0.2.0') => ({
  fetchImpl: async url => {
    if (url.endsWith('/latest.txt')) return new Response(`${version}\n`);
    if (url.endsWith('.sha256')) {
      const name = url.slice(url.lastIndexOf('/') + 1, -'.sha256'.length);
      return new Response(`${createHash('sha256').update(name).digest('hex')}  ${name}\n`);
    }
    return new Response('Not found', { status: 404 });
  },
});

function record() {
  const out = [], errors = [];
  return { out, errors, write: line => out.push(line), writeError: line => errors.push(line), text: () => out.join('\n'), errorText: () => errors.join('\n') };
}

function fakeSpawn(exitCode = 0, stderr = '') {
  const calls = [];
  return { calls, spawnImpl: (command, options) => { calls.push({ command, options }); return { exited: Promise.resolve(exitCode), stderr: new Response(stderr).body }; } };
}

test('an installed CLI is recognised through the installer layout, with the active release resolved', () => {
  const { prefix, releaseDir, mainPath } = installed({ version: '0.1.0' });
  expect(detectInstall({ mainPath, build: '0.1.0' })).toEqual({ kind: 'managed', version: '0.1.0', prefix, releaseDir, installer: path.join(releaseDir, 'lib', 'install.sh'), active: true });
});

test('the build stamp reports the running version, with VERSION standing in when there is none', () => {
  // The stamp is compiled into the bundle and is what `jolo --version` prints, so an update
  // must compare against the same thing rather than a file next to it.
  const { mainPath } = installed({ version: '0.1.4', linked: false });
  const install = detectInstall({ mainPath, build: '0.1.0' });
  expect(install.version).toBe('0.1.0');
  expect(install.active).toBe(false);
  // A bundle without its own stamp falls back to what the installer recorded for the directory.
  expect(detectInstall({ mainPath, build: 'dev' }).version).toBe('0.1.4');
});

test('a release without a bundled installer is detected but reports no installer', () => {
  const { mainPath } = installed({ installer: false });
  expect(detectInstall({ mainPath, build: '0.1.0' }).installer).toBe(null);
});

test('source checkouts and hand-placed builds are told how to update instead', () => {
  const checkout = path.join(temporary(), 'apps', 'cli', 'src', 'main.js');
  expect(detectInstall({ mainPath: checkout, build: 'dev' })).toEqual({ kind: 'source', version: 'dev' });
  expect(detectInstall({ mainPath: checkout, build: '0.1.0' })).toEqual({ kind: 'unmanaged', version: '0.1.0' });
});

test('--check reports a newer release without installing anything', async () => {
  const home = temporary();
  const io = record(), spawn = fakeSpawn();
  const code = await commandUpdate({ positional: ['update'], flags: { check: true, home } },
    { build: '0.1.0', install: { kind: 'managed', version: '0.1.0', prefix: '/p', installer: '/p/install.sh', active: true }, ...release(), ...spawn, ...io });
  expect(code).toBe(EXIT.completed);
  expect(io.text()).toBe('Jolo 0.2.0 is available (this is 0.1.0). Run `jolo update` to install it.');
  expect(spawn.calls).toHaveLength(0);
});

test('--check --json reports the same result as a record', async () => {
  const home = temporary();
  const io = record();
  await commandUpdate({ positional: ['update'], flags: { check: true, json: true, home } },
    { build: '0.1.0', install: { kind: 'managed', version: '0.1.0', prefix: '/p', installer: '/p/install.sh', active: true }, ...release(), ...fakeSpawn(), ...io });
  expect(JSON.parse(io.text())).toEqual({ type: 'update.status', current: '0.1.0', latest: '0.2.0', available: true, install: 'managed' });
});

test('an up-to-date install says so and runs no installer', async () => {
  const home = temporary();
  const io = record(), spawn = fakeSpawn();
  const code = await commandUpdate({ positional: ['update'], flags: { home } },
    { build: '0.2.0', install: { kind: 'managed', version: '0.2.0', prefix: '/p', installer: '/p/install.sh', active: true }, ...release(), ...spawn, ...io });
  expect(code).toBe(EXIT.completed);
  expect(io.text()).toBe('Jolo 0.2.0 is up to date.');
  expect(spawn.calls).toHaveLength(0);
});

test('applying runs the installer that shipped with this release, against the same origin', async () => {
  const home = temporary();
  const io = record(), spawn = fakeSpawn();
  const code = await commandUpdate({ positional: ['update'], flags: { home } },
    { build: '0.1.0', install: { kind: 'managed', version: '0.1.0', prefix: '/prefix', installer: '/prefix/install.sh', active: true }, env: { JOLO_UPDATE_BASE_URL: 'https://jolo.build' }, ...release(), ...spawn, ...io });
  expect(code).toBe(EXIT.completed);
  expect(spawn.calls[0].command).toEqual(['/bin/bash', '/prefix/install.sh', '--prefix', '/prefix', '--version', '0.2.0']);
  expect(spawn.calls[0].options.env.JOLO_INSTALL_BASE_URL).toBe('https://jolo.build');
  expect(spawn.calls[0].options.env.JOLO_INSTALL_LAYOUT).toBe('origin');
  expect(io.text()).toContain('Installed Jolo 0.2.0.');
});

test('a named version is installed even when it is not newer, and a malformed one is a usage error', async () => {
  const home = temporary();
  const io = record(), spawn = fakeSpawn();
  // `jolo update 0.1.0` is a deliberate reinstall; parseArgs leaves the value as a positional
  // for both `jolo update 0.1.0` and `jolo update --version 0.1.0`.
  expect(await commandUpdate({ positional: ['update', '0.1.0'], flags: { home } },
    { build: '0.2.0', install: { kind: 'managed', version: '0.2.0', prefix: '/prefix', installer: '/prefix/install.sh', active: true }, ...release(), ...spawn, ...io })).toBe(EXIT.completed);
  expect(spawn.calls[0].command.at(-1)).toBe('0.1.0');

  const bad = record();
  expect(await commandUpdate({ positional: ['update', 'latest'], flags: { home } },
    { build: '0.1.0', install: { kind: 'managed', version: '0.1.0', prefix: '/p', installer: '/p/i.sh', active: true }, ...release(), ...fakeSpawn(), ...bad })).toBe(EXIT.usage);
});

test('a failed installer leaves the reported version unchanged', async () => {
  const home = temporary();
  const io = record(), spawn = fakeSpawn(1);
  const code = await commandUpdate({ positional: ['update'], flags: { home } },
    { build: '0.1.0', install: { kind: 'managed', version: '0.1.0', prefix: '/p', installer: '/p/install.sh', active: true }, ...release(), ...spawn, ...io });
  expect(code).toBe(EXIT.failed);
  expect(io.errorText()).toBe('Update failed; Jolo 0.1.0 is unchanged.');
});

test('a source checkout is told to use Git rather than the installer', async () => {
  const home = temporary();
  const io = record(), spawn = fakeSpawn();
  const code = await commandUpdate({ positional: ['update'], flags: { home } },
    { build: '0.1.0', install: { kind: 'source', version: '0.1.0' }, ...release(), ...spawn, ...io });
  expect(code).toBe(EXIT.failed);
  expect(io.errorText()).toContain('git pull');
  expect(spawn.calls).toHaveLength(0);
});

test('a development build has nothing to compare against and asks the network for nothing', async () => {
  const home = temporary();
  const io = record();
  let requests = 0;
  const code = await commandUpdate({ positional: ['update'], flags: { home } },
    { build: 'dev', install: { kind: 'source', version: 'dev' }, fetchImpl: async () => { requests += 1; return new Response('0.2.0\n'); }, ...fakeSpawn(), ...io });
  expect(code).toBe(EXIT.failed);
  expect(requests).toBe(0);
  expect(io.errorText()).toContain('development build');
});

test('an unreachable release server fails without touching the installation', async () => {
  const home = temporary();
  const io = record(), spawn = fakeSpawn();
  const code = await commandUpdate({ positional: ['update'], flags: { home } },
    { build: '0.1.0', install: { kind: 'managed', version: '0.1.0', prefix: '/p', installer: '/p/install.sh', active: true }, fetchImpl: async () => { throw new Error('offline'); }, ...spawn, ...io });
  expect(code).toBe(EXIT.failed);
  expect(io.errorText()).toContain('Could not check for updates');
  expect(spawn.calls).toHaveLength(0);
});

test('an installation older than self-updating is pointed at the installer command', async () => {
  const home = temporary();
  const io = record(), spawn = fakeSpawn();
  const code = await commandUpdate({ positional: ['update'], flags: { home } },
    { build: '0.1.0', install: { kind: 'managed', version: '0.1.0', prefix: '/p', installer: null, active: true }, ...release(), ...spawn, ...io });
  expect(code).toBe(EXIT.failed);
  expect(io.errorText()).toContain('install.sh');
  expect(spawn.calls).toHaveLength(0);
});

/** An endpoint file as the engine publishes it, naming whichever process should count as the engine. */
function publishEngine(home, pid) {
  const runtimeDir = path.join(home, 'run', 'default');
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(path.join(runtimeDir, 'engine.json'), JSON.stringify({ engineBootId: 'boot-1', build: '0.1.0', pid }));
  writeFileSync(path.join(runtimeDir, 'engine.token'), 'token\n');
}
const managed = { kind: 'managed', version: '0.1.0', prefix: '/p', installer: '/p/install.sh', active: true };

test('a running engine from the previous build is reported as needing a restart', async () => {
  const home = temporary();
  publishEngine(home, process.pid); // this very process stands in for a live engine
  const io = record();
  await commandUpdate({ positional: ['update'], flags: { home } }, { build: '0.1.0', install: managed, ...release(), ...fakeSpawn(), ...io });
  expect(io.text()).toContain('jolo engine stop');
});

test('an endpoint file left behind by a crashed engine does not claim one is running', async () => {
  const home = temporary();
  // The engine removes its endpoint only on a clean exit; after a crash the file names a dead process.
  const gone = Bun.spawn(['true']);
  await gone.exited;
  publishEngine(home, gone.pid);
  const io = record();
  await commandUpdate({ positional: ['update'], flags: { home } }, { build: '0.1.0', install: managed, ...release(), ...fakeSpawn(), ...io });
  expect(io.text()).toBe('Updating Jolo 0.1.0 → 0.2.0…\nInstalled Jolo 0.2.0.');
});

test('a named version is not remembered as the newest release', async () => {
  const home = temporary();
  const cache = path.join(home, 'data', 'default', 'update.json');
  const io = record();
  // A deliberate reinstall of an older version must not hide the real release from the welcome panel.
  await commandUpdate({ positional: ['update', '0.1.0'], flags: { home } }, { build: '0.2.0', install: { ...managed, version: '0.2.0' }, ...release('0.3.0'), ...fakeSpawn(), ...io });
  expect(existsSync(cache)).toBe(false);
  await commandUpdate({ positional: ['update'], flags: { home, check: true } }, { build: '0.2.0', install: { ...managed, version: '0.2.0' }, ...release('0.3.0'), ...fakeSpawn(), ...record() });
  expect(JSON.parse(readFileSync(cache, 'utf8'))).toMatchObject({ current: '0.2.0', latest: '0.3.0', available: true });
});

test('--json drains an installer that writes more than a pipe holds', async () => {
  const home = temporary();
  const installer = path.join(home, 'install.sh');
  // Far more than a pipe buffers: an undrained stdout would leave the child blocked forever.
  writeFileSync(installer, '#!/bin/bash\nhead -c 300000 /dev/zero | tr "\\0" x\necho\nexit 0\n');
  const io = record();
  const code = await commandUpdate({ positional: ['update'], flags: { home, json: true } },
    { build: '0.1.0', install: { ...managed, prefix: home, installer }, ...release(), spawnImpl: Bun.spawn, ...io });
  expect(code).toBe(EXIT.completed);
  expect(JSON.parse(io.text()).type).toBe('update.installed');
});
