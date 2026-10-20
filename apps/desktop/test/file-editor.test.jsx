import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { FilePreview } from '../src/renderer/components/file-preview.jsx';
import { highlightStyle, SYNTAX } from '../src/renderer/components/code-editor.jsx';

test('a project text file offers Edit; a chat preview does not', () => {
  const file = { path: 'src/app.js', kind: 'text', text: 'export const answer = 42;\n', editable: true };
  const editable = renderToStaticMarkup(<FilePreview file={file} onClose={null} onSave={async () => {}} />);
  expect(editable).toContain('aria-label="Edit file"');
  expect(editable).not.toContain('Save file'); // nothing to save until something changes
  const preview = renderToStaticMarkup(<FilePreview file={{ ...file, editable: false }} onClose={null} />);
  expect(preview).not.toContain('Edit file');
});

test('a project file heading is a breadcrumb whose folders show themselves in the tree', () => {
  const file = { path: 'apps/access/package.json', kind: 'text', text: '{}\n', editable: true };
  const heading = renderToStaticMarkup(<FilePreview file={file} onClose={null} onSave={async () => {}} onReveal={() => {}} />);
  expect(heading).toContain('<code class="file-crumbs" title="apps/access/package.json">');
  expect(heading).toContain('title="Show apps/access in the tree">access</button>');
  expect(heading).toContain('/</span>package.json</code>');
  // Without a tree to show them in, the heading stays the file's name.
  expect(renderToStaticMarkup(<FilePreview file={file} onClose={null} onSave={async () => {}} />)).toContain('title="apps/access/package.json">package.json</code>');
});

test('the source editor finds every highlighting tag it colours', () => {
  // The tags are looked up by name in CodeMirror's default style; a renamed or missing one would silently lose its colour.
  expect(highlightStyle.specs.map(spec => [spec.tag].flat().length)).toEqual(SYNTAX.map(([names]) => names.length));
});
