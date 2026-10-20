import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { FilePreview } from '../src/renderer/components/file-preview.jsx';
import { highlightStyle, SYNTAX } from '../src/renderer/components/code-editor.jsx';
import { FileTree } from '../src/renderer/components/file-tree.jsx';
import { PanelItemTabs } from '../src/renderer/components/panel-item-tabs.jsx';

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

test('the filter says it also searches inside the files', () => {
  const tree = renderToStaticMarkup(<FileTree call={async () => ({ entries: [] })} workspaceId="workspace" onOpen={() => {}} />);
  expect(tree).toContain('placeholder="Filter, or ? to search in files"');
});

test('a file tab wears its file type badge; other tabs keep their icon', () => {
  const tabs = [{ id: 'src/app.js', panelType: 'file', path: 'src/app.js', title: 'app.js' }, { id: 'changes', panelType: 'changes', title: 'Changes', icon: 'changes' }];
  const bar = renderToStaticMarkup(<PanelItemTabs label="Panel tabs" paneId="pane-1" tabs={tabs} activeId="src/app.js" onSelect={() => {}} onClose={() => {}} newControl={null} />);
  expect(bar).toContain('<span class="file-badge script" aria-hidden="true">JS</span><span>app.js</span>');
  expect(bar).toContain('aria-label="Changes"');
  expect(bar.match(/file-badge/g)).toHaveLength(1);
});

test('every file in the Files panel can expand it, and the button says how to come back', () => {
  const image = { path: 'docs/shot.png', kind: 'image', url: 'jolo-file://shot' };
  const collapsed = renderToStaticMarkup(<FilePreview file={image} onClose={null} onExpand={() => {}} />);
  expect(collapsed).toContain('aria-label="Expand panel" aria-pressed="false"');
  const restored = renderToStaticMarkup(<FilePreview file={image} onClose={null} expanded onExpand={() => {}} />);
  expect(restored).toContain('aria-label="Restore panel" aria-pressed="true" title="Restore (Esc)"');
  expect(renderToStaticMarkup(<FilePreview file={image} onClose={null} />)).not.toContain('file-heading'); // a chat preview elsewhere stays bare
});
