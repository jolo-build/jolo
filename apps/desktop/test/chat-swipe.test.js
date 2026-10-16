import { expect, test } from 'bun:test';
import { chatSwipe, railSwipeDirection } from '../src/renderer/chat-swipe.js';
const wheel = (timeStamp, deltaX, deltaY = 0, extra = {}) => ({ timeStamp, deltaX, deltaY, deltaMode: 0, ...extra });

test('one chat per horizontal gesture, including momentum; either direction works', () => {
  const moves = [], receive = chatSwipe(direction => moves.push(direction));
  receive(wheel(0, 30)); receive(wheel(20, 60)); receive(wheel(40, 160)); receive(wheel(200, 20));
  expect(moves).toEqual([1]);
  receive(wheel(600, -50)); receive(wheel(620, -40));
  expect(moves).toEqual([1, -1]);
});

test('vertical scrolling, pinch zoom, modified wheels and protected children never navigate', () => {
  const moves = [], receive = chatSwipe(direction => moves.push(direction));
  receive(wheel(0, 5, 40)); receive(wheel(20, 200, 0));
  receive(wheel(500, 200, 0, { ctrlKey: true })); receive(wheel(510, 200));
  receive(wheel(1000, 200, 0, { shiftKey: true }));
  receive(wheel(2000, 20), false); receive(wheel(2050, 200), true);
  expect(moves).toEqual([]);
});

test('small accidental movements and diagonal scrolls do not navigate', () => {
  const moves = [], receive = chatSwipe(direction => moves.push(direction));
  receive(wheel(0, 10)); receive(wheel(20, 20)); receive(wheel(500, 10));
  receive(wheel(1000, 70, 60)); receive(wheel(1020, 100));
  expect(moves).toEqual([]);
});

import { adjacentRailChat, RailNavigation, ChatNavigation } from '../src/renderer/chat-navigation.js';
const entry = id => ({ session: { id }, rootPath: `/${id}` });
test('history crosses projects, supports forward, truncates on new visits and never wraps', async () => {
  const history = new ChatNavigation(), opened = [];
  const open = async row => { opened.push(row.rootPath); history.visit(row); };
  for (const id of ['a', 'b', 'c']) history.visit(entry(id));
  await history.move(-1, open); await history.move(-1, open);
  expect(await history.move(-1, open)).toBe(false);
  await history.move(1, open);
  expect(opened).toEqual(['/b', '/a', '/b']);
  history.visit(entry('d'));
  expect(await history.move(1, open)).toBe(false);
  expect(history.entries.map(row => row.session.id)).toEqual(['a', 'b', 'd']);
});

test('failed and overlapping navigation cannot advance history', async () => {
  const history = new ChatNavigation();
  history.visit(entry('a')); history.visit(entry('b'));
  await expect(history.move(-1, async () => { throw new Error('unavailable'); })).rejects.toThrow('unavailable');
  expect(history.index).toBe(1);
  let finish = () => {};
  const pending = history.move(-1, () => new Promise(resolve => { finish = () => resolve(null); }));
  expect(await history.move(-1, async () => {})).toBe(false);
  finish(); await pending;
  expect(history.index).toBe(0);
});

test('reload restores the back/forward cursor without discarding forward visits', async () => {
  const history = new ChatNavigation();
  for (const id of ['a', 'b', 'c']) history.visit(entry(id));
  await history.move(-1, async () => {});
  const reloaded = new ChatNavigation(JSON.parse(JSON.stringify(history.snapshot())));
  reloaded.visit(entry('b'));
  expect(reloaded.canMove(-1)).toBe(true);
  expect(reloaded.canMove(1)).toBe(true);
  const opened = [];
  await reloaded.move(1, async row => { opened.push(row.session.id); });
  expect(opened).toEqual(['c']);
  expect(new ChatNavigation({ entries: [null], index: 0 }).canMove(-1)).toBe(false);
});

test('horizontal gestures are claimed before reaching the navigation threshold', () => {
  const moves = [], receive = chatSwipe(direction => moves.push(direction));
  expect(receive(wheel(0, 20))).toBe(true);
  expect(moves).toEqual([]);
  receive(wheel(20, 65));
  expect(moves).toEqual([1]);
});

