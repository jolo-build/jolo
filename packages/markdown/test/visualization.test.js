import { expect, test } from 'bun:test';
import { parseDocument, renderPlain, segment } from '../src/index.js';

const marker = 'visualize{"path":"/workspace/my concept.html","mode":"wide","title":"Mission overview"}';
const plainMarker = 'visualize{"path":"/Users/test/Library/Application Support/jolo/default/chats/chat-example/proposal-assessment.html","mode":"wide","title":"Proposal assessment"}';
test('delimiter-free agent output renders a visualization and preserves adjacent prose', () => {
  const parsed = parseDocument(`Before.\n${plainMarker}\nAfter.`);
  expect(parsed.blocks.map(block => block.type)).toEqual(['paragraph', 'visualization', 'paragraph']);
  expect(parsed.blocks[1]).toEqual({ type: 'visualization', status: 'ready', path: '/Users/test/Library/Application Support/jolo/default/chats/chat-example/proposal-assessment.html', mode: 'wide', title: 'Proposal assessment' });
  expect(renderPlain(parsed.blocks)).toContain('Visualization: Proposal assessment');
  expect(renderPlain(parsed.blocks)).not.toContain('visualize{');
  expect(segment(`${plainMarker}\n\n`).openVisualization).toBe(false);
});
test('delimiter-free JSON streams until its outer object closes', () => {
  const cache = new Map();
  const source = `visualize ${JSON.stringify({ path: '/workspace/preview.html', title: 'A } brace, "quote" and \\ slash', extra: { nested: [{ key: 'value' }] } }, null, 2).replace('\n', '\n\n')}`;
  for (let i = source.indexOf('{') + 1; i < source.length; i++) {
    expect(parseDocument(source.slice(0, i), { cache }).blocks[0]).toEqual({ type: 'visualization', status: 'pending' });
    expect(segment(source.slice(0, i)).openVisualization).toBe(true);
  }
  const parsed = parseDocument(`${source}\n${marker}\nAfter.\n\n`, { cache });
  expect(parsed.blocks.map(block => block.type)).toEqual(['visualization', 'visualization', 'paragraph']);
  expect(parsed.blocks[0]).toMatchObject({ status: 'ready', path: '/workspace/preview.html', title: 'A } brace, "quote" and \\ slash', mode: 'inline' });
  expect(parsed.open).toBe(false);
});
test('delimiter-free directives retain validation and leave examples and prose alone', () => {
  for (const source of ['{bad}', '{"path":"/file.js"}', '{"path":"a\\u0000.html"}', '{"path":""}', '{"path":"a.html"} trailing', `{"path":"a.html","title":"${'a'.repeat(64 * 1024)}"}`]) {
    expect(parseDocument(`visualize${source}`).blocks[0]).toEqual({ type: 'visualization', status: 'invalid' });
  }
  expect(parseDocument(`\`\`\`text\n${plainMarker}\n\`\`\``).blocks[0]).toMatchObject({ type: 'code', text: plainMarker });
  expect(parseDocument(`\`${plainMarker}\``).blocks[0].children[0].type).toBe('code');
  expect(parseDocument(`> ${plainMarker}`).blocks[0].type).toBe('quote');
  for (const text of ['visualize', 'visualize this data', 'visualizeSomething{}', `Example: ${plainMarker}`]) {
    expect(parseDocument(text).blocks[0].type).toBe('paragraph');
  }
});
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
