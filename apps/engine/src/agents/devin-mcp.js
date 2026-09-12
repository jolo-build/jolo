import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

/** @returns {Record<string, any>} */
function readConfig(file) {
  try {
    const value = Bun.JSONC.parse(readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected a configuration object');
    return /** @type {Record<string, any>} */ (value);
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(`Could not read Devin configuration: ${file}`);
  }
}

/**
 * Devin 3000.10 ignores ACP mcpServers, but reads its dedicated MCP file at startup.
 * Copy only Devin's two configuration files into a private per-run directory. Never
 * edit the user's config or put run credentials in the project. Other ACP agents
 * continue to use the protocol field. The actual token stays in its scoped token file.
 */
export function prepareDevinMcp(env, servers, { platform = process.platform, temporaryRoot = tmpdir() } = {}) {
  const configVariable = platform === 'win32' ? 'APPDATA' : 'XDG_CONFIG_HOME';
  const configHome = env[configVariable] || (platform === 'win32' ? path.join(homedir(), 'AppData', 'Roaming') : path.join(env.HOME || homedir(), '.config'));
  const config = readConfig(path.join(configHome, 'devin', 'config.json'));
  const mcp = readConfig(path.join(configHome, 'devin', 'mcp_config.json'));
  const directory = mkdtempSync(path.join(temporaryRoot, 'jolo-devin-mcp-'));
  const dispose = () => rmSync(directory, { recursive: true, force: true });
  try {
    const target = path.join(directory, 'devin');
    mkdirSync(target, { mode: 0o700 });
    const { mcpServers: legacy = {}, ...settings } = config;
    const injected = Object.fromEntries(servers.map(({ name, command, args, env: variables = [] }) => [name, {
      command, args, env: Object.fromEntries(variables.map(({ name, value }) => [name, value])),
    }]));
    writeFileSync(path.join(target, 'config.json'), JSON.stringify(settings), { mode: 0o600 });
    writeFileSync(path.join(target, 'mcp_config.json'), JSON.stringify({ ...mcp, mcpServers: { ...legacy, ...mcp.mcpServers, ...injected } }), { mode: 0o600 });
    return { env: { ...env, [configVariable]: directory }, dispose };
  } catch (error) { dispose(); throw error; }
}
