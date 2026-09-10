// Update metadata only. Installation and execution happen in separate validation jobs.
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repository = 'https://github.com/microsoft/tgrep';
const api = 'https://api.github.com/repos/microsoft/tgrep/releases';
export const targets = Object.freeze({
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'linux-x64': 'x86_64-unknown-linux-musl',
});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const validVersion = value => typeof value === 'string' && value.length < 64 && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function validatePin(pin) {
  if (!pin || pin.repository !== repository || !validVersion(pin.version) ||
      !pin.assets || Object.keys(pin.assets).length !== Object.keys(targets).length ||
      Object.entries(targets).some(([platform, target]) => pin.assets[platform]?.target !== target || !validHash(pin.assets[platform]?.sha256)))
    throw new Error('Invalid tgrep release pin.');
}

function newer(a, b) {
  const left = a.split('.').map(BigInt), right = b.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i];
  return false;
}

async function bytes(response, limit) {
  if (!response.ok) throw new Error(`tgrep release request failed: HTTP ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty tgrep release response.');
  const chunks = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) { await reader.cancel(); throw new Error('tgrep release response exceeds size limit.'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function checkRelease(pin, { fetchImpl = fetch, token, verify = false } = {}) {
  validatePin(pin);
  // The token is used only on api.github.com, never on archive/CDN downloads.
  const response = await fetchImpl(verify ? `${api}/tags/v${pin.version}` : `${api}/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    redirect: 'error', signal: AbortSignal.timeout(30_000),
  });
  const release = JSON.parse((await bytes(response, 2 * 1024 * 1024)).toString());
  const version = typeof release.tag_name === 'string' && release.tag_name.startsWith('v') ? release.tag_name.slice(1) : null;
  if (!validVersion(version) || release.draft !== false || release.prerelease !== false)
    throw new Error('Expected a stable tgrep release with a vMAJOR.MINOR.PATCH tag.');
  if (verify && version !== pin.version) throw new Error('Pinned release tag does not match GitHub metadata.');
  if (!verify && version === pin.version) return { changed: false, pin };
  if (!verify && !newer(version, pin.version)) throw new Error('Refusing to downgrade the tgrep pin.');
  if (!Array.isArray(release.assets)) throw new Error('Missing tgrep release assets.');
  const asset = name => {
    const matches = release.assets.filter(item => item.name === name);
    const url = `${repository}/releases/download/v${version}/${name}`;
    if (matches.length !== 1 || matches[0].browser_download_url !== url || !/^sha256:[a-f0-9]{64}$/.test(matches[0].digest ?? ''))
      throw new Error(`Missing or invalid release asset: ${name}`);
    return matches[0];
  };
  const download = async (item, limit) => {
    if (!Number.isSafeInteger(item.size) || item.size <= 0 || item.size > limit) throw new Error(`Invalid asset size: ${item.name}`);
    const content = await bytes(await fetchImpl(item.browser_download_url, { signal: AbortSignal.timeout(60_000) }), limit);
    if (content.length !== item.size || `sha256:${hash(content)}` !== item.digest) throw new Error(`Asset digest mismatch: ${item.name}`);
    return content;
  };
  const checksums = (await download(asset('checksums.txt'), 64 * 1024)).toString();
  const sums = new Map();
  for (const line of checksums.trim().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})\s+\*?([^\s/]+)$/.exec(line);
    if (!match || sums.has(match[2])) throw new Error('Malformed or duplicate tgrep checksum entry.');
    sums.set(match[2], match[1]);
  }
  const next = { version, repository, assets: {} };
  // Verify every supported archive before allowing any metadata to change.
  for (const [platform, target] of Object.entries(targets)) {
    const name = `tgrep-v${version}-${target}.tar.gz`;
    const item = asset(name), checksum = sums.get(name);
    if (!validHash(checksum) || item.digest !== `sha256:${checksum}`) throw new Error(`Published checksums disagree: ${name}`);
    await download(item, 64 * 1024 * 1024);
    if (verify && checksum !== pin.assets[platform].sha256) throw new Error(`Pinned checksum changed: ${platform}`);
    next.assets[platform] = { target, sha256: checksum };
  }
  return { changed: !verify, pin: next };
}

export async function updateFile(file, options = {}) {
  const result = await checkRelease(JSON.parse(readFileSync(file, 'utf8')), options);
  if (result.changed) {
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(result.pin, null, 2) + '\n', { flag: 'wx' });
      renameSync(temporary, file);
    } finally { rmSync(temporary, { force: true }); }
  }
  return result;
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.some(arg => arg !== '--verify') || args.length > 1) throw new Error('Usage: bun scripts/update-tgrep.js [--verify]');
    const result = await updateFile(fileURLToPath(new URL('../vendor/tgrep/release.json', import.meta.url)), { token: process.env.GH_TOKEN, verify: args.includes('--verify') });
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `changed=${result.changed}\nversion=${result.pin.version}\n`);
    console.log(result.changed ? `Updated tgrep to v${result.pin.version}; all four archive checksums verified.` : args.includes('--verify') ? `Verified all four archives for pinned tgrep v${result.pin.version}.` : `tgrep v${result.pin.version} is already current.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
