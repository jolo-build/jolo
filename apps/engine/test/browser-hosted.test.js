import { expect, test } from 'bun:test';
import { browserPreview } from '../src/browser/mcp.js';
import { applicationInstructions } from '../src/agent/instructions.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { parseParams, BROWSER_OPERATIONS } from '@jolo/protocol';

test('native browser guidance follows the declared tool set', () => {
  const registry = new ToolRegistry();
  for (const browserAvailable of [false, true, false]) {
    const tools = registry.declarations({ browserAvailable });
    const instructions = applicationInstructions({ workspaceRoot: '/repo', toolNames: tools.map(tool => tool.name) });
    expect(instructions.includes('Call browser_open')).toBe(browserAvailable);
    expect(instructions.includes('browser_navigate')).toBe(browserAvailable);
  }
});

test('the public browser call surface admits only bounded browser operations', () => {
  const registry = new ToolRegistry();
  for (const operation of ['open', 'tabs', ...BROWSER_OPERATIONS]) expect(registry.get(`browser_${operation}`)).toBeDefined();
  expect(parseParams('browser.call', { workspaceId: 'ws', name: 'run_command', arguments: {} }).ok).toBe(false);
  expect(() => registry.validate('browser_navigate', { url: 'file:///etc/passwd' })).toThrow();
  expect(() => registry.validate('browser_scroll', { deltaY: 10001 })).toThrow();
  expect(() => registry.validate('browser_press', { key: 'arbitrary-code' })).toThrow();
  expect(() => registry.validate('browser_fill', { ref: 'e1', text: 'a'.repeat(10001) })).toThrow();
});

test('screenshot previews retain complete artifact metadata under the hosted display limit', () => {
  const preview = browserPreview(JSON.stringify({ ok: true, url: 'https://fixture/' + 'q'.repeat(2000), title: 'x'.repeat(500), artifactId: 'art_image', mimeType: 'image/png', width: 900, height: 700, bytes: 100 }));
  expect(preview.length).toBeLessThan(600);
  expect(JSON.parse(preview)).toMatchObject({ ok: true, artifactId: 'art_image', mimeType: 'image/png' });
  expect(browserPreview('plain tool output')).toBe('plain tool output');
});
