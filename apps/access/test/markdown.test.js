import { expect, test } from 'bun:test';
import { renderMarkdown } from '../src/tasks/markdown.js';

test('renders task Markdown using safe fixed tags', () => {
  const html = renderMarkdown('# Plan\n\n**Ship** *today* with `tests`.\n\n- [x] Ready\n- [ ] Deploy\n\n```js\nconst x = "<script>";\n```\n\n[Guide](https://example.com)\n\n| A | B |\n| --- | --- |\n| 1 | 2 |');
  expect(html).toContain('<h1>Plan</h1>');
  expect(html).toContain('<strong>Ship</strong>');
  expect(html).toContain('<em>today</em>');
  expect(html).toContain('<code>tests</code>');
  expect(html).toContain('disabled checked');
  expect(html).toContain('&lt;script&gt;');
  expect(html).toContain('href="https://example.com/"');
  expect(html).toContain('<table>');
});
test('raw HTML and dangerous links cannot execute', () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)>\n\n[bad](javascript:alert) [data](data:text/html,test)');
  expect(html).not.toContain('<img');
  expect(html).not.toContain('href="javascript:');
  expect(html).not.toContain('href="data:');
  expect(html).toContain('&lt;img');
});
