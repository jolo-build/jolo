import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deterministicArchive } from '../../scripts/archive.js';

test('archives ignore source mtimes and creation order and remain readable by tar', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'jolo-archive-'));
  try {
    for (const name of ['a', 'b']) mkdirSync(path.join(root, name));
    // The pairs mix a string with an array, so spell out the tuple shape the destructuring expects.
    for (const [folder, files] of /** @type {[string, string[]][]} */ ([['a', ['one', 'two']], ['b', ['two', 'one']]])) {
      for (const name of files) writeFileSync(path.join(root, folder, name), name.repeat(200));
    }
    utimesSync(path.join(root, 'b', 'one'), 100, 200);
    await deterministicArchive(path.join(root, 'a'), path.join(root, 'a.tgz'));
    await deterministicArchive(path.join(root, 'b'), path.join(root, 'b.tgz'));
    expect(readFileSync(path.join(root, 'a.tgz'))).toEqual(readFileSync(path.join(root, 'b.tgz')));
    const tar = Bun.spawnSync(['tar', '-xOf', path.join(root, 'a.tgz'), 'one']);
    expect(tar.exitCode).toBe(0);
    expect(tar.stdout.toString()).toBe('one'.repeat(200));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