test('horizontal scroll input also accepts native line and page units', () => {
  const moves = [], receive = chatSwipe(direction => moves.push(direction));
  receive(wheel(0, -6, 0, { deltaMode: 1 }));
  receive(wheel(500, 1, 0, { deltaMode: 2 }));
  expect(moves).toEqual([-1, 1]);
});

test('zero-motion phase events cannot block the following swipe', () => {
  const moves = [], receive = chatSwipe(direction => moves.push(direction));
  receive(wheel(0, 0), false);
  receive(wheel(10, -90));
  expect(moves).toEqual([-1]);
});

test('a quick reverse swipe works after a long gesture, including at the end of history', () => {
  const moves = [], receive = chatSwipe(direction => { moves.push(direction); return direction < 0; });
  receive(wheel(0, 100)); // no forward chat available
  receive(wheel(20, 5000)); // long same-direction tail
  receive(wheel(40, -1)); receive(wheel(60, 2)); // jitter must not unlock
  expect(moves).toEqual([1]);
  receive(wheel(100, -45)); receive(wheel(120, -45)); // deliberate reversal
  expect(moves).toEqual([1, -1]);
  receive(wheel(140, -500));
  expect(moves).toEqual([1, -1]);
  receive(wheel(160, 100));
  expect(moves).toEqual([1, -1, 1]);
});

test('swiping follows all rail chats across projects without requiring visits or wrapping', () => {
  const rows = [
    { sessionId: 'unvisited-chat', rootPath: '/chat', projectId: 'standalone' },
    { sessionId: 'current', rootPath: '/project', projectId: 'project' },
    { sessionId: 'unvisited-task', rootPath: '/other', projectId: 'other' },
  ];
  expect(adjacentRailChat(rows, 'current', -1)).toMatchObject({ session: { id: 'unvisited-chat' }, rootPath: '/chat', historyState: 'open' });
  expect(adjacentRailChat(rows, 'current', 1)).toMatchObject({ session: { id: 'unvisited-task' }, rootPath: '/other' });
  expect(adjacentRailChat(rows, 'unvisited-chat', -1)).toBeNull();
  expect(adjacentRailChat(rows, 'unvisited-task', 1)).toBeNull();
  expect(adjacentRailChat(rows, 'removed-chat', 1)).toBeNull();
  expect(adjacentRailChat([], 'current', 1)).toBeNull();
});

test('physical left moves up and right moves down with either macOS scroll setting', () => {
  expect(railSwipeDirection(-1, false)).toBe(-1);
  expect(railSwipeDirection(1, false)).toBe(1);
  expect(railSwipeDirection(1, true)).toBe(-1);
  expect(railSwipeDirection(-1, true)).toBe(1);
});

test('short deliberate swipes navigate immediately and rearm after a short pause', () => {
  const moves = [], receive = chatSwipe(direction => moves.push(direction));
  receive(wheel(0, 18));
  expect(moves).toEqual([]);
  receive(wheel(16, 20));
  expect(moves).toEqual([1]);
  receive(wheel(220, 38));
  expect(moves).toEqual([1, 1]);
});

test('native gesture starts rearm consecutive swipes without waiting for momentum', () => {
  const moves = [], receive = chatSwipe(direction => moves.push(direction));
  receive.begin(); receive(wheel(0, 40)); receive(wheel(8, 20));
  receive.begin(); receive(wheel(16, 40)); receive(wheel(24, 20));
  receive.begin(); receive(wheel(32, 40));
  expect(moves).toEqual([1, 1, 1]);
});

test('recorded rapid two-finger strokes each navigate before their momentum tails', async () => {
  // Real macOS capture: only the first of four strokes has a native begin.
  // The following strokes interrupt momentum after 109, 50 and 33 ms.
  const trace = await Bun.file(new URL('./fixtures/rapid-trackpad-swipes.json', import.meta.url)).json();
  for (const sign of [1, -1]) {
    const moves = [];
    let at = 0;
    const receive = chatSwipe(direction => moves.push([at, direction]));
    for (const [time, dx, dy] of trace) {
      at = time;
      if (dx === 'begin') receive.begin();
      else receive(wheel(time, dx * sign, dy));
    }
    expect(moves).toEqual([[78437, sign], [78945, sign], [79370, sign], [79787, sign]]);
  }
});

