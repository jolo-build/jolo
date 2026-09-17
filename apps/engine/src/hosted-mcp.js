// The one tool bridge a hosted run gets: whichever Jolo tools this engine hosts — schedules always,
// search and the inline browser when supported — behind a single capability credential. One child
// process, one scoped connection, one token per run, however many tools it answers.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { runScopedMcp } from './search/mcp.js';
import { searchBridge } from './search/mcp.js';
import { browserBridge } from './browser/mcp.js';
import { scheduleBridge, SCHEDULE_METHODS } from './scheduler/mcp.js';
import { delegationBridge } from './delegation/mcp.js';

const BRIDGES = { search: searchBridge, browser: browserBridge, schedule: scheduleBridge, delegation: delegationBridge };
const BRIDGE_METHODS = { search: ['workspace.search'], browser: ['browser.call'], schedule: SCHEDULE_METHODS, delegation: ['delegation.call'] };

/**
 * The MCP server config for one hosted run: `jolo` serving every bridge this engine can offer.
 * @returns {(workspace: any, run: any) => { server: { command: string, args: string[] }, hasBrowser: boolean, hasSearch: boolean }}
 */
export function createHostedMcpConfig({ paths, capabilityTokens, browser, search, log }) {
  return (workspace, run) => {
    const tools = ['schedule', 'delegation'];
    if (search) {
      tools.push('search');
      void search.acquire(workspace.path).then(lease => lease?.release()).catch(() => {}); // warm the index so the first query is fast
    }
    // A desktop can attach or reconnect after this config is minted. Keep the
    // tools in the run; the broker checks the live workspace host on each call.
    const hasBrowser = Boolean(browser);
    if (hasBrowser) tools.push('browser');
    const methods = tools.flatMap(name => BRIDGE_METHODS[name]);
    const tokenPath = capabilityTokens.issue(run.id, workspace.id, methods).tokenPath;
    return { server: hostedMcpConfig({ ...paths, tokenPath }, workspace.id, tools), hasBrowser, hasSearch: Boolean(search) };
  };
}

/** Spawn argv for the bridge: `jolo-mcp` serving the named tool groups to one workspace. */
export function hostedMcpConfig(paths, workspaceId, tools) {
  const { command, args } = scopedMcpConfig(paths, workspaceId, 'jolo-mcp');
  return { command, args: [...args, '--tools', tools.join(',')] };
}

function scopedMcpConfig(paths, workspaceId, subcommand) {
  // The engine can also be started by `jolo engine serve`; argv[1] is then the CLI, not our entry.
  // main.js comes first: this file sits in src/, where engine.js is the library, not the entry.
  const entry = [path.resolve(import.meta.dir, 'main.js'), path.join(import.meta.dir, 'engine.js')].find(file => !file.startsWith('/$bunfs/') && existsSync(file));
  const command = entry ? process.execPath : path.join(path.dirname(process.execPath), 'jolo-engine');
  return { command, args: [...(entry ? [entry] : []), subcommand, '--socket', paths.socketPath, '--token-file', paths.tokenPath, '--workspace', workspaceId] };
}

export const codexMcpArgs = config => config ? ['-c', `mcp_servers.jolo.command=${JSON.stringify(config.command)}`, '-c', `mcp_servers.jolo.args=${JSON.stringify(config.args)}`] : [];
export const acpMcpServers = config => config ? [{ name: 'jolo', ...config, env: [] }] : [];

export function runHostedMcp(argv = process.argv.slice(3)) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 2) flags[argv[i]] = argv[i + 1];
  const names = String(flags['--tools'] ?? '').split(',').filter(Boolean);
  const selected = names.map(name => BRIDGES[name]);
  if (!selected.length || selected.some(bridge => !bridge)) throw new Error(`jolo-mcp requires --tools with some of ${Object.keys(BRIDGES).join(', ')}`);
  const tools = selected.flatMap(bridge => bridge.tools);
  const route = new Map(selected.flatMap(bridge => bridge.tools.map(tool => [tool.name, bridge])));
  return runScopedMcp({
    argv, name: 'jolo', tools,
    call: (client, workspaceId, params) => {
      const bridge = route.get(params?.name);
      if (!bridge) throw new Error(`unknown tool ${params?.name}`);
      return bridge.call(client, workspaceId, params);
    },
  });
}
