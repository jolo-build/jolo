import { spawn, execFile } from 'node:child_process';
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { downloadAsset } from '@jolo/updates';

const exec = promisify(execFile);
const runCommand = async (file, args) => { await exec(file, args, { timeout: 180_000, maxBuffer: 1024 * 1024 }); };

/** The replaceable directory and executable inside an official unpacked desktop archive.
 * @param {string} execPath
 * @param {string} [platform]
 */
export function desktopInstallLayout(execPath, platform = process.platform) {
  const paths = platform === 'win32' ? path.win32 : path;
  const target = platform === 'darwin' ? paths.resolve(paths.dirname(execPath), '..', '..') : paths.dirname(execPath);
  if (platform === 'darwin' && (!target.endsWith('.app') || execPath !== paths.join(target, 'Contents', 'MacOS', 'Jolo'))) throw new Error('This is not an installed Jolo application.');
  if (!['darwin', 'linux', 'win32'].includes(platform)) throw new Error('In-app updates are not supported on this platform.');
  return { target, executable: paths.relative(target, execPath) };
}

/**
 * @param {{ appDirectory: string, execPath: string, userData: string, platform?: string, arch?: string,
 *   baseUrl?: string, fetchImpl?: import('@jolo/updates').FetchLike, run?: typeof runCommand,
 *   beforeInstall?: () => Promise<void>, quit?: () => void, restartArgs?: string[] }} options
 */
export function createDesktopInstaller({ appDirectory, execPath, userData, platform = process.platform, arch = process.arch, baseUrl, fetchImpl, run = runCommand, beforeInstall = async () => {}, quit = () => {}, restartArgs = process.argv.slice(1) }) {
  const { target, executable } = desktopInstallLayout(execPath, platform);
  const resultFile = path.join(userData, 'desktop-update-result.json');

  return {
    async prepare(release, onProgress = (_received, _total) => {}) {
      if (platform === 'darwin' && target.startsWith('/Volumes/')) throw new Error('Move Jolo to Applications before updating.');
      if (lstatSync(target).isSymbolicLink()) throw new Error('Install Jolo in a regular application directory before updating.');
      try { await access(path.dirname(target), constants.W_OK); }
      catch { throw new Error('Jolo cannot replace this installation. Move it to a folder you can write to and try again.'); }
      const bytes = await downloadAsset({ version: release.latest, name: release.name, sha256: release.sha256, baseUrl, fetchImpl, onProgress });
      const stage = mkdtempSync(path.join(path.dirname(target), '.jolo-update-'));
      try {
        const archive = path.join(stage, release.name);
        writeFileSync(archive, bytes);
        const replacement = path.join(stage, platform === 'darwin' ? 'Jolo.app' : 'replacement');
        if (platform === 'darwin') {
          const mount = path.join(stage, 'volume');
          mkdirSync(mount);
          let attached = false;
          try {
            await run('hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, archive]);
            attached = true;
            await run('ditto', [path.join(mount, 'Jolo.app'), replacement]);
          } finally {
            if (attached) await run('hdiutil', ['detach', mount]);
          }
          await run('codesign', ['--verify', '--deep', '--strict', replacement]);
          await run('lipo', ['-verify_arch', arch === 'arm64' ? 'arm64' : 'x86_64', path.join(replacement, executable)]);
        } else {
          const extracted = path.join(stage, 'extracted');
          mkdirSync(extracted);
          const tar = platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
          await run(tar, ['-xf', archive, '-C', extracted]);
          const { renameSync } = await import('node:fs');
          renameSync(path.join(extracted, `Jolo-${platform}-${arch}`), replacement);
        }
        const resources = platform === 'darwin' ? path.join(replacement, 'Contents/Resources/app') : path.join(replacement, 'resources/app');
        const pkg = JSON.parse(readFileSync(path.join(resources, 'package.json'), 'utf8'));
        if (pkg.name !== 'jolo' || pkg.version !== release.latest || !existsSync(path.join(replacement, executable))) throw new Error('The downloaded application does not match the requested Jolo version.');
        copyFileSync(path.join(appDirectory, 'engine', platform === 'win32' ? 'bun.exe' : 'bun'), path.join(stage, platform === 'win32' ? 'runtime.exe' : 'runtime'));
        copyFileSync(path.join(appDirectory, 'update-helper.js'), path.join(stage, 'update-helper.mjs'));
        rmSync(archive);
        return { target, executable, replacement, stage, version: release.latest, resultFile };
      } catch (error) {
        rmSync(stage, { recursive: true, force: true });
        throw error;
      }
    },
    async install(prepared) {
      const config = path.join(prepared.stage, 'update.json');
      writeFileSync(config, JSON.stringify({ ...prepared, pid: process.pid, args: restartArgs.filter(value => !value.startsWith('--jolo-update-ready=')) }));
      // The engine closes its idle/admission gate atomically; active work is never cancelled.
      await beforeInstall();
      const fd = openSync(path.join(userData, 'desktop-update.log'), 'a');
      try {
        const child = spawn(path.join(prepared.stage, platform === 'win32' ? 'runtime.exe' : 'runtime'), [path.join(prepared.stage, 'update-helper.mjs'), config], { detached: true, stdio: ['ignore', fd, fd], cwd: prepared.stage });
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        child.unref();
      } finally { closeSync(fd); }
      quit();
    },
    discard(prepared) { rmSync(prepared.stage, { recursive: true, force: true }); },
    previousError() {
      try {
        const result = JSON.parse(readFileSync(resultFile, 'utf8'));
        rmSync(resultFile);
        if (typeof result.stage === 'string' && path.dirname(result.stage) === path.dirname(target) && path.basename(result.stage).startsWith('.jolo-update-')) {
          const cleanup = setTimeout(() => {
            if (!existsSync(path.join(result.stage, 'previous'))) { try { rmSync(result.stage, { recursive: true, force: true }); } catch { /* installation remains intact */ } }
          }, 3000);
          cleanup.unref();
        }
        return result.error;
      } catch { return undefined; }
    },
  };
}
