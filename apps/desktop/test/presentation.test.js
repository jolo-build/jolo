import { expect, test } from 'bun:test';
import { everyLabel, pauseDescription, screenshotArtifactId, untilLabel, workspacePath } from '../src/renderer/presentation.js';

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

test('schedule intervals spell themselves the way the CLI does', () => {
  expect(everyLabel(60_000)).toBe('1m');
  expect(everyLabel(900_000)).toBe('15m');
  expect(everyLabel(3_600_000)).toBe('1h');
  expect(everyLabel(14_400_000)).toBe('4h');
  expect(everyLabel(86_400_000)).toBe('1d');
  expect(everyLabel(604_800_000)).toBe('7d');
  expect(everyLabel(90_000)).toBe('90s');
});

test('a schedule’s next beat reads as a relative wait', () => {
  expect(untilLabel(new Date(Date.now() + 12 * 60_000).toISOString())).toBe('in 12m');
  expect(untilLabel(new Date(Date.now() + 3 * 3_600_000).toISOString())).toBe('in 3h');
  expect(untilLabel(new Date(Date.now() + 3 * 86_400_000).toISOString())).toBe('in 3d');
  expect(untilLabel(new Date(Date.now() - 1_000).toISOString())).toBe('due');
  expect(untilLabel('not a date')).toBe('');
});

test('a hosted screenshot call reports its artifact under any bridge prefix', () => {
  const result = '{"ok":true,"mimeType":"image/png","artifactId":"art_1"}';
  for (const head of ['browser_screenshot', 'jolo/browser_screenshot', 'mcp__jolo__browser_screenshot', 'mcp__jolo_browser__browser_screenshot']) {
    expect(screenshotArtifactId(`${head} {"tabId":"t1"}\n${result}`)).toBe('art_1');
  }
  expect(screenshotArtifactId(`other/tool {}\n${result}`)).toBeNull();
  expect(screenshotArtifactId('browser_screenshot {}\n{"ok":true,"mimeType":"text/plain"}')).toBeNull();
  expect(screenshotArtifactId('browser_screenshot {}\nnot json')).toBeNull();
});

test('budget pauses explain which limit stopped the task', () => {
  expect(pauseDescription({ pauseReason: 'budget', failure: 'hosted tool deadline reached' })).toBe('Task paused: a tool exceeded its time limit.');
  expect(pauseDescription({ pauseReason: 'budget', failure: 'active time budget reached' })).toContain('task reached its time limit');
  expect(pauseDescription({ pauseReason: 'budget', failure: 'iteration budget reached' })).toContain('task reached its step limit');
  expect(pauseDescription({ pauseReason: 'budget' })).toBe('Task paused: the task reached a limit.');
  expect(pauseDescription({ pauseReason: 'user' })).toBe('Task paused: user');
});
