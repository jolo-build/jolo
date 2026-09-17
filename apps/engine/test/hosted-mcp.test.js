import { expect, test } from 'bun:test';
import { createHostedMcpConfig, hostedMcpConfig, codexMcpArgs, acpMcpServers } from '../src/hosted-mcp.js';
import { SCHEDULE_METHODS } from '../src/scheduler/mcp.js';
import { BrowserBroker } from '../src/browser/broker.js';
import { ENGINE_ENTRY } from '../../../tests/integration/helpers.js';

test('all hosted transports preserve quoted paths and pin the same workspace without a shell', () => {
  const config = hostedMcpConfig({ socketPath: '/tmp/my project/engine.sock', tokenPath: '/tmp/quote" and $literal/token' }, 'ws_fixed', ['schedule', 'search', 'browser']);
  // Called from a test or CLI entry, this must still launch the engine's MCP entry.
  expect(config.args[0]).toBe(ENGINE_ENTRY);
  expect(config.args).toContain('jolo-mcp');
  expect(config.args.at(-1)).toBe('schedule,search,browser');
  expect(config.args.at(-3)).toBe('ws_fixed');
  const codex = codexMcpArgs(config);
  const parsed = /** @type {{ mcp_servers: Record<string, any> }} */ (Bun.TOML.parse([codex[1], codex[3]].join('\n')));
  expect(parsed.mcp_servers.jolo).toEqual(config);
  // Claude receives the same server inline as --mcp-config {"mcpServers":{"jolo":…}}.
  expect(JSON.parse(JSON.stringify({ mcpServers: { jolo: config } })).mcpServers.jolo).toEqual(config);
  expect(acpMcpServers(config)).toEqual([{ name: 'jolo', ...config, env: [] }]);
});

test('browser tools stay configured while workspace hosts attach and disconnect', () => {
  const browser = new BrowserBroker({ storage: { appendEvent() {} }, log: {} });
  const issued = [];
  const config = createHostedMcpConfig({ browser, search: null, paths: { socketPath: '/tmp/sock' }, capabilityTokens: { issue(...args) { issued.push(args); return { tokenPath: '/tmp/token' }; } }, log: {} });
  const conn = { closeHooks: new Set() };
  // Tool support survives a missing host; live routing still checks the workspace.
  const first = config({ id: 'one' }, { id: 'first' });
  expect(first.hasBrowser).toBe(true);
  expect(first.hasSearch).toBe(false);
  expect(first.server.args.at(-1)).toBe('schedule,delegation,browser');
  expect(issued).toEqual([['first', 'one', [...SCHEDULE_METHODS, 'delegation.call', 'browser.call']]]);
  expect(browser.hasBrowser('one')).toBe(false);
  browser.setOpener(conn, ['two']);
  expect(config({ id: 'one' }, { id: 'second' }).hasBrowser).toBe(true);
  expect(browser.hasBrowser('one')).toBe(false);
  browser.setOpener(conn, ['one', 'two']);
  const third = config({ id: 'one' }, { id: 'third' });
  expect(third.hasBrowser).toBe(true);
  expect(third.server.args.at(-1)).toBe('schedule,delegation,browser');
  expect(issued.at(-1)).toEqual(['third', 'one', [...SCHEDULE_METHODS, 'delegation.call', 'browser.call']]);
  browser.setOpener(conn, []);
  expect(config({ id: 'one' }, { id: 'fourth' }).hasBrowser).toBe(true);
  expect(browser.hasBrowser('one')).toBe(false);
  browser.register(conn, { workspaceId: 'one', tabId: 'tab', navigationRevision: 0, operations: ['snapshot'] }, 'grant');
  expect(config({ id: 'one' }, { id: 'fifth' }).hasBrowser).toBe(true);
});

test('a search-capable engine adds the search bridge and warms the index', () => {
  const acquired = [];
  const config = createHostedMcpConfig({
    browser: null, log: {},
    search: { acquire: async (root) => { acquired.push(root); return { release() {} }; } },
    paths: { socketPath: '/tmp/sock' },
    capabilityTokens: { issue: (...args) => ({ tokenPath: '/tmp/token', args }) },
  });
  const hosted = config({ id: 'one', path: '/repo' }, { id: 'run' });
  expect(hosted.hasBrowser).toBe(false);
  expect(hosted.hasSearch).toBe(true);
  expect(hosted.server.args.at(-1)).toBe('schedule,delegation,search');
  expect(acquired).toEqual(['/repo']);
});
