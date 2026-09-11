import { expect, test } from 'bun:test';
import { parseDocument, renderPlain } from '../src/index.js';

const marker = 'visualize{"path":"/workspace/my concept.html","mode":"wide","title":"Mission overview"}';
test('visualizations are structured blocks without consuming adjacent prose', () => {
  const parsed = parseDocument(`Before.\n${marker}\nAfter.`);
  expect(parsed.blocks.map(block => block.type)).toEqual(['paragraph', 'visualization', 'paragraph']);
  expect(parsed.blocks[1]).toEqual({ type: 'visualization', status: 'ready', path: '/workspace/my concept.html', mode: 'wide', title: 'Mission overview' });
  expect(renderPlain(parsed.blocks)).toContain('Visualization: Mission overview');
  expect(renderPlain(parsed.blocks)).not.toContain('');
});
test('streamed references wait for complete JSON and survive cached message parsing', () => {
  const cache = new Map();
  for (let i = 1; i < marker.length; i++) {
    const block = parseDocument(marker.slice(0, i), { cache }).blocks[0];
    expect(block).toEqual({ type: 'visualization', status: 'pending' });
  }
  expect(parseDocument(`${marker}\n\n`, { cache }).blocks[0].status).toBe('ready');
  expect(parseDocument('visualize{\n"path":"relative.html"\n}').blocks[0].path).toBe('relative.html');
});
test('invalid references show a readable fallback; code examples never become previews', () => {
  for (const source of ['null', '{bad}', '{"path":"https://example.com"}', '{"path":"/file.js"}', '{"path":"a\\u0000.html"}']) {
    expect(parseDocument(`visualize${source}`).blocks[0]).toEqual({ type: 'visualization', status: 'invalid' });
  }
  expect(parseDocument(`\`\`\`text\n${marker}\n\`\`\``).blocks[0]).toMatchObject({ type: 'code', text: marker });
  expect(parseDocument(`\`${marker}\``).blocks[0].children[0].type).toBe('code');
  expect(parseDocument(`> ${marker}`).blocks[0].type).toBe('quote');
});
