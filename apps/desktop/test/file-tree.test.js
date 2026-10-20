import { expect, test } from 'bun:test';
import { treeKey } from '../src/renderer/components/file-tree.jsx';

// The rows on screen, top to bottom: "apps" is open, "apps/desktop" is closed.
const rows = [
  { path: 'apps', folder: true, open: true },
  { path: 'apps/desktop', folder: true, open: false },
  { path: 'apps/notes.md', folder: false, open: false },
  { path: 'README.md', folder: false, open: false },
];

test('up and down step between the rows on screen and stop at either end', () => {
  expect(treeKey(rows, 0, 'ArrowDown')).toEqual({ focus: 'apps/desktop' });
  expect(treeKey(rows, 2, 'ArrowUp')).toEqual({ focus: 'apps/desktop' });
  expect(treeKey(rows, 3, 'ArrowDown')).toBeNull();
  expect(treeKey(rows, 0, 'ArrowUp')).toBeNull();
});

test('right opens a closed folder or steps into an open one; left closes it or steps out to its folder', () => {
  expect(treeKey(rows, 1, 'ArrowRight')).toEqual({ toggle: 'apps/desktop' });
  expect(treeKey(rows, 0, 'ArrowRight')).toEqual({ focus: 'apps/desktop' });
  expect(treeKey([{ path: 'empty', folder: true, open: true }, { path: 'next.md', folder: false, open: false }], 0, 'ArrowRight')).toBeNull();
  expect(treeKey(rows, 2, 'ArrowRight')).toBeNull();
  expect(treeKey(rows, 0, 'ArrowLeft')).toEqual({ toggle: 'apps' });
  expect(treeKey(rows, 2, 'ArrowLeft')).toEqual({ focus: 'apps' });
  expect(treeKey(rows, 1, 'ArrowLeft')).toEqual({ focus: 'apps' });
  expect(treeKey(rows, 3, 'ArrowLeft')).toBeNull();
  expect(treeKey(rows, 0, 'Enter')).toBeNull(); // the row's own button opens it
});
