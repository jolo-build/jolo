// Local macOS end-to-end fixture: two real app bundles, a verified DMG feed, and isolated data.
// Build first with `bun scripts/build.js`, then run this and use About to update the fixture.
// Alternatively run this script with --apply in a second terminal, then touch the finish file.
// The old fixture includes the new updater; existing public releases still need a manual bootstrap.
import { packager } from '@electron/packager';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createDmg } from './dmg.js';
import { createDesktopInstaller } from '../src/main/desktop-installer.js';

if (process.platform !== 'darwin') throw new Error('This packaged DMG smoke fixture requires macOS.');
if (process.arch !== 'arm64' && process.arch !== 'x64') throw new Error('No desktop release exists for this architecture.');
const arch = process.arch;
const root = path.resolve(import.meta.dir, '../../..');
if (process.argv.includes('--apply')) {
  const fixture = JSON.parse(readFileSync(path.join(root, 'dist/desktop-update-smoke.json'), 'utf8'));
  const executable = path.join(fixture.install, 'Contents/MacOS/Jolo');
  const processes = Bun.spawnSync(['/bin/ps', '-ax', '-o', 'pid=,command='], { stdout: 'pipe' }).stdout.toString();
  const line = processes.split('\n').find(line => line.trim().replace(/^\d+\s+/, '').startsWith(`${executable} `));
  if (!line) throw new Error('The disposable test application is not running.');
  const pid = Number(line.trim().split(/\s/)[0]);
  const name = `jolo-desktop-darwin-${arch}.dmg`;
  const archive = path.join(fixture.smoke, name);
  const sha256 = createHash('sha256').update(readFileSync(archive)).digest('hex');
  process.env.JOLO_HOME = fixture.home;
  const installer = createDesktopInstaller({ appDirectory: path.join(fixture.install, 'Contents/Resources/app'), execPath: executable, userData: fixture.userData, baseUrl: 'http://127.0.0.1', fetchImpl: async () => new Response(Bun.file(archive)), restartArgs: [`--remote-debugging-port=${fixture.port}`, '--force-renderer-accessibility'],
    beforeInstall: async () => {
      const stop = Bun.spawn([process.execPath, path.join(root, 'apps/cli/src/main.js'), 'engine', 'stop', '--home', fixture.home], { stdout: 'inherit', stderr: 'inherit' });
      if (await stop.exited) throw new Error('Test engine did not stop cleanly.');
      process.kill(pid, 'SIGTERM');
    },
  });
  const prepared = await installer.prepare({ latest: fixture.version, name, sha256 });
  await installer.install(prepared);
  console.log('Verified DMG staged; detached installer will swap and relaunch the app after this process exits.');
  process.exit(0);
}
const source = path.join(root, 'dist/desktop-app');
if (!existsSync(path.join(source, 'main.js'))) throw new Error('Run bun scripts/build.js first.');
const smoke = mkdtempSync('/private/tmp/jolo-update-smoke-');
const input = path.join(smoke, 'app');
cpSync(source, input, { recursive: true });
const pkg = JSON.parse(readFileSync(path.join(input, 'package.json'), 'utf8'));
pkg.productName = `Jolo Update Smoke ${path.basename(smoke)}`;
writeFileSync(path.join(input, 'package.json'), JSON.stringify(pkg));
const electronVersion = JSON.parse(readFileSync(path.join(root, 'apps/desktop/package.json'), 'utf8')).devDependencies.electron;
const out = await packager({ dir: input, out: path.join(smoke, 'package'), name: pkg.productName, executableName: 'Jolo', appBundleId: `dev.jolo.desktop.update-smoke.${path.basename(smoke).split('-').at(-1).toLowerCase()}`, electronVersion, platform: 'darwin', arch, asar: false, prune: false, quiet: true });
const bundle = path.join(out[0], `${pkg.productName}.app`);
const run = argv => {
  const result = Bun.spawnSync(argv, { stderr: 'pipe', stdout: 'pipe' });
  if (result.exitCode) throw new Error(result.stderr.toString());
};
run(['codesign', '--force', '--deep', '--sign', '-', bundle]);
const name = `jolo-desktop-darwin-${process.arch}.dmg`;
const archive = path.join(smoke, name);
await createDmg(bundle, archive);
const sha256 = createHash('sha256').update(readFileSync(archive)).digest('hex');
const install = path.join(smoke, 'installed/Jolo.app');
mkdirSync(path.dirname(install));
run(['ditto', bundle, install]);
const oldPackage = path.join(install, 'Contents/Resources/app/package.json');
writeFileSync(oldPackage, JSON.stringify({ ...pkg, version: '0.2.8' }));
for (const key of ['CFBundleShortVersionString', 'CFBundleVersion']) run(['/usr/libexec/PlistBuddy', '-c', `Set :${key} 0.2.8`, path.join(install, 'Contents/Info.plist')]);
run(['codesign', '--force', '--deep', '--sign', '-', install]);
const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
const port = probe.port;
probe.stop(true);
const feed = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  const pathname = new URL(request.url).pathname;
  if (pathname === '/releases/latest.txt') return new Response(`${pkg.version}\n`);
  if (pathname === `/releases/${pkg.version}/${name}.sha256`) return new Response(`${sha256}  ${name}\n`);
  if (pathname === `/releases/${pkg.version}/${name}`) return new Response(Bun.file(archive));
  return new Response('Not found', { status: 404 });
} });
const home = path.join(smoke, 'home');
const userData = path.join(home, 'electron-userdata');
const child = Bun.spawn(['/usr/bin/open', '-n', '--env', `JOLO_HOME=${home}`, '--env', `JOLO_UPDATE_BASE_URL=${feed.url.origin}`, install, '--args', `--remote-debugging-port=${port}`, '--force-renderer-accessibility'], { stdout: 'ignore', stderr: Bun.file(path.join(smoke, 'app.log')) });
const evidence = { smoke, port, install, userData, home, version: pkg.version, pid: child.pid, finish: path.join(smoke, 'finish') };
writeFileSync(path.join(root, 'dist/desktop-update-smoke.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence));
try {
  const deadline = Date.now() + 10 * 60_000;
  while (!existsSync(evidence.finish)) {
    if (Date.now() > deadline) throw new Error('Packaged update smoke timed out.');
    await Bun.sleep(250);
  }
  const result = JSON.parse(readFileSync(path.join(userData, 'desktop-update-result.json'), 'utf8'));
  if (!result.installed || result.version !== pkg.version) throw new Error(`Update did not finish: ${JSON.stringify(result)}`);
  if (JSON.parse(readFileSync(oldPackage, 'utf8')).version !== pkg.version) throw new Error('Installed app version did not change.');
  console.log(`PASS: packaged desktop updated from 0.2.8 to ${pkg.version}, relaunched and acknowledged startup.`);
} finally {
  feed.stop(true);
  if (child.exitCode === null) child.kill();
  const stop = Bun.spawn([process.execPath, path.join(root, 'apps/cli/src/main.js'), 'engine', 'stop', '--cancel', '--home', home], { stdout: 'ignore', stderr: 'ignore' });
  await stop.exited;
  const executable = path.join(install, 'Contents/MacOS/Jolo');
  const processes = Bun.spawnSync(['/bin/ps', '-ax', '-o', 'pid=,command='], { stdout: 'pipe' }).stdout.toString();
  for (const line of processes.split('\n')) {
    if (line.trim().replace(/^\d+\s+/, '').startsWith(`${executable} `)) {
      try { process.kill(Number(line.trim().split(/\s/)[0]), 'SIGTERM'); } catch { /* fixture already exited */ }
    }
  }
  rmSync(userData, { recursive: true, force: true });
}