test('coalesced momentum spikes do not count as another swipe', () => {
  const moves = [], receive = chatSwipe(direction => moves.push(direction));
  // Real capture: Chromium combined several decaying packets into a large one.
  for (const [time, dx] of [[81008, 327], [81015, 321], [81023, 314], [81032, 307], [81041, 289], [81072, 1068], [81091, 749], [81124, 706], [81132, 438]]) receive(wheel(time, dx));
  expect(moves).toEqual([1]);
});

test('delayed momentum jitter cannot cascade through the chat rail', () => {
  const moves = [], receive = chatSwipe(direction => moves.push(direction));
  receive(wheel(0, 40));
  for (const [time, dx] of [[8, 90], [16, 70], [24, 48], [32, 30], [80, 8], [88, 7], [96, 5], [104, 9], [112, 6], [120, 3], [170, 6], [178, 5], [186, 4]]) receive(wheel(time, dx));
  expect(moves).toEqual([1]);
});

test('vertical scrolling takes over immediately after a chat swipe', () => {
  const moves = [], receive = chatSwipe(direction => moves.push(direction));
  expect(receive(wheel(0, 40))).toBe(true);
  expect(receive(wheel(40, 2, 24))).toBe(false);
  expect(receive(wheel(48, 1, 40))).toBe(false);
  expect(moves).toEqual([1]);
  // A later horizontal stroke can take ownership back just as quickly.
  expect(receive(wheel(80, 40, 1))).toBe(true);
  expect(moves).toEqual([1, 1]);
});

test('vertical scrolling interrupts continuous swipe momentum without a wheel-event pause', () => {
  for (const delay of [8, 500, 1000, 2000]) {
    for (const sign of [-1, 1]) {
      const moves = [], receive = chatSwipe(direction => moves.push(direction));
      receive(wheel(0, 40 * sign));
      // Momentum keeps arriving until the fingers start scrolling up. There
      // is no 24ms gap, and horizontal drift reverses the old swipe direction.
      for (let time = 8; time < delay; time += 8) receive(wheel(time, 20 * sign));
      for (let step = 0; step < 12; step++) {
        expect(receive(wheel(delay + step * 8, -5 * sign, -30))).toBe(false);
      }
      expect(moves).toEqual([sign]);
    }
  }
});

test('vertical intent overrides a small horizontal start before it can switch chats', () => {
  const moves = [], receive = chatSwipe(direction => moves.push(direction));
  receive(wheel(0, 12, 1));
  for (let time = 8; time < 80; time += 8) expect(receive(wheel(time, 5, -20))).toBe(false);
  expect(moves).toEqual([]);
});

test('small horizontal momentum cannot turn an immediate vertical scroll into another chat swipe', () => {
  const moves = [], receive = chatSwipe(direction => moves.push(direction));
  receive(wheel(0, 40));
  for (const [time, dx, dy] of [[40, 2, -2], [48, 2, -2], [56, 3, -2], [64, 4, -2], [72, 5, -1], [80, 6, 0], [88, 6, 0], [96, 5, 0], [104, 6, 0]]) {
    receive(wheel(time, dx, dy));
  }
  expect(receive(wheel(112, 1, 24))).toBe(false);
  expect(receive(wheel(120, 0, 40))).toBe(false);
  expect(moves).toEqual([1]);
});

test('opposite vertical packets use travelled distance and cannot cancel into a horizontal swipe', () => {
  const moves = [], receive = chatSwipe(direction => moves.push(direction));
  for (let time = 0; time < 120; time += 8) receive(wheel(time, 3, time % 16 ? -5 : 5));
  expect(moves).toEqual([]);
});

test('swipes during loading are retained and coalesced toward the requested rail destination', async () => {
  const navigation = new RailNavigation(), rows = ['a', 'b', 'c', 'd'].map(sessionId => ({ sessionId })), opened = [];
  let finish = () => {};
  const open = async row => {
    opened.push(row.session.id);
    if (row.session.id === 'b') await new Promise(resolve => { finish = () => resolve(null); });
  };
  const fail = error => { throw error; };
  navigation.move(rows, 'a', 1, open, fail);
  navigation.move(rows, 'a', 1, open, fail);
  navigation.move(rows, 'a', 1, open, fail);
  expect(navigation.target.session.id).toBe('d');
  expect(navigation.move(rows, 'a', 1, open, fail)).toBe(false);
  finish(); await navigation.settled;
  expect(opened).toEqual(['b', 'd']);
  expect(navigation.running).toBe(false);
  expect(navigation.target).toBeNull();
});
