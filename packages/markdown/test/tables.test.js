import { expect, test } from 'bun:test';
import { parseDocument, renderPlain } from '../src/index.js';
import { reviewTable } from './fixtures/review-table.js';

const table = text => parseDocument(text).blocks.find(block => block.type === 'table');
const cellText = nodes => nodes.map(node => node.text ?? cellText(node.children)).join('');

test('the reported escaped regex remains code inside a three-column review table', () => {
  const result = table(reviewTable);
  expect(result.header).toHaveLength(3);
  expect(result.rows).toHaveLength(9);
  for (const row of result.rows) expect(row).toHaveLength(3);
  expect(result.rows[5][2]).toContainEqual({ type: 'code', text: '/exceed|limit/i' });
  expect(cellText(result.rows[5][2])).toBe("Agree, plus Claude's extension: /exceed|limit/i on arbitrary thrown messages can misclassify other errors as non-retryable limit. Set category in sse.js.");
  expect(renderPlain([result])).toContain('`/exceed|limit/i`');
});

test('table pipes may be escaped in text or contained in matching code delimiters', () => {
  for (const [source, expected] of [
    ['a\\|b', 'a|b'],
    ['`a\\|b`', 'a|b'],
    ['`a|b`', 'a|b'],
    ['``a`|b``', 'a`|b'],
    ['**a\\|b**', 'a|b'],
    ['[a\\|b](https://example.com)', 'a|b'],
  ]) {
    const result = table(`| A | B |\n| --- | --- |\n| ${source} | last |`);
    expect(result.rows[0]).toHaveLength(2);
    expect(cellText(result.rows[0][0])).toBe(expected);
    expect(cellText(result.rows[0][1])).toBe('last');
  }
});

test('backslash parity and escaped trailing pipes do not lose content', () => {
  const result = table('| A | B |\n| --- | --- |\n| left\\\\| right |\n| left | tail\\|\n| left | |');
  expect(result.rows.map(row => row.map(cellText))).toEqual([['left\\', 'right'], ['left', 'tail|'], ['left', '']]);
  const code = table('| A | B |\n| --- | --- |\n| `a\\\\|b` | last |');
  expect(code.rows[0][0]).toEqual([{ type: 'code', text: 'a\\\\|b' }]);
});

test('unfinished code and streamed rows do not swallow later columns', () => {
  const source = '| A | B | C |\n| --- | --- | --- |\n| first | `unfinished | last |';
  const partial = table(source);
  expect(partial.rows[0].map(cellText)).toEqual(['first', '`unfinished', 'last']);
  const complete = table(source.replace('`unfinished | last', '`unfinished | complete` | last'));
  expect(complete.rows[0].map(cellText)).toEqual(['first', 'unfinished | complete', 'last']);
});

test('table body rows match the header width and separator alignment', () => {
  const result = table('| A | B | C |\n| :--- | :---: | ---: |\n| one |\n| one | two | three | extra |');
  expect(result.align).toEqual(['left', 'center', 'right']);
  expect(result.rows.map(row => row.map(cellText))).toEqual([['one', '', ''], ['one', 'two', 'three']]);
  expect(table('| A | B |\n| --- |\n| one | two |')).toBeUndefined();
});
