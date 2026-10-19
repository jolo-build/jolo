import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { diffSummary, fileHeaders, isFileHeader } from '../src/renderer/diff-lines.js';
import { DiffLines } from '../src/renderer/components/diff-lines.jsx';
import SyntaxDiff from '../src/renderer/components/syntax-diff.jsx';

const one = 'diff --git a/docs/NOTES.md b/docs/NOTES.md\nindex 1..2 100644\n--- a/docs/NOTES.md\n+++ b/docs/NOTES.md\n@@ -1 +1,2 @@\n line\n+third';
const two = 'diff --git a/notes.txt b/notes.txt\nindex 1..2 100644\n--- a/notes.txt\n+++ b/notes.txt\n@@ -1 +1 @@\n--- old rule\n+new\n' +
  'diff --git a/gone.txt b/gone.txt\ndeleted file mode 100644\n--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye';

test('git file headers are recognised; changed lines and other notes about a file are not', () => {
  for (const line of ['diff --git a/x b/x', 'index 1..2 100644', '--- a/x', '+++ b/x', 'new file mode 100644', 'deleted file mode 100644', 'similarity index 90%']) expect(isFileHeader(line)).toBe(true);
  for (const line of ['@@ -1 +1 @@', '+added', '-removed', ' context', 'rename from x', 'Binary file x changed', '\\ No newline at end of file', 'old mode 100644']) expect(isFileHeader(line)).toBe(false);
});

test('a one-file diff draws no headers, and a diff of several files names each file once', () => {
  expect([...fileHeaders(one.split('\n'))]).toEqual([[0, null], [1, null], [2, null], [3, null]]);
  expect([...fileHeaders(two.split('\n'))]).toEqual([[0, 'notes.txt'], [1, null], [2, null], [3, null], [7, 'gone.txt'], [8, null], [9, null], [10, null]]);
  expect(diffSummary(one)).toMatchObject({ files: 1, paths: ['docs/NOTES.md'], added: 1, removed: 0 });
});

test('both renderings drop git headers, keep header-like code, and name the files of a multi-file diff', () => {
  for (const markup of [renderToStaticMarkup(<SyntaxDiff text={two} path="" />), renderToStaticMarkup(<DiffLines text={two} />)]) {
    expect(markup).not.toContain('diff --git');
    expect(markup).not.toContain('+++ ');
    expect(markup).toContain('<div class="diff-line meta"><code>notes.txt</code></div>');
    expect(markup).toContain('<div class="diff-line meta"><code>gone.txt</code></div>');
    expect(markup).toContain('--- old rule');
  }
  expect(renderToStaticMarkup(<SyntaxDiff text={one} path="docs/NOTES.md" />)).not.toContain('NOTES.md');
});
