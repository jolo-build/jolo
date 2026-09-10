import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dir, '../..');
const temporary = mkdtempSync(path.join(os.tmpdir(), 'jolo-installer-test-'));
const archive = `jolo-cli-${process.platform}-${process.arch}.tar.gz`;
const routes = new Map();
let server;
let sequence = 0;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const freshPrefix = () => path.join(temporary, `install ${sequence++}`);

function fixture(version, { broken = false, symlink = false, checksum = true, corrupt = false, traversal = false } = {}) {
  const directory = path.join(temporary, `fixture-${sequence++}`);
  mkdirSync(path.join(directory, 'bin'), { recursive: true });
  mkdirSync(path.join(directory, 'lib'));
  writeFileSync(path.join(directory, 'bin/jolo'), readFileSync(path.join(root, 'scripts/cli-launcher.sh')));
  // A tiny stand-in for the runtime exercises the real symlink-resolving launcher.
  writeFileSync(path.join(directory, 'lib/bun'), '#!/bin/sh\nexec /bin/sh "$@"\n');
  writeFileSync(path.join(directory, 'lib/jolo.js'), broken ? '#!/bin/sh\nexit 27\n' : `#!/bin/sh\nif [ "$1" = '--version' ]; then printf 'jolo ${version}\\n'; else printf '%s\\n' "$@"; fi\n`);
  writeFileSync(path.join(directory, 'lib/engine.js'), '// fixture\n');
  writeFileSync(path.join(directory, 'VERSION'), `${version}\n`);
  for (const file of ['bin/jolo', 'lib/bun']) chmodSync(path.join(directory, file), 0o755);
  if (symlink) symlinkSync('/tmp/should-not-be-read', path.join(directory, 'lib/unsafe'));
  const tarball = path.join(temporary, `archive-${sequence++}.tar.gz`);
  const result = Bun.spawnSync(['tar', '-czf', tarball, '-C', directory, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' }, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  let bytes = corrupt ? Buffer.from('not an archive') : readFileSync(tarball);
  if (traversal) {
    // A plain ustar header avoids macOS PAX records overriding the test pathname.
    const tar = Buffer.alloc(1536);
    tar.write('../jolo-escape', 0);
    tar.write('0000755\0', 100);
    tar.write('0000000\0', 108);
    tar.write('0000000\0', 116);
    tar.write('00000000000\0', 124);
    tar.write('00000000000\0', 136);
    tar.write('5', 156);
    tar.write('ustar\0', 257);
    tar.write('00', 263);
    tar.fill(32, 148, 156);
    const checksum = tar.subarray(0, 512).reduce((sum, byte) => sum + byte, 0);
    tar.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);
    bytes = Bun.gzipSync(tar);
    writeFileSync(tarball, bytes);
    const listing = Bun.spawnSync(['tar', '-tzf', tarball]);
    expect(listing.exitCode).toBe(0);
    expect(listing.stdout.toString()).toContain('../jolo-escape');
  }
  routes.set(`/releases/${version}/${archive}`, bytes);
  routes.set(`/releases/${version}/${archive}.sha256`, `${checksum ? hash(bytes) : '0'.repeat(64)}  ${archive}\n`);
}

async function install(prefix, args = [], extraEnv = {}) {
  const process = Bun.spawn(['/bin/bash', path.join(root, 'scripts/install.sh'), '--prefix', prefix, ...args], {
    cwd: temporary,
    env: { ...globalThis.process.env, JOLO_INSTALL_BASE_URL: `http://127.0.0.1:${server.port}`, ...extraEnv },
    stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  return { code, stdout, stderr };
}

beforeAll(() => {
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const bytes = routes.get(new URL(request.url).pathname);
    return bytes === undefined ? new Response('Not found', { status: 404 }) : new Response(bytes);
  } });
  fixture('1.0.0'); fixture('1.1.0'); fixture('1.2.0', { checksum: false });
  fixture('1.3.0', { broken: true }); fixture('1.4.0', { symlink: true }); fixture('1.5.0', { corrupt: true });
  fixture('1.6.0', { traversal: true });
  routes.set('/releases/latest.txt', '1.0.0\n');
});
afterAll(() => { server?.stop(true); rmSync(temporary, { recursive: true, force: true }); });

