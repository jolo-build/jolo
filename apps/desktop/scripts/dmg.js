import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function runCommand(argv) {
  const result = Bun.spawnSync(argv, { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`${argv[0]} failed: ${result.stderr.toString().trim()}`);
}

/** Create and verify a drag-to-Applications image, tolerating transient macOS disk-image locks. */
export async function createDmg(target, file, {
  run = runCommand,
  sleep = ms => Bun.sleep(ms),
  warn = message => console.warn(message),
} = {}) {
  const staging = mkdtempSync(path.join(tmpdir(), 'jolo-dmg-'));
  try {
    run(['ditto', target, path.join(staging, 'Jolo.app')]);
    symlinkSync('/Applications', path.join(staging, 'Applications'));
    const command = ['hdiutil', 'create', '-volname', 'Jolo', '-srcfolder', staging, '-format', 'UDZO', '-fs', 'HFS+', '-ov', file];
    for (let attempt = 1; ; attempt++) {
      try {
        run(command);
        break;
      } catch (error) {
        rmSync(file, { force: true });
        // hdiutil can fail while releasing its temporary volume on CI runners. A fresh image
        // after a short backoff lets macOS finish; other errors still fail the build immediately.
        if (attempt >= 5 || !/resource busy/i.test(error.message ?? String(error))) throw error;
        const delay = 1000 * 2 ** (attempt - 1);
        warn(`[package] hdiutil create: Resource busy (attempt ${attempt}/5); retrying in ${delay / 1000}s`);
        await sleep(delay);
      }
    }
    run(['hdiutil', 'verify', file]);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
