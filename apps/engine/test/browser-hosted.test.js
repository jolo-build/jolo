import { expect, test } from 'bun:test';
import { browserMcpConfig, codexBrowserArgs, acpBrowserServers, browserPreview, createBrowserConfig } from '../src/browser/hosted.js';
import { BrowserBroker } from '../src/browser/broker.js';
import { applicationInstructions } from '../src/agent/instructions.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { parseParams, BROWSER_OPERATIONS } from '@jolo/protocol';

test('browser availability is scoped and sampled per run before issuing credentials', () => {
  const browser = new BrowserBroker({ storage: { appendEvent() {} }, log: {} });
  const issued = [];
  const config = createBrowserConfig({ browser, paths: { socketPath: '/tmp/sock' }, capabilityTokens: { issue(...args) { issued.push(args); return { tokenPath: '/tmp/token' }; } } });
  const conn = { closeHooks: new Set() };
  expect(config({ id: 'one' }, { id: 'first' })).toBeNull();
  browser.setOpener(conn, ['two']);
  expect(config({ id: 'one' }, { id: 'second' })).toBeNull();
  expect(issued).toEqual([]);
  browser.setOpener(conn, ['one', 'two']);
  expect(config({ id: 'one' }, { id: 'third' }).args).toContain('browser-mcp');
  expect(issued).toEqual([['third', 'one', ['browser.call']]]);
  browser.setOpener(conn, []);
  expect(config({ id: 'one' }, { id: 'fourth' })).toBeNull();
  browser.register(conn, { workspaceId: 'one', tabId: 'tab', navigationRevision: 0, operations: ['snapshot'] }, 'grant');
  expect(config({ id: 'one' }, { id: 'fifth' })).not.toBeNull();
  expect(issued).toHaveLength(2);
});

test('native browser guidance follows the declared tool set', () => {
  const registry = new ToolRegistry();
  for (const browserAvailable of [false, true, false]) {
    const tools = registry.declarations({ browserAvailable });
    const instructions = applicationInstructions({ workspaceRoot: '/repo', toolNames: tools.map(tool => tool.name) });
    expect(instructions.includes('Call browser_open')).toBe(browserAvailable);
    expect(instructions.includes('browser_navigate')).toBe(browserAvailable);
  }
});

test('hosted browser configuration preserves literal paths and pins the workspace', () => {
  const config = browserMcpConfig({ socketPath: '/tmp/my project/sock', tokenPath: '/tmp/quote" $literal/token' }, 'ws');
  const codex = codexBrowserArgs(config);
  expect(Bun.TOML.parse([codex[1], codex[3]].join('\n')).mcp_servers.jolo_browser).toEqual(config);
  expect(acpBrowserServers(config)).toEqual([{ name: 'jolo_browser', ...config, env: [] }]);
  expect(config.args).toContain('browser-mcp');
  expect(config.args.at(-1)).toBe('ws');
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
