import { expect, test } from 'bun:test';
import { keyStroke, MODIFIER_FLAGS, planPointer, planScroll, planText } from '../src/screen/input.js';

test('key names, printable characters and modifiers become macOS key codes and flags', () => {
  expect(keyStroke('Enter')).toEqual({ code: 36, flags: 0 });
  expect(keyStroke('l', ['Meta'])).toEqual({ code: 37, flags: MODIFIER_FLAGS.Meta });
  expect(keyStroke('Z')).toEqual({ code: 6, flags: MODIFIER_FLAGS.Shift });
  expect(keyStroke('?', ['Control'])).toEqual({ code: 44, flags: MODIFIER_FLAGS.Shift | MODIFIER_FLAGS.Control });
  expect(keyStroke('F5').code).toBe(96);
  expect(keyStroke('ArrowLeft', ['Alt', 'Shift']).flags).toBe(MODIFIER_FLAGS.Alt | MODIFIER_FLAGS.Shift);
  expect(() => keyStroke('é')).toThrow('no key named');
});

test('pointer plans glide visibly to the target, then press with click counts and modifiers', () => {
  const click = planPointer({ action: 'double_click', from: { x: 0, y: 0 }, to: { x: 120, y: 60 }, modifiers: ['Shift'] });
  const moves = click.filter(event => event.type === 5);
  expect(moves.length).toBeGreaterThan(5); // the user sees the cursor travel
  expect(moves.at(-1)).toMatchObject({ x: 120, y: 60 });
  expect(moves.every((event, i) => i === 0 || event.x >= moves[i - 1].x)).toBe(true);
  expect(click.filter(event => event.type !== 5).map(event => [event.type, event.clickState])).toEqual([[1, 1], [2, 1], [1, 2], [2, 2]]);
  expect(click.every(event => event.flags === MODIFIER_FLAGS.Shift)).toBe(true);
  // Without a known starting point the cursor jumps straight to the target.
  expect(planPointer({ action: 'move', to: { x: 5, y: 6 } })).toEqual([{ type: 5, x: 5, y: 6, button: 0, flags: 0, delayMs: 0 }]);
  const right = planPointer({ action: 'right_click', to: { x: 1, y: 1 } });
  expect(right.slice(1).map(event => [event.type, event.button])).toEqual([[3, 1], [4, 1]]);
  const drag = planPointer({ action: 'drag', from: null, to: { x: 10, y: 10 }, dragTo: { x: 110, y: 10 } });
  expect(drag.map(event => event.type).filter((type, i, all) => all.indexOf(type) === i)).toEqual([5, 1, 6, 2]);
  expect(drag.at(-1)).toMatchObject({ type: 2, x: 110, y: 10 });
  expect(() => planPointer({ action: 'drag', to: { x: 1, y: 1 } })).toThrow('destination');
});

test('text is typed in bounded unicode chunks with line breaks and tabs pressed as keys', () => {
  expect(planText('hello\nworld\tok')).toEqual([{ text: 'hello' }, { key: 'Enter' }, { text: 'world' }, { key: 'Tab' }, { text: 'ok' }]);
  expect(planText('a\r\nb')).toEqual([{ text: 'a' }, { key: 'Enter' }, { text: 'b' }]);
  const long = planText('x'.repeat(40));
  expect(long.map(step => step.text.length)).toEqual([16, 16, 8]);
  expect(planText('😀漢字').map(step => step.text).join('')).toBe('😀漢字');
});

test('scroll deltas become bounded wheel steps with CoreGraphics signs', () => {
  const down = planScroll(0, 250);
  expect(down).toHaveLength(3);
  expect(down.every(step => step.vertical === -83 && step.horizontal === 0)).toBe(true);
  expect(planScroll(-120, 0)).toEqual([{ vertical: 0, horizontal: 60 }, { vertical: 0, horizontal: 60 }]);
  expect(planScroll(0, 0)).toEqual([{ vertical: 0, horizontal: 0 }]);
});
