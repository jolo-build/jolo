import { expect, test } from 'bun:test';
import { pauseDescription, workspacePath } from '../src/renderer/presentation.js';

test('workspace paths abbreviate the actual home without confusing sibling or outside folders', () => {
  expect(workspacePath('/Users/me/work/jolo', '/Users/me')).toBe('~/work/jolo');
  expect(workspacePath('/Users/me', '/Users/me/')).toBe('~');
  expect(workspacePath('/Users/me-other/work/jolo', '/Users/me')).toBe('/Users/me-other/work/jolo');
  expect(workspacePath('/Users/other/work/jolo', '/Users/me')).toBe('/Users/other/work/jolo');
  expect(workspacePath('/private/tmp/testcode', '/Users/me')).toBe('/private/tmp/testcode');
  expect(workspacePath('/Users/me/work/jolo', null)).toBe('/Users/me/work/jolo');
  expect(workspacePath('C:\\Users\\Me\\work\\jolo', 'c:\\users\\me')).toBe('~/work/jolo');
  expect(workspacePath('C:\\Users\\Me-other', 'C:\\Users\\Me')).toBe('C:\\Users\\Me-other');
});

test('budget pauses explain which limit stopped the task', () => {
  expect(pauseDescription({ pauseReason: 'budget', failure: 'hosted tool deadline reached' })).toBe('Task paused: a tool exceeded its time limit.');
  expect(pauseDescription({ pauseReason: 'budget', failure: 'active time budget reached' })).toContain('task reached its time limit');
  expect(pauseDescription({ pauseReason: 'budget', failure: 'iteration budget reached' })).toContain('task reached its step limit');
  expect(pauseDescription({ pauseReason: 'budget' })).toBe('Task paused: the task reached a limit.');
  expect(pauseDescription({ pauseReason: 'user' })).toBe('Task paused: user');
});
