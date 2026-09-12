import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareDevinMcp } from '../src/agents/devin-mcp.js';

test('Devin gets isolated run credentials while its existing settings and MCP servers are preserved', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'jolo-devin-test-'));
  mkdirSync(path.join(root, 'devin'));
  const settings = '{"theme_mode":"dark","mcpServers":{"legacy":{"command":"legacy"}}}';
  const mcp = '{"mcpServers":{"existing":{"command":"existing"},"jolo_browser":{"command":"stale"}}}';
  writeFileSync(path.join(root, 'devin/config.json'), settings);
  writeFileSync(path.join(root, 'devin/mcp_config.json'), mcp);
  const env = { XDG_CONFIG_HOME: root, PATH: '/bin' };
  const servers = [{ name: 'jolo_browser', command: 'bun', args: ['browser-mcp', '--token-file', '/run/one'], env: [] }];
  let first, second;
  try {
    first = prepareDevinMcp(env, servers, { platform: 'darwin', temporaryRoot: root });
    second = prepareDevinMcp(env, [{ ...servers[0], args: ['browser-mcp', '--token-file', '/run/two'] }], { platform: 'darwin', temporaryRoot: root });
    expect(first.env.XDG_CONFIG_HOME).not.toBe(second.env.XDG_CONFIG_HOME);
    const read = run => JSON.parse(readFileSync(path.join(run.env.XDG_CONFIG_HOME, 'devin/mcp_config.json'), 'utf8'));
    expect(read(first).mcpServers).toEqual({ legacy: { command: 'legacy' }, existing: { command: 'existing' }, jolo_browser: { command: 'bun', args: servers[0].args, env: {} } });
    expect(read(second).mcpServers.jolo_browser.args.at(-1)).toBe('/run/two');
    expect(JSON.parse(readFileSync(path.join(first.env.XDG_CONFIG_HOME, 'devin/config.json'), 'utf8'))).toEqual({ theme_mode: 'dark' });
    expect(readFileSync(path.join(root, 'devin/config.json'), 'utf8')).toBe(settings);
    expect(readFileSync(path.join(root, 'devin/mcp_config.json'), 'utf8')).toBe(mcp);
    expect(env.XDG_CONFIG_HOME).toBe(root);
    if (process.platform !== 'win32') expect(statSync(path.join(first.env.XDG_CONFIG_HOME, 'devin/mcp_config.json')).mode & 0o777).toBe(0o600);
    const directory = first.env.XDG_CONFIG_HOME;
    first.dispose();
    expect(existsSync(directory)).toBe(false);
    expect(existsSync(second.env.XDG_CONFIG_HOME)).toBe(true);
  } finally { first?.dispose(); second?.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test('missing config is supported and malformed config is never silently replaced', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'jolo-devin-test-'));
  try {
    const run = prepareDevinMcp({ XDG_CONFIG_HOME: root }, [], { platform: 'linux', temporaryRoot: root });
    run.dispose();
    mkdirSync(path.join(root, 'devin'));
    writeFileSync(path.join(root, 'devin/config.json'), '{invalid');
    expect(() => prepareDevinMcp({ XDG_CONFIG_HOME: root }, [], { platform: 'linux', temporaryRoot: root })).toThrow('Could not read Devin configuration');
    expect(readFileSync(path.join(root, 'devin/config.json'), 'utf8')).toBe('{invalid');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
