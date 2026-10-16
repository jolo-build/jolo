import { expect, test } from 'bun:test';
import { updateChangeCards, fileDiffSections } from '../src/renderer/change-cards.js';
import { numberedDiffLines } from '../src/renderer/diff-lines.js';

test('live edits follow the last touched file, retain revision history, and stay inside their run', () => {
  const run = { id: 'a', state: 'tools', changedPaths: ['a.js', 'b.js'], changeEvents: [
    { diffArtifactId: '1', changes: [{ path: 'a.js' }] },
    { diffArtifactId: '2', changes: [{ path: 'b.js' }] },
    { diffArtifactId: '3', changes: [{ path: 'a.js' }] },
  ] };
  expect(updateChangeCards([], [run])).toEqual([]);
  const cards = updateChangeCards([], [run], { live: true });
  expect(cards[0].files.at(-1)).toMatchObject({ path: 'a.js', diffArtifactIds: ['1', '3'] });
  expect(updateChangeCards([], [{ id: 'other', state: 'tools', changedPaths: [] }], { live: true })).toEqual([]);
});

test('recorded file sections match quoted and absolute paths', () => {
  const section = 'diff --git "a/path with spaces.js" "b/path with spaces.js"\n--- "a/path with spaces.js"\n+++ "b/path with spaces.js"\n@@ -1 +1 @@\n-a\n+b';
  expect(fileDiffSections(section, 'path with spaces.js')).toBe(section);
  expect(fileDiffSections(section, 'other.js')).toBe('');
  const external = 'diff --git a//else/file b//else/file\n--- a//else/file\n+++ b//else/file\n+new';
  expect(fileDiffSections(external, '/else/file')).toBe(external);
});

test('diff gutters count each side and reset for distant hunks without numbering metadata', () => {
  const lines = numberedDiffLines('--- a/x\n+++ b/x\n@@ -32,2 +32,3 @@\n-old\n+new\n+extra\n same\n@@ -80 +81 @@\n-a\n+b\n\\ No newline at end of file');
  expect(lines.slice(3,7).map(({ before, after }) => [before, after])).toEqual([[32,null],[null,32],[null,33],[33,34]]);
  expect(lines[8]).toMatchObject({ before:80, after:null });
  expect(lines[9]).toMatchObject({ before:null, after:81 });
  expect(lines[0].before).toBeNull(); expect(lines.at(-1).after).toBeNull();
});

test('artifact cache deduplicates concurrent reads and decodes Unicode across RPC chunks', async () => {
  const { readEditArtifact } = await import('../src/renderer/chat-edits.js');
  const previous = globalThis.window;
  let reads = 0;
  const source = new TextEncoder().encode('diff with Gödel and 日本語');
  globalThis.window = /** @type {any} */ ({ jolo: { call: async (_method, { offset }) => {
    reads++;
    const bytes = source.slice(offset, offset + 12);
    return { ok: true, result: { text: Buffer.from(bytes).toString('base64'), bytes: bytes.length, eof: offset + bytes.length >= source.length } };
  } } });
  try {
    const a = readEditArtifact('unicode-test'), b = readEditArtifact('unicode-test');
    expect(a).toBe(b);
    expect((await a).text).toBe('diff with Gödel and 日本語');
    const count = reads;
    await readEditArtifact('unicode-test');
    expect(reads).toBe(count);
  } finally { globalThis.window = previous; }
});
