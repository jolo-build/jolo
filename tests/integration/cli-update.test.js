// `jolo update` end to end: a real installer, a real archive, a real symlink swap.
// The installer is the same script a first install runs, so this also covers the release
// layouts it has to understand.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commandUpdate, detectInstall } from '../../apps/cli/src/update.js';
import { EXIT } from '../../apps/cli/src/exit-codes.js';

const root = path.resolve(import.meta.dir, '../..');
const temporary = mkdtempSync(path.join(os.tmpdir(), 'jolo-update-integration-'));
const archive = `jolo-cli-${process.platform}-${process.arch}.tar.gz`;
const routes = new Map();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let server;
let sequence = 0;
const freshPrefix = () => path.join(temporary, `prefix ${sequence++}`);

/** A release whose archive carries the bundled installer, exactly as scripts/build.js packs it. */
function publish(version) {
  const directory = path.join(temporary, `fixture-${version}`);
  mkdirSync(path.join(directory, 'bin'), { recursive: true });
  mkdirSync(path.join(directory, 'lib'), { recursive: true });
  writeFileSync(path.join(directory, 'bin/jolo'), readFileSync(path.join(root, 'scripts/cli-launcher.sh')));
  writeFileSync(path.join(directory, 'lib/bun'), '#!/bin/sh\nexec /bin/sh "$@"\n');
  writeFileSync(path.join(directory, 'lib/jolo.js'), `#!/bin/sh\nprintf 'jolo ${version}\\n'\n`);
  writeFileSync(path.join(directory, 'lib/engine.js'), '// fixture\n');
  // The archive ships the installer so an installed release can update itself without the network.
  writeFileSync(path.join(directory, 'lib/install.sh'), readFileSync(path.join(root, 'scripts/install.sh')));
  writeFileSync(path.join(directory, 'VERSION'), `${version}\n`);
  for (const file of ['bin/jolo', 'lib/bun', 'lib/install.sh']) chmodSync(path.join(directory, file), 0o755);
  const tarball = path.join(temporary, `archive-${version}.tar.gz`);
  const result = Bun.spawnSync(['tar', '-czf', tarball, '-C', directory, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' }, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  const bytes = readFileSync(tarball);
  const checksum = `${hash(bytes)}  ${archive}\n`;
  // The same release, addressable through both layouts the installer understands.
  routes.set(`/releases/${version}/${archive}`, bytes);
  routes.set(`/releases/${version}/${archive}.sha256`, checksum);
  routes.set(`/releases/download/v${version}/${archive}`, bytes);
  routes.set(`/releases/download/v${version}/${archive}.sha256`, checksum);
}

const origin = () => `http://127.0.0.1:${server.port}`;
const installed = prefix => readlinkSync(path.join(prefix, 'bin/jolo'));
const reportedVersion = prefix => Bun.spawnSync([path.join(prefix, 'bin/jolo'), '--version']).stdout.toString().trim();
const releaseDirOf = prefix => path.resolve(path.join(prefix, 'bin'), installed(prefix), '..', '..');

async function install(prefix, version, extraEnv = {}) {
  const child = Bun.spawn(['/bin/bash', path.join(root, 'scripts/install.sh'), '--prefix', prefix, '--version', version], {
    cwd: temporary, env: { ...process.env, JOLO_INSTALL_BASE_URL: origin(), ...extraEnv }, stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stdout, stderr };
}

function collect() {
  const out = [], errors = [];
  return { out, errors, write: line => out.push(line), writeError: line => errors.push(line), text: () => out.join('\n'), errorText: () => errors.join('\n') };
}

beforeAll(() => {
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const pathname = new URL(request.url).pathname;
    const bytes = routes.get(pathname);
    return bytes === undefined ? new Response('Not found', { status: 404 }) : new Response(bytes);
  } });
  publish('1.0.0');
  publish('1.1.0');
  routes.set('/releases/latest.txt', '1.1.0\n');
  routes.set('/releases/latest/download/latest.txt', '1.1.0\n');
});
afterAll(() => { server?.stop(true); rmSync(temporary, { recursive: true, force: true }); });

test('an installed release is detected, updated, and left switchable back to the previous one', async () => {
  const prefix = freshPrefix();
  const home = path.join(temporary, `home-${sequence++}`);
  expect((await install(prefix, '1.0.0')).code).toBe(0);
  expect(reportedVersion(prefix)).toBe('jolo 1.0.0');

  const releaseDir = releaseDirOf(prefix);
  const install100 = detectInstall({ mainPath: path.join(releaseDir, 'lib', 'jolo.js'), build: '1.0.0' });
  expect(install100).toMatchObject({ kind: 'managed', version: '1.0.0', prefix, active: true });
  expect(install100.installer).toBe(path.join(releaseDir, 'lib', 'install.sh'));

  const io = collect();
  const code = await commandUpdate({ positional: ['update'], flags: { home } },
    { build: '1.0.0', install: install100, env: { ...process.env, JOLO_UPDATE_BASE_URL: origin() }, ...io });
  expect(code, io.errorText()).toBe(EXIT.completed);
  expect(io.text()).toContain('Installed Jolo 1.1.0.');

  // The launcher now resolves to the new release, and running it proves the swap took effect.
  expect(installed(prefix)).toStartWith('../share/jolo/releases/1.1.0-');
  expect(reportedVersion(prefix)).toBe('jolo 1.1.0');
  // The previous release stays on disk so anything still running out of it keeps working.
  const releases = readdirSync(path.join(prefix, 'share/jolo/releases'));
  expect(releases.filter(name => name.startsWith('1.0.0-'))).toHaveLength(1);
  expect(releases.filter(name => name.startsWith('1.1.0-'))).toHaveLength(1);
  expect(existsSync(path.join(prefix, 'share/jolo/.install-lock'))).toBe(false);
});

test('an update that cannot be downloaded leaves the working installation alone', async () => {
  const prefix = freshPrefix();
  const home = path.join(temporary, `home-${sequence++}`);
  expect((await install(prefix, '1.0.0')).code).toBe(0);
  const releaseDir = releaseDirOf(prefix);
  const before = installed(prefix);

  const io = collect();
  const code = await commandUpdate({ positional: ['update', '9.9.9'], flags: { home } },
    { build: '1.0.0', install: detectInstall({ mainPath: path.join(releaseDir, 'lib', 'jolo.js'), build: '1.0.0' }), env: { ...process.env, JOLO_UPDATE_BASE_URL: origin() }, ...io });
  expect(code).toBe(EXIT.failed);
  expect(io.errorText()).toContain('unchanged');
  expect(installed(prefix)).toBe(before);
  expect(reportedVersion(prefix)).toBe('jolo 1.0.0');
});

test('the installer resolves and installs through the GitHub release layout', async () => {
  const prefix = freshPrefix();
  // GitHub addresses assets by tag; the installer is told which layout to use, so the same
  // script serves the website origin and a GitHub release without guessing.
  const child = Bun.spawn(['/bin/bash', path.join(root, 'scripts/install.sh'), '--prefix', prefix], {
    cwd: temporary, env: { ...process.env, JOLO_INSTALL_BASE_URL: origin(), JOLO_INSTALL_LAYOUT: 'github' }, stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code, stderr).toBe(0);
  expect(stdout).toContain('Installed Jolo 1.1.0');
  expect(reportedVersion(prefix)).toBe('jolo 1.1.0');
});

test('an unknown layout is refused rather than guessed', async () => {
  const result = await install(freshPrefix(), '1.0.0', { JOLO_INSTALL_LAYOUT: 'gitlab' });
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain('JOLO_INSTALL_LAYOUT');
});
