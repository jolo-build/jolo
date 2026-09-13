import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { installCloseShortcuts } from '../src/main/close-shortcuts.js';

function fixture(guest = false) {
  const sent = [];
  let destroyed = false;
  const source = Object.assign(new EventEmitter(), { send: (...args) => sent.push(args), isDestroyed: () => destroyed });
  const target = guest ? { send: (...args) => sent.push(args), isDestroyed: () => destroyed } : source;
  installCloseShortcuts(/** @type {import('electron').WebContents} */ (/** @type {unknown} */ (source)), /** @type {import('electron').WebContents} */ (/** @type {unknown} */ (target)));
  return {
    sent, destroy: () => { destroyed = true; },
    key: (overrides = {}) => {
      let prevented = false;
      source.emit('before-input-event', { preventDefault: () => { prevented = true; } }, { type: 'keyDown', key: 'w', meta: process.platform === 'darwin', control: process.platform !== 'darwin', alt: false, shift: false, isAutoRepeat: false, ...overrides });
      return prevented;
    },
  };
}

test('close shortcut routes host and guest input once instead of closing the native window', () => {
  for (const fromBrowser of [false, true]) {
    const f = fixture(fromBrowser);
    expect(f.key()).toBe(true);
    expect(f.sent).toEqual([['jolo:closeRequest', { fromBrowser }]]);
    expect(f.key({ isAutoRepeat: true })).toBe(true);
    expect(f.sent).toHaveLength(1);
  }
});

test('typing W and other modifier combinations do not trigger close', () => {
  const f = fixture();
  for (const input of [{ type: 'keyUp' }, { meta: false, control: false }, { key: 'q' }, { alt: true }, { shift: true }, { meta: true, control: true }]) expect(f.key(input)).toBe(false);
  expect(f.sent).toEqual([]);
});

test('close suppresses the native accelerator without sending to a destroyed renderer', () => {
  const f = fixture(true);
  f.destroy();
  expect(f.key()).toBe(true);
  expect(f.sent).toEqual([]);
});
