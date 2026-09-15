import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { renderMarkdown } from '../src/tui/markdown.js';
import { scrollbackText } from '../src/tui/scrollback.js';
import { builtinTheme } from '../src/themes/palettes.js';

const { Terminal } = createRequire(new URL('../../engine/package.json', import.meta.url))('@xterm/headless');
const plain = text => Bun.stripANSI(scrollbackText(renderMarkdown(text, { width: 38 }).lines, builtinTheme('terminal')));

test('scrollback preserves logical breaks and styles without baking display widths into prose', () => {
  const paragraph = 'A long paragraph with **bold words**, `inline code`, and averylongwordthatcrossesseveraldisplayrowswithoutspaces.';
  expect(plain(paragraph)).toBe('A long paragraph with bold words, inline code, and averylongwordthatcrossesseveraldisplayrowswithoutspaces.\n');
  const item = 'A list item with enough words to continue onto several display rows.';
  expect(plain(`- ${item}\n- Second item\n\nNext paragraph.`)).toBe(`• ${item}\n• Second item\n \nNext paragraph.\n`);
  expect(plain('```js\nconst first = 1;\nconst second = 2;\n```')).toBe('  js\n  const first = 1;\n  const second = 2;\n');
});

test('completed prose fills the new width after repeated zoom changes without adding blank gaps', async () => {
  const terminal = new Terminal({ cols: 80, rows: 30, scrollback: 1000, allowProposedApi: true });
  const paragraph = 'Paragraph text keeps flowing after the font size changes. '.repeat(35).trim();
  try {
    await new Promise(resolve => terminal.write(plain(paragraph).replaceAll('\n', '\r\n'), resolve));
    for (const cols of [120, 45, 160, 60, 80]) {
      terminal.resize(cols, 30);
      const rows = Array.from({ length: terminal.buffer.active.length }, (_, i) => terminal.buffer.active.getLine(i));
      const content = rows.filter(row => row.translateToString(true));
      expect(content.map(row => row.translateToString(false)).join('').trimEnd()).toBe(paragraph);
      expect(content).toHaveLength(Math.ceil(paragraph.length / cols));
      for (const row of content.slice(1)) expect(row.isWrapped).toBe(true);
    }
  } finally { terminal.dispose(); }
});
