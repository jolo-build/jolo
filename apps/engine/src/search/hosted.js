/** Each hosted transport adds one stdio server; existing vendor MCP configuration remains in force. */
import { existsSync } from 'node:fs';
import path from 'node:path';

export function searchMcpConfig(paths, workspaceId, enabled) {
  if (!enabled) return null;
  // The engine can also be started by `jolo engine serve`; argv[1] is then the CLI, not our entry.
  const entry = [path.join(import.meta.dir, 'engine.js'), path.resolve(import.meta.dir, '../main.js')].find(file => !file.startsWith('/$bunfs/') && existsSync(file));
  const command = entry ? process.execPath : path.join(path.dirname(process.execPath), 'jolo-engine');
  return { command, args: [...(entry ? [entry] : []), 'search-mcp', '--socket', paths.socketPath, '--token-file', paths.tokenPath, '--workspace', workspaceId] };
}

export const codexSearchArgs = config => config ? ['-c', `mcp_servers.jolo_search.command=${JSON.stringify(config.command)}`, '-c', `mcp_servers.jolo_search.args=${JSON.stringify(config.args)}`] : [];
export const claudeSearchArgs = config => config ? ['--mcp-config', JSON.stringify({ mcpServers: { jolo_search: config } })] : [];
export const acpSearchServers = config => config ? [{ name: 'jolo_search', ...config, env: [] }] : [];
