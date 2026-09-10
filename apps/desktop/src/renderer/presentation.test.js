import { expect, test } from 'bun:test';
import { pauseDescription } from './presentation.js';

test('budget pauses explain which limit stopped the task', () => {
  expect(pauseDescription({ pauseReason: 'budget', failure: 'hosted tool deadline reached' })).toBe('Task paused: a tool exceeded its time limit.');
  expect(pauseDescription({ pauseReason: 'budget', failure: 'active time budget reached' })).toContain('task reached its time limit');
  expect(pauseDescription({ pauseReason: 'budget', failure: 'iteration budget reached' })).toContain('task reached its step limit');
  expect(pauseDescription({ pauseReason: 'budget' })).toBe('Task paused: the task reached a limit.');
  expect(pauseDescription({ pauseReason: 'user' })).toBe('Task paused: user');
});
