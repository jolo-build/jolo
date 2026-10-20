import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { FilePreview } from '../src/renderer/components/file-preview.jsx';

test('a project text file offers Edit; a chat preview does not', () => {
  const file = { path: 'src/app.js', kind: 'text', text: 'export const answer = 42;\n', editable: true };
  const editable = renderToStaticMarkup(<FilePreview file={file} onClose={null} onSave={async () => {}} />);
  expect(editable).toContain('aria-label="Edit file"');
  expect(editable).not.toContain('Save file'); // nothing to save until something changes
  const preview = renderToStaticMarkup(<FilePreview file={{ ...file, editable: false }} onClose={null} />);
  expect(preview).not.toContain('Edit file');
});
