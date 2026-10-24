import { expect, test } from 'bun:test';
import { TYPE_STEP_MS, TYPE_TOTAL_MS, titleSteps, typedLength } from '../src/renderer/typed-title.js';

test('a title types in code points: an emoji or a Chinese character is one step', () => {
  expect(titleSteps('Fix login')).toEqual(['F', 'i', 'x', ' ', 'l', 'o', 'g', 'i', 'n']);
  expect(titleSteps('Ship 🚀 it')).toEqual(['S', 'h', 'i', 'p', ' ', '🚀', ' ', 'i', 't']);
  expect(titleSteps('修复登录')).toEqual(['修', '复', '登', '录']);
  expect(titleSteps('')).toEqual([]);
});

test('a short title shows one more character every 28 ms, the first at once', () => {
  expect([TYPE_STEP_MS, TYPE_TOTAL_MS]).toEqual([28, 1200]);
  expect(typedLength('Fix login', 0)).toBe(1);
  expect(typedLength('Fix login', 27)).toBe(1);
  expect(typedLength('Fix login', 28)).toBe(2);
  expect(typedLength('Fix login', 28 * 4)).toBe(5);
  expect(typedLength('Fix login', 28 * 8)).toBe(9);
  expect(typedLength('Fix login', 5_000)).toBe(9);
  expect(typedLength('Ship 🚀 it', 28 * 5)).toBe(6); // the rocket is one step, never half of one
});

test('a long title steps faster, so it is finished within 1.2 s whatever its length', () => {
  const long = 'x'.repeat(200);
  expect(typedLength(long, 0)).toBe(1);
  expect(typedLength(long, 600)).toBeGreaterThan(90);
  expect(typedLength(long, 600)).toBeLessThan(200);
  expect(typedLength(long, TYPE_TOTAL_MS)).toBe(200);
  expect(typedLength('y'.repeat(43), TYPE_TOTAL_MS)).toBe(43); // just past where 28 ms a step would run over
});

test('an empty title has nothing to type', () => {
  expect(typedLength('', 0)).toBe(0);
  expect(typedLength('', 5_000)).toBe(0);
});
