import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { DESKTOP_TARGETS, TARGETS, validateTag, verifyRelease, publishRelease } from '../../scripts/ci-release.js';

function fixture(version = '1.2.3') {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'jolo-ci-release-'));
  for (const target of TARGETS) {
    const [platform, arch] = target.split('-'), name = `jolo-cli-${target}.tar.gz`, bytes = Buffer.from(`fixture ${target}`);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    writeFileSync(path.join(directory, name), bytes);
    writeFileSync(path.join(directory, `${name}.sha256`), `${sha256}  ${name}\n`);
    writeFileSync(path.join(directory, `manifest-${target}.json`), JSON.stringify({ version, build: version, platform, arch, archive: { name, size: bytes.length, sha256 } }));
  }
  return directory;
}
function desktop(directory, version = '1.2.3') {
  for (const target of DESKTOP_TARGETS) {
    const [platform, arch] = target.split('-'), name = `jolo-desktop-${target}.dmg`, bytes = Buffer.from(`desktop ${target}`);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    writeFileSync(path.join(directory, name), bytes);
    writeFileSync(path.join(directory, `${name}.sha256`), `${sha256}  ${name}\n`);
    writeFileSync(path.join(directory, `manifest-desktop-${target}.json`), JSON.stringify({ version, build: version, platform, arch, archive: { name, size: bytes.length, sha256 } }));
  }
  return directory;
}
const clean = (directory, fn) => { try { return fn(directory); } finally { rmSync(directory, { recursive: true, force: true }); } };

test('tags must match package versions and cannot replace the original website releases', () => {
  expect(validateTag('v1.2.3', '1.2.3', ['0.1.0'])).toBe('1.2.3');
  expect(validateTag('v1.2.3-rc.1', '1.2.3-rc.1')).toBe('1.2.3-rc.1');
  for (const [tag, version] of [['v1.2.4', '1.2.3'], ['1.2.3', '1.2.3'], ['v01.2.3', '01.2.3'], ['v1.2.3;echo', '1.2.3;echo']]) expect(() => validateTag(tag, version)).toThrow();
  expect(() => validateTag('v0.1.0', '0.1.0', ['0.1.0'])).toThrow('immutable');
});

test('all four platform archives and checksums must match their manifests', () => clean(fixture(), directory => {
  expect(verifyRelease(directory, '1.2.3')).toHaveLength(12);
  expect(() => verifyRelease(directory, '1.2.4')).toThrow('mismatch');
  writeFileSync(path.join(directory, 'jolo-cli-linux-arm64.tar.gz'), 'tampered');
  expect(() => verifyRelease(directory, '1.2.3')).toThrow('checksum/size mismatch');
}));

test('missing platform artifacts or extra files prevent publishing', () => {
  clean(fixture(), directory => {
    rmSync(path.join(directory, 'manifest-linux-arm64.json'));
    expect(() => verifyRelease(directory, '1.2.3')).toThrow();
  });
  clean(fixture(), directory => {
    writeFileSync(path.join(directory, 'unverified.zip'), 'extra');
    expect(() => verifyRelease(directory, '1.2.3')).toThrow('exactly the verified packages');
  });
});

test('desktop bundles publish as a complete set alongside the CLI, or not at all', () => {
  clean(desktop(fixture()), directory => {
    // Four CLI platforms plus both macOS desktop bundles, each with a checksum and a manifest.
    expect(verifyRelease(directory, '1.2.3')).toHaveLength(18);
    writeFileSync(path.join(directory, 'jolo-desktop-darwin-x64.dmg'), 'tampered');
    expect(() => verifyRelease(directory, '1.2.3')).toThrow('checksum/size mismatch');
  });
  clean(desktop(fixture()), directory => {
    // One architecture missing must fail: an updater would otherwise see a release
    // that has a build for some Macs and not others.
    for (const name of ['jolo-desktop-darwin-x64.dmg', 'jolo-desktop-darwin-x64.dmg.sha256', 'manifest-desktop-darwin-x64.json']) rmSync(path.join(directory, name));
    expect(() => verifyRelease(directory, '1.2.3')).toThrow();
  });
});

test.each(['1.2.3', '1.2.3-rc.1'])('publish %s uploads to a draft before making it public', version => clean(fixture(version), directory => {
  const calls = [];
  publishRelease(directory, { version, repo: 'jolo-build/jolo', ghImpl(args) { calls.push(args); return args[0] === 'api' ? null : ''; } });
  const commands = calls.filter(args => args[0] === 'release');
  expect(commands.map(args => args[1])).toEqual(['create', 'upload', 'edit']);
  expect(commands[0]).toContain('--draft');
  expect(commands[0]).toContain('--verify-tag');
  expect(commands[1].filter(arg => arg.endsWith('.tar.gz'))).toHaveLength(4);
  expect(commands[2]).toContain('--draft=false');
  expect(commands[2]).toContain(version.includes('-') ? '--latest=false' : '--latest=true');
  expect(readFileSync(path.join(directory, 'latest.txt'), 'utf8')).toBe(`${version}\n`);
}));

test('a failed upload leaves the release as a draft', () => clean(fixture(), directory => {
  const calls = [];
  expect(() => publishRelease(directory, { version: '1.2.3', repo: 'jolo-build/jolo', ghImpl(args) {
    calls.push(args);
    if (args[1] === 'upload') throw new Error('upload interrupted');
    return args[0] === 'api' ? null : '';
  } })).toThrow('upload interrupted');
  expect(calls.some(args => args.includes('--draft=false'))).toBe(false);
}));

test('a published release cannot be overwritten and an older tag cannot replace latest', () => {
  clean(fixture(), directory => expect(() => publishRelease(directory, { version: '1.2.3', repo: 'jolo-build/jolo', ghImpl: () => JSON.stringify({ draft: false }) })).toThrow('already published'));
  clean(fixture(), directory => expect(() => publishRelease(directory, { version: '1.2.3', repo: 'jolo-build/jolo', ghImpl: args => args[1].endsWith('/latest') ? JSON.stringify({ tag_name: 'v2.0.0' }) : null })).toThrow('must be newer'));
});
