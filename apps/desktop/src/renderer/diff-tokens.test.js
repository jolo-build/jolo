import { expect, test } from 'bun:test';
import { diffTokens, languageForPath } from './diff-tokens.js';

const textOf = nodes => nodes.map(node => typeof node === 'string' ? node : textOf(node.children)).join('');
const kindsOf = nodes => nodes.flatMap(node => typeof node === 'string' ? [] : [...node.kinds, ...kindsOf(node.children)]);
const patch = (path, body) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${body}`;
function checkText(source, path) {
  const lines = diffTokens(source, path);
  expect(lines.map(line => line.prefix + textOf(line.tokens)).join('\n')).toBe(source);
  return lines;
}

test('Python diff highlighting preserves indentation, blank lines, markers, and literal HTML', () => {
  const source = patch('tests/example.py', '@@ -1,3 +1,4 @@\n def example():\n-\treturn 42\n+\tmessage = "<script>alert(1)</script>"\n+\treturn 43\n \n');
  const lines = checkText(source);
  expect(kindsOf(lines.find(line => line.text.includes('def example')).tokens)).toEqual(expect.arrayContaining(['keyword', 'function']));
  expect(kindsOf(lines.find(line => line.kind === 'remove').tokens)).toEqual(expect.arrayContaining(['keyword', 'number']));
  expect(kindsOf(lines.find(line => line.text.includes('<script>')).tokens)).toContain('string');
  expect(lines.filter(line => line.kind === 'meta').every(line => kindsOf(line.tokens).length === 0)).toBe(true);
});

test('old and new hunk sides keep multiline strings separate', () => {
  const source = patch('example.py', '@@ -1,3 +1,3 @@\n-"""old documentation\n-old body\n-"""\n+def current():\n+    # new comment\n+    return 42\n');
  const lines = checkText(source);
  expect(kindsOf(lines.find(line => line.text === '-old body').tokens)).toContain('string');
  expect(kindsOf(lines.find(line => line.text === '+def current():').tokens)).toContain('keyword');
  expect(kindsOf(lines.find(line => line.text === '+    # new comment').tokens)).toContain('comment');
});

test('multi-file patches detect deleted Python, quoted TSX, and YAML separately', () => {
  const source = 'diff --git a/old.py b/old.py\n--- a/old.py\n+++ /dev/null\n@@ -1 +0,0 @@\n-import os\n' +
    'diff --git "a/new view.tsx" "b/new view.tsx"\n--- /dev/null\n+++ "b/new view.tsx"\n@@ -0,0 +1 @@\n+const view = <div title="hi" />;\n' +
    patch('ci.yaml', '@@ -1 +1 @@\n-enabled: false\n+enabled: true\n');
  const lines = checkText(source);
  expect(kindsOf(lines.find(line => line.text === '-import os').tokens)).toContain('keyword');
  expect(kindsOf(lines.find(line => line.text.startsWith('+const view')).tokens)).toContain('tag');
  expect(kindsOf(lines.find(line => line.text === '+enabled: true').tokens)).toContain('boolean');
});

test('hunks reset syntax state and code beginning with plus or minus is not a file header', () => {
  const source = patch('counter.js', '@@ -1 +1 @@\n--- counter;\n+++ counter;\n@@ -50 +50,2 @@\n-/* old\n+const next = 1;\n+// next line\n\\ No newline at end of file\n');
  const lines = checkText(source);
  expect(lines.find(line => line.text === '--- counter;').kind).toBe('remove');
  expect(lines.find(line => line.text === '+++ counter;').kind).toBe('add');
  expect(kindsOf(lines.find(line => line.text === '+const next = 1;').tokens)).toContain('keyword');
  expect(lines.find(line => line.text.startsWith('\\ No newline')).kind).toBe('meta');
});

test('Dockerfiles and shell configuration use known grammars; unknown and oversized diffs stay plain', () => {
  expect(languageForPath('Dockerfile')).toBe('docker');
  expect(languageForPath('build/Dockerfile.prod')).toBe('docker');
  expect(languageForPath('.zshrc')).toBe('bash');
  expect(languageForPath('src/test.PY')).toBe('python');
  expect(languageForPath('README.unknown')).toBeNull();
  const docker = checkText(patch('Dockerfile', '@@ -1 +1 @@\n-FROM alpine:3\n+FROM alpine:4\n'));
  expect(kindsOf(docker.find(line => line.kind === 'add').tokens)).toContain('keyword');
  for (const [path, body] of [['file.unknown', 'const x = 1;'], ['large.js', 'x'.repeat(100_000)]]) {
    const lines = checkText(patch(path, `@@ -0,0 +1 @@\n+${body}\n`));
    expect(kindsOf(lines.find(line => line.kind === 'add').tokens)).toEqual([]);
  }
});

test('Markdown fences retain nested syntax across diff lines', () => {
  const source = patch('README.md', '@@ -0,0 +1,3 @@\n+```js\n+const value = 42;\n+```\n');
  const lines = checkText(source);
  expect(kindsOf(lines.find(line => line.text === '+const value = 42;').tokens)).toContain('keyword');
});
