import { expect, test } from 'bun:test';
import { refreshesSessions } from '../src/renderer/use-engine.js';

test('a session event or a finished run refreshes the sessions list, a process activity snapshot does not', () => {
  expect(refreshesSessions({ type: 'session.updated', payload: {} })).toBe(true);
  expect(refreshesSessions({ type: 'run.state', payload: { state: 'completed' } })).toBe(true);
  expect(refreshesSessions({ type: 'run.state', payload: { state: 'running' } })).toBe(false);
  expect(refreshesSessions({ type: 'session.activity', payload: { state: 'background', tasks: [], truncated: false, updatedAt: '2026-10-24T10:00:00.000Z' } })).toBe(false);
});
