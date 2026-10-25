import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { CopyButton } from '../src/renderer/components/copy-button.jsx';
import { CopyCodeButton } from '../src/renderer/components/copy-code-button.jsx';

/** The copy icon's path, as Icon draws it; `check` replaces it while the text is copied. */
const COPY_ICON = '<path d="M9 9h12v12H9ZM15 9V3H3v12h6"></path>';

test('a copy button names itself by its label, says what a click does, and shows the copy icon until it copied', () => {
  const html = renderToStaticMarkup(<CopyButton text="hello" label="Copy message" title="Copy message" className="message-copy" />);
  expect(html).toStartWith('<button type="button" class="message-copy" aria-label="Copy message" title="Copy message">');
  expect(html).toContain('width="14" height="14"');
  expect(html).toContain(COPY_ICON);
  expect(html).toContain('<span class="sr-only" aria-live="polite">Copy</span>');
  // Untitled, it says Copy; its size is the caller's.
  const plain = renderToStaticMarkup(<CopyButton text="hello" label="Copy it" size={12} />);
  expect(plain).toStartWith('<button type="button" aria-label="Copy it" title="Copy">');
  expect(plain).toContain('width="12" height="12"');
});

test('a code block’s copy button is the same button, with its class, label and language as before', () => {
  const html = renderToStaticMarkup(<CopyCodeButton text="const x = 1;" language="js" />);
  expect(html).toStartWith('<button type="button" class="md-code-copy" aria-label="Copy code to clipboard" title="Copy js">');
  expect(html).toContain(COPY_ICON);
  expect(renderToStaticMarkup(<CopyCodeButton text="plain" />)).toContain('title="Copy code"');
});