test('installs latest into a path containing spaces and forwards quoted arguments through the symlink', async () => {
  const prefix = freshPrefix();
  const result = await install(prefix);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain('Installed Jolo 1.0.0');
  const executable = path.join(prefix, 'bin/jolo');
  expect(readlinkSync(executable)).toStartWith('../share/jolo/releases/1.0.0-');
  const version = Bun.spawnSync([executable, '--version']);
  expect(version.exitCode).toBe(0);
  expect(version.stdout.toString()).toBe('jolo 1.0.0\n');
  const args = Bun.spawnSync([executable, 'two words', '$(literal)', '*']);
  expect(args.stdout.toString()).toBe('two words\n$(literal)\n*\n');
  expect(existsSync(path.join(prefix, 'share/jolo/.install-lock'))).toBe(false);
});

test('upgrades and reinstalls atomically while retaining the old release', async () => {
  const prefix = freshPrefix();
  expect((await install(prefix)).code).toBe(0);
  const executable = path.join(prefix, 'bin/jolo');
  const previous = readlinkSync(executable);
  const result = await install(prefix, ['--version', 'v1.1.0']);
  expect(result.code, result.stderr).toBe(0);
  expect(readlinkSync(executable)).not.toBe(previous);
  expect(existsSync(path.resolve(prefix, 'bin', previous))).toBe(true);
  expect(Bun.spawnSync([executable, '--version']).stdout.toString()).toBe('jolo 1.1.0\n');
  expect((await install(prefix, ['--version', '1.1.0'])).code).toBe(0);
  expect(readdirSync(path.join(prefix, 'share/jolo/releases')).length).toBe(3);
});

test.each([
  ['1.2.0', 'Checksum mismatch'],
  ['1.3.0', 'could not start'],
  ['1.4.0', 'link or special file'],
  ['1.5.0', 'archive is invalid'],
  ['1.6.0', 'unsafe path'],
  ['9.9.9', 'No downloadable Jolo'],
])('failed release %s preserves a working installation', async (version, message) => {
  const prefix = freshPrefix();
  expect((await install(prefix)).code).toBe(0);
  const executable = path.join(prefix, 'bin/jolo');
  const previous = readlinkSync(executable);
  const result = await install(prefix, ['--version', version]);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain(message);
  expect(readlinkSync(executable)).toBe(previous);
  expect(readdirSync(path.join(prefix, 'share/jolo/releases'))).toHaveLength(1);
  expect(existsSync(path.join(prefix, 'share/jolo/.install-lock'))).toBe(false);
});

test('refuses to overwrite an unrelated executable', async () => {
  const prefix = freshPrefix();
  mkdirSync(path.join(prefix, 'bin'), { recursive: true });
  writeFileSync(path.join(prefix, 'bin/jolo'), 'user-owned executable\n');
  const result = await install(prefix);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain('Refusing to overwrite');
  expect(readFileSync(path.join(prefix, 'bin/jolo'), 'utf8')).toBe('user-owned executable\n');
});

test('respects another installation lock without removing it', async () => {
  const prefix = freshPrefix();
  const lock = path.join(prefix, 'share/jolo/.install-lock');
  mkdirSync(lock, { recursive: true });
  const result = await install(prefix);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain('Another installation is active');
  expect(existsSync(lock)).toBe(true);
  expect(existsSync(path.join(prefix, 'bin/jolo'))).toBe(false);
});

test('rejects malformed versions and remote plain HTTP before writing the prefix', async () => {
  const prefix = freshPrefix();
  expect((await install(prefix, ['--version', '../../escape'])).stderr).toContain('Invalid release version');
  expect((await install(prefix, [], { JOLO_INSTALL_BASE_URL: 'http://example.com' })).stderr).toContain('must use HTTPS');
  expect(existsSync(prefix)).toBe(false);
});

test('rejects an unsupported operating system before downloading', async () => {
  const prefix = freshPrefix();
  const commands = path.join(temporary, 'unsupported-os');
  mkdirSync(commands);
  writeFileSync(path.join(commands, 'uname'), '#!/bin/sh\nprintf "Plan9\\n"\n', { mode: 0o755 });
  const result = await install(prefix, [], { PATH: `${commands}:${process.env.PATH}` });
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain('operating system is not supported');
  expect(existsSync(prefix)).toBe(false);
});
