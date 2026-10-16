import { expect, test } from 'bun:test';
import { wordMotion } from '../src/renderer/terminal-keys.js';

const key = (overrides) => ({ type: 'keydown', key: 'ArrowLeft', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...overrides });

test('ctrl and option arrows send emacs word motions on macOS and Linux', () => {
  for (const platform of ['darwin', 'linux']) {
    expect(wordMotion(key({ key: 'ArrowLeft', ctrlKey: true }), platform)).toBe('\u001bb');
    expect(wordMotion(key({ key: 'ArrowRight', ctrlKey: true }), platform)).toBe('\u001bf');
    expect(wordMotion(key({ key: 'ArrowLeft', altKey: true }), platform)).toBe('\u001bb');
    expect(wordMotion(key({ key: 'ArrowRight', altKey: true }), platform)).toBe('\u001bf');
  }
});

test('Windows sends the modified cursor keys PowerShell and Git Bash bind', () => {
  expect(wordMotion(key({ key: 'ArrowLeft', ctrlKey: true }), 'win32')).toBe('\u001b[1;5D');
  expect(wordMotion(key({ key: 'ArrowRight', ctrlKey: true }), 'win32')).toBe('\u001b[1;5C');
  expect(wordMotion(key({ key: 'ArrowLeft', altKey: true }), 'win32')).toBe('\u001b[1;3D');
  expect(wordMotion(key({ key: 'ArrowRight', altKey: true }), 'win32')).toBe('\u001b[1;3C');
});

test('other arrow chords stay with the terminal', () => {
  expect(wordMotion(key({ key: 'ArrowLeft' }))).toBeNull();
  expect(wordMotion(key({ ctrlKey: true, shiftKey: true }))).toBeNull();
  expect(wordMotion(key({ altKey: true, shiftKey: true }))).toBeNull();
  expect(wordMotion(key({ ctrlKey: true, altKey: true }))).toBeNull();
  expect(wordMotion(key({ ctrlKey: true, metaKey: true }))).toBeNull();
  expect(wordMotion(key({ ctrlKey: true, key: 'ArrowUp' }))).toBeNull();
  expect(wordMotion(key({ ctrlKey: true, type: 'keyup' }))).toBeNull();
});
