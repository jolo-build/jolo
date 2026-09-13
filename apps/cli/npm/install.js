#!/usr/bin/env node
// Postinstall for the jolo-cli npm package: download the platform's release
// archive from GitHub, verify its SHA-256, and unpack it under vendor/jolo.
// The package only carries an installer — the CLI itself ships in the tarball.
'use strict';

const https = require('node:https');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pkg = require('./package.json');
const VERSION = pkg.version;
const BASE = `https://github.com/jolo-build/jolo/releases/download/v${VERSION}`;

function fail(message) {
  console.error(`jolo-cli: ${message}`);
  process.exit(1);
}

function download(url, dest, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        if (!redirects) return reject(new Error('too many redirects'));
        return resolve(download(response.headers.location, dest, redirects - 1));
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`GET ${url} → ${response.statusCode}`));
      }
      const file = require('node:fs').createWriteStream(dest);
      response.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
    }).on('error', reject);
  });
}

async function main() {
  const platform = { darwin: 'darwin', linux: 'linux' }[os.platform()];
  const arch = { arm64: 'arm64', x64: 'x64' }[os.arch()];
  if (!platform || !arch) {
    console.log(`jolo-cli: no Jolo CLI build for ${os.platform()}/${os.arch()} yet — see https://jolo.build for supported platforms.`);
    return;
  }

  const archive = `jolo-cli-${platform}-${arch}.tar.gz`;
  const work = mkdtempSync(path.join(os.tmpdir(), 'jolo-cli-'));
  try {
    const archivePath = path.join(work, archive);
    const checksumPath = `${archivePath}.sha256`;
    process.stdout.write(`jolo-cli: downloading Jolo ${VERSION} for ${platform}-${arch}…\n`);
    await download(`${BASE}/${archive}.sha256`, checksumPath).catch(e => fail(`could not fetch the checksum: ${e.message}`));
    const [expected, name] = readFileSync(checksumPath, 'utf8').trim().split(/\s+/);
    if (!/^[0-9a-f]{64}$/.test(expected ?? '') || name !== archive) fail('the checksum file was invalid.');
    await download(`${BASE}/${archive}`, archivePath).catch(e => fail(`the download failed: ${e.message}`));
    const actual = createHash('sha256').update(readFileSync(archivePath)).digest('hex');
    if (actual !== expected) fail('checksum mismatch — nothing was installed.');

    const vendor = path.join(__dirname, 'vendor', 'jolo');
    rmSync(vendor, { recursive: true, force: true });
    mkdirSync(vendor, { recursive: true });
    execFileSync('tar', ['-xzf', archivePath, '-C', vendor]);
    for (const required of ['bin/jolo', 'lib/bun', 'lib/jolo.js', 'VERSION']) {
      if (!existsSync(path.join(vendor, required))) fail(`the archive was missing ${required}.`);
    }
    const shipped = readFileSync(path.join(vendor, 'VERSION'), 'utf8').trim();
    if (shipped !== VERSION) fail(`archive version ${shipped} does not match package version ${VERSION}.`);
    writeFileSync(path.join(vendor, 'ARCHIVE_SHA256'), `${expected}\n`);
    process.stdout.write(`jolo-cli: installed Jolo ${VERSION}. Run \`jolo\` from a project directory.\n`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch(e => fail(e.message));
