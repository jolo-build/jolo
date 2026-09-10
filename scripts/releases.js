import { MAX_RELEASE_BYTES, writeReleaseArchive } from "./release-assets.js";
// Keep immutable release metadata in source and large archives in a local cache.
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dir, '..');
const catalogPath = path.join(root, 'deploy/cli-releases.json');
const cache = path.join(root, '.releases');

const versionPattern = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$/;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const archiveName = release => `jolo-cli-${release.platform}-${release.arch}.tar.gz`;
const archivePath = release => path.join(cache, release.version, archiveName(release));

function validateRelease(release) {
  if (!versionPattern.test(release.version) || !['darwin', 'linux'].includes(release.platform) || !['arm64', 'x64'].includes(release.arch)) throw new Error('Invalid release version or platform.');
  if (!/^[0-9a-f]{64}$/.test(release.sha256) || !Number.isInteger(release.size) || release.size <= 0 || release.size > MAX_RELEASE_BYTES) throw new Error('Release checksum or size is invalid. Release archives must be at most 256 MiB; large archives are streamed from 24 MiB asset parts.');
}

async function readCatalog() {
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  for (const release of catalog.releases) validateRelease(release);
  if (catalog.latest !== null && !catalog.releases.some(release => release.version === catalog.latest)) throw new Error('The latest version has no release.');
  if (!/^https:\/\/[A-Za-z0-9.-]+$/.test(catalog.origin)) throw new Error('The release origin must use HTTPS.');
  return catalog;
}

function verify(bytes, release) {
  if (bytes.length !== release.size || digest(bytes) !== release.sha256) throw new Error(`Checksum or size mismatch: ${release.version}/${archiveName(release)}`);
}

async function cachedArchive(release) {
  let bytes;
  try { bytes = await readFile(archivePath(release)); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Missing release ${release.version}/${archiveName(release)}. Run bun run release:restore before building the website.`);
    throw error;
  }
  verify(bytes, release);
  return bytes;
}

export async function prepareReleaseAssets(output) {
  const catalog = await readCatalog();
  // Verify everything before replacing generated output; never deploy an incomplete catalog.
  for (const release of catalog.releases) await cachedArchive(release);
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  for (const release of catalog.releases) {
    const directory = path.join(output, release.version);
    await mkdir(directory, { recursive: true });
    const name = archiveName(release);
    await writeReleaseArchive(directory, name, await cachedArchive(release), release.sha256);
    await writeFile(path.join(directory, `${name}.sha256`), `${release.sha256}  ${name}\n`);
  }
  if (catalog.latest) await writeFile(path.join(output, 'latest.txt'), `${catalog.latest}\n`);
}

async function stage(directory) {
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
  const release = { version: manifest.version, platform: manifest.platform, arch: manifest.arch, sha256: manifest.archive?.sha256, size: manifest.archive?.size };
  validateRelease(release);
  const name = archiveName(release);
  if (manifest.archive.name !== name) throw new Error('The manifest archive name does not match its platform.');
  const bytes = await readFile(path.join(directory, name));
  verify(bytes, release);
  if ((await readFile(path.join(directory, `${name}.sha256`), 'utf8')) !== `${release.sha256}  ${name}\n`) throw new Error('The archive checksum file does not match the manifest.');
  const catalog = await readCatalog();
  const existing = catalog.releases.find(item => item.version === release.version && archiveName(item) === name);
  if (existing && (existing.sha256 !== release.sha256 || existing.size !== release.size)) throw new Error('This release already exists with different bytes. Bump package.json version before publishing changes.');
  await mkdir(path.dirname(archivePath(release)), { recursive: true });
  await writeFile(archivePath(release), bytes);
  if (!existing) catalog.releases.push(release);
  catalog.latest = release.version;
  await writeFile(`${catalogPath}.tmp`, `${JSON.stringify(catalog, null, 2)}\n`);
  await rename(`${catalogPath}.tmp`, catalogPath);
  console.log(`Staged ${release.version}/${name}. Review deploy/cli-releases.json, then run bun run website:deploy.`);
}

async function restore() {
  const catalog = await readCatalog();
  for (const release of catalog.releases) {
    try { await cachedArchive(release); continue; } catch { /* restore absent or damaged cache */ }
    const url = `${catalog.origin}/releases/${release.version}/${archiveName(release)}`;
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Could not restore ${url}: HTTP ${response.status}`);
    if (Number(response.headers.get('content-length')) > MAX_RELEASE_BYTES) throw new Error('Release download exceeds the asset limit.');
    const bytes = Buffer.from(await response.arrayBuffer());
    verify(bytes, release);
    await mkdir(path.dirname(archivePath(release)), { recursive: true });
    await writeFile(archivePath(release), bytes);
    console.log(`Restored ${release.version}/${archiveName(release)} (SHA-256 verified).`);
  }
}

if (import.meta.main) {
  try {
    const [command, directory, ...extra] = process.argv.slice(2);
    if (command === 'stage' && directory && !extra.length) await stage(path.resolve(directory));
    else if (command === 'restore' && !directory) await restore();
    else throw new Error('Usage: bun scripts/releases.js stage BUILD_DIRECTORY | restore');
  } catch (error) { console.error(`[release] ${error.message}`); process.exitCode = 1; }
}
