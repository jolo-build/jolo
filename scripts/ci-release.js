// The only publishing entry point is the trusted version-tag workflow. Normal builds only stage files.
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { MAX_RELEASE_BYTES } from './release-assets.js';

export const TARGETS = Object.freeze(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']);
// The desktop application ships for macOS only; Linux desktop support is not validated yet.
export const DESKTOP_TARGETS = Object.freeze(['darwin-arm64', 'darwin-x64']);
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$/;
const root = path.resolve(import.meta.dir, '..');
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const targetsFor = product => product === 'desktop' ? DESKTOP_TARGETS : TARGETS;
const archiveName = (target, product = 'cli') => product === 'desktop' ? `jolo-desktop-${target}.dmg` : `jolo-cli-${target}.tar.gz`;
const manifestName = (target, product = 'cli') => product === 'desktop' ? `manifest-desktop-${target}.json` : `manifest-${target}.json`;

export function validateTag(tag, version, legacyVersions = []) {
  if (!VERSION.test(version) || tag !== `v${version}`) throw new Error('The version tag must exactly match package.json (vMAJOR.MINOR.PATCH, optionally with a prerelease suffix).');
  if (legacyVersions.includes(version)) throw new Error('This version is already served by jolo.build. Bump package.json; existing downloads are immutable.');
  return version;
}
function releaseVersion() {
  return validateTag(process.env.RELEASE_TAG, json(path.join(root, 'package.json')).version, json(path.join(root, 'deploy/cli-releases.json')).releases.map(r => r.version));
}
function verifyArchive(directory, manifest, target, version, product = 'cli') {
  if (!targetsFor(product).includes(target) || `${manifest.platform}-${manifest.arch}` !== target || manifest.version !== version || manifest.build !== version) throw new Error(`Manifest version/build/platform mismatch for ${product} ${target}`);
  const name = archiveName(target, product), asset = manifest.archive;
  if (asset?.name !== name || !/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > MAX_RELEASE_BYTES) throw new Error(`Invalid archive manifest for ${target}`);
  const bytes = readFileSync(path.join(directory, name));
  if (bytes.length !== asset.size || digest(bytes) !== asset.sha256) throw new Error(`Archive checksum/size mismatch for ${target}`);
  if (readFileSync(path.join(directory, `${name}.sha256`), 'utf8') !== `${asset.sha256}  ${name}\n`) throw new Error(`Invalid checksum file for ${target}`);
  return [name, `${name}.sha256`];
}
export function prepareBuild(directory, output, target = `${process.platform}-${process.arch}`, product = 'cli') {
  if (target !== `${process.platform}-${process.arch}`) throw new Error('The runner architecture does not match the intended release target');
  const manifest = json(path.join(directory, 'manifest.json'));
  const files = verifyArchive(directory, manifest, target, json(path.join(root, 'package.json')).version, product);
  mkdirSync(output, { recursive: true });
  for (const file of files) copyFileSync(path.join(directory, file), path.join(output, file));
  copyFileSync(path.join(directory, 'manifest.json'), path.join(output, manifestName(target, product)));
}
/**
 * Every published file is verified before anything is uploaded. The CLI's four platforms are
 * always required. Desktop archives are optional as a set: a release either carries both macOS
 * builds or none, so an updater never sees a release with one architecture missing.
 */
export function verifyRelease(directory, version) {
  if (!VERSION.test(version)) throw new Error('Invalid release version');
  const present = readdirSync(directory);
  const products = ['cli', ...(present.some(name => name.startsWith('jolo-desktop-') || name.startsWith('manifest-desktop-')) ? ['desktop'] : [])];
  const files = products.flatMap(product => targetsFor(product).flatMap(target => {
    const name = manifestName(target, product);
    return [...verifyArchive(directory, json(path.join(directory, name)), target, version, product), name];
  }));
  if (present.sort().join('\n') !== [...files].sort().join('\n')) {
    throw new Error(`Release assets must contain exactly the verified packages, checksums and manifests for ${products.join(' and ')}`);
  }
  return files;
}
function gh(args, allowMissing = false) {
  const result = spawnSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000 });
  if (result.status !== 0) {
    if (allowMissing && result.stderr?.includes('(HTTP 404)')) return null;
    throw new Error(`GitHub release operation failed: ${result.error?.message ?? result.stderr}`);
  }
  return result.stdout;
}
export function publishRelease(directory, { version = releaseVersion(), repo = process.env.GITHUB_REPOSITORY, ghImpl = gh } = {}) {
  const files = verifyRelease(directory, version);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? '')) throw new Error('GITHUB_REPOSITORY is required');
  const tag = `v${version}`, prerelease = version.includes('-');
  const current = ghImpl(['api', `repos/${repo}/releases/tags/${tag}`], true);
  if (current && !JSON.parse(current).draft) throw new Error('This GitHub release is already published; refusing to replace its assets');
  if (!prerelease) {
    const latest = ghImpl(['api', `repos/${repo}/releases/latest`], true);
    if (latest) {
      const previous = JSON.parse(latest).tag_name?.replace(/^v/, '');
      if (!VERSION.test(previous ?? '') || previous.includes('-')) throw new Error('Unexpected latest stable release tag');
      const old = previous.split('.').map(BigInt), next = version.split('.').map(BigInt);
      const difference = next.findIndex((value, i) => value !== old[i]);
      if (difference < 0 || next[difference] < old[difference]) throw new Error('A stable release must be newer than the current latest release');
    }
  }
  const desktop = files.some(file => file.startsWith('jolo-desktop-'));
  const notes = path.join(directory, 'release-notes.md');
  writeFileSync(notes, `CLI packages for macOS and Linux (ARM64 and x64), including the pinned Bun runtime and native search.${desktop ? '\n\nDesktop DMG installers for macOS (Apple Silicon and Intel). Open the DMG and drag Jolo to Applications.' : ''}\n\nInstall the CLI only: \`curl -fsSL https://jolo.build/install.sh | bash\`\n\nInstall this CLI version: \`curl -fsSL https://jolo.build/install.sh | bash -s -- --version ${version}\`\n\nUpdate an existing install with \`jolo update\`.${desktop ? ' The desktop application reports a new release in Settings → About.' : ''}\n\nEach archive has a SHA-256 checksum and a platform build manifest.${desktop ? ' Desktop DMGs are ad-hoc signed and have not been notarized.' : ' Desktop apps are not included.'}\n`);
  if (!current) ghImpl(['release', 'create', tag, '--repo', repo, '--verify-tag', '--draft', '--title', `Jolo ${version}`, '--notes-file', notes, ...(prerelease ? ['--prerelease'] : [])]);
  // Published only after every matrix job and every upload succeeded. Failed uploads remain a draft.
  writeFileSync(path.join(directory, 'latest.txt'), `${version}\n`);
  ghImpl(['release', 'upload', tag, '--repo', repo, '--clobber', ...[...files, 'latest.txt'].map(file => path.join(directory, file))]);
  ghImpl(['release', 'edit', tag, '--repo', repo, '--draft=false', `--prerelease=${prerelease}`, `--latest=${!prerelease}`]);
  return `https://github.com/${repo}/releases/tag/${tag}`;
}
if (import.meta.main) {
  const [command, directory, output, ...extra] = process.argv.slice(2);
  try {
    if (command === 'check-tag' && !directory) console.log(`Validated ${releaseVersion()}`);
    else if (command === 'prepare' && directory && output && !extra.length) prepareBuild(path.resolve(directory), path.resolve(output), process.env.RELEASE_TARGET, process.env.RELEASE_PRODUCT ?? 'cli');
    else if (command === 'publish' && directory && !output) console.log(`Published ${publishRelease(path.resolve(directory))}`);
    else throw new Error('Usage: bun scripts/ci-release.js check-tag | prepare BUILD_DIR OUTPUT_DIR | publish ASSET_DIR');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
