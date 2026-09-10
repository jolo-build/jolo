// Explicit setup only: application startup never downloads executables.
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import release from '../vendor/tgrep/release.json';

const root = path.resolve(import.meta.dir, '../vendor/tgrep');
const platform = `${process.platform}-${process.arch}`;
const asset = release.assets[platform];
if (!asset) throw new Error(`No bundled tgrep release for ${platform}; install tgrep on PATH or set JOLO_TGREP.`);
const name = `tgrep-v${release.version}-${asset.target}.tar.gz`;
const archiveArg = process.argv.indexOf('--archive');
const archive = archiveArg >= 0 ? await Bun.file(process.argv[archiveArg + 1]).arrayBuffer() : await (async () => {
  const response = await fetch(`${release.repository}/releases/download/v${release.version}/${name}`);
  if (!response.ok) throw new Error(`tgrep download failed: HTTP ${response.status}`);
  return response.arrayBuffer();
})();
if (createHash('sha256').update(new Uint8Array(archive)).digest('hex') !== asset.sha256) throw new Error('tgrep archive checksum mismatch; nothing installed');
const staging = mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'jolo-tgrep-install-'));
try {
  const tar = path.join(staging, name);
  await Bun.write(tar, archive);
  const extracted = Bun.spawnSync(['tar', '-xzf', tar, '-C', staging, './tgrep'], { stdout: 'pipe', stderr: 'pipe' });
  if (extracted.exitCode !== 0) throw new Error(extracted.stderr.toString());
  const directory = path.join(root, platform);
  mkdirSync(directory, { recursive: true });
  const destination = path.join(directory, 'tgrep');
  // Stage beside the destination for an atomic replacement, including across filesystems.
  await Bun.write(`${destination}.tmp`, Bun.file(path.join(staging, 'tgrep')));
  chmodSync(`${destination}.tmp`, 0o755);
  renameSync(`${destination}.tmp`, destination);
  console.log(`Installed tgrep ${release.version}: ${destination}`);
} finally { rmSync(staging, { recursive: true, force: true }); }
