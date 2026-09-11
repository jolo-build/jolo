import { expect, test } from 'bun:test';
import { searchMcpConfig, codexSearchArgs, claudeSearchArgs, acpSearchServers } from '../src/search/hosted.js';
import { ENGINE_ENTRY } from '../../../tests/integration/helpers.js';

test('all hosted transports preserve quoted paths and pin the same workspace without a shell', () => {
  const config = searchMcpConfig({ socketPath: '/tmp/my project/engine.sock', tokenPath: '/tmp/quote" and $literal/token' }, 'ws_fixed', true);
  // Called from a test or CLI entry, this must still launch the engine's MCP entry.
  expect(config.args[0]).toBe(ENGINE_ENTRY);
  const codex = codexSearchArgs(config);
  const parsed = Bun.TOML.parse([codex[1], codex[3]].join('\n'));
  expect(parsed.mcp_servers.jolo_search).toEqual(config);
  expect(JSON.parse(claudeSearchArgs(config)[1]).mcpServers.jolo_search).toEqual(config);
  expect(acpSearchServers(config)).toEqual([{ name: 'jolo_search', ...config, env: [] }]);
  expect(config.args.at(-1)).toBe('ws_fixed');
});

test('disabled integration leaves every hosted transport unconfigured', () => {
  const disabled = searchMcpConfig({}, 'ws', false);
  expect(disabled).toBeNull();
  expect(codexSearchArgs(disabled)).toEqual([]);
  expect(claudeSearchArgs(disabled)).toEqual([]);
  expect(acpSearchServers(disabled)).toEqual([]);
});
