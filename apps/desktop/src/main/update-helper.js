// Runs from a private staging directory with a copy of the bundled runtime, after Jolo exits.
// No Electron or repository dependencies: this file is also shipped verbatim in the app.
import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function rename(from, to) {
  for (let attempt = 0; ; attempt++) {
    try { renameSync(from, to); return; }
    catch (error) {
      if (attempt >= 39 || !['EBUSY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
      await sleep(250); // Windows may still be releasing Electron's child processes.
    }
  }
}

async function launch(executable, args) {
  if (process.platform === 'darwin') {
    // Launch Services registers the replacement bundle and grants its sandbox extensions.
    const bundle = path.resolve(path.dirname(executable), '..', '..');
    const environment = ['JOLO_HOME', 'JOLO_PROFILE', 'JOLO_UPDATE_BASE_URL'].flatMap(key => process.env[key] ? ['--env', `${key}=${process.env[key]}`] : []);
    await new Promise((resolve, reject) => execFile('/usr/bin/open', ['-n', ...environment, bundle, '--args', ...args], error => error ? reject(error) : resolve(undefined)));
    return null;
  }
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, args, { detached: true, stdio: 'ignore', cwd: path.dirname(executable), env: environment });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  return child;
}

/**
 * @param {{ pid: number, target: string, replacement: string, stage: string, executable: string, version: string, resultFile: string, args?: string[] }} config
 * @param {{ launchImpl?: typeof launch, waitMs?: number }} [options]
 */
export async function applyDesktopUpdate(config, { launchImpl = launch, waitMs = 60_000 } = {}) {
  const { target, replacement, stage, executable, version, resultFile } = config;
  const backup = path.join(stage, 'previous');
  const ready = path.join(stage, 'ready.json');
  let moved = false, installed = false, child = null, exited = false;
  try {
    const deadline = Date.now() + waitMs;
    for (;;) {
      try { process.kill(config.pid, 0); }
      catch (error) { if (error.code === 'ESRCH') break; throw error; }
      if (Date.now() >= deadline) throw new Error('Jolo did not exit; the update was not installed.');
      await sleep(100);
    }
    exited = true;
    await rename(target, backup);
    moved = true;
    await rename(replacement, target);
    installed = true;
    child = await launchImpl(path.join(target, executable), [...(config.args ?? []), `--jolo-update-ready=${ready}`]);
    const startupDeadline = Date.now() + waitMs;
    while (!existsSync(ready)) {
      if (child?.exitCode != null) throw new Error('The updated application exited before startup; the previous version was restored.');
      if (Date.now() >= startupDeadline) throw new Error('The updated application did not start; the previous version was restored.');
      await sleep(100);
    }
    if (JSON.parse(readFileSync(ready, 'utf8')).version !== version) throw new Error('The updated application reported the wrong version.');
    writeFileSync(resultFile, JSON.stringify({ version, installed: true, stage }));
    // The new application's first window loaded successfully. Only now retire the old bundle.
    rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    child?.kill();
    try {
      const started = JSON.parse(readFileSync(path.join(stage, 'started.json'), 'utf8'));
      if (started.version === version && Number.isSafeInteger(started.pid) && started.pid > 0) process.kill(started.pid, 'SIGTERM');
    } catch { /* the new application may have exited before recording its PID */ }
    writeFileSync(resultFile, JSON.stringify({ version, stage, error: String(error.message ?? error) }));
    if (installed) await rename(target, replacement);
    if (moved) await rename(backup, target);
    if (exited && existsSync(target)) await launchImpl(path.join(target, executable), config.args ?? []);
    throw error;
  } finally {
    // If rollback itself failed, retain the backup for recovery instead of removing it.
    if (!existsSync(backup)) {
      try { rmSync(stage, { recursive: true, force: true }); }
      catch { /* On Windows the helper's runtime is locked until it exits; the relaunched app cleans it. */ }
    }
  }
}

/** Called only after the replacement's first window loads. Never accepts an arbitrary write path. */
export function acknowledgeDesktopUpdate({ target, version, argv = process.argv, started = false }) {
  const argument = argv.find(value => value.startsWith('--jolo-update-ready='));
  if (!argument) return;
  const ready = path.resolve(argument.slice('--jolo-update-ready='.length));
  const stage = path.dirname(ready);
  if (path.basename(ready) !== 'ready.json' || !path.basename(stage).startsWith('.jolo-update-') || path.dirname(stage) !== path.dirname(target)) return;
  const config = JSON.parse(readFileSync(path.join(stage, 'update.json'), 'utf8'));
  if (config.target !== target || config.version !== version || config.stage !== stage) return;
  if (started) { writeFileSync(path.join(stage, 'started.json'), JSON.stringify({ version, pid: process.pid })); return; }
  writeFileSync(ready, JSON.stringify({ version }));
  const cleanup = setTimeout(() => {
    if (!existsSync(path.join(stage, 'previous'))) { try { rmSync(stage, { recursive: true, force: true }); } catch { /* next launch retries */ } }
  }, 3000);
  cleanup.unref();
}

if (process.argv[1] && path.basename(process.argv[1]) === 'update-helper.mjs' && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  applyDesktopUpdate(JSON.parse(readFileSync(process.argv[2], 'utf8'))).catch(error => { console.error(error); process.exitCode = 1; });
}
