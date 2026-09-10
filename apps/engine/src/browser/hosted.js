import { scopedMcpConfig } from '../search/hosted.js';

export const browserMcpConfig = (paths, workspaceId) => scopedMcpConfig(paths, workspaceId, 'browser-mcp');
// Sample availability when each hosted run starts, before issuing any credential.
export const createBrowserConfig = ({ browser, paths, capabilityTokens }) => (workspace, run) => browser.hasBrowser(workspace.id)
  ? browserMcpConfig({ ...paths, tokenPath: capabilityTokens.issue(run.id, workspace.id, ['browser.call']).tokenPath }, workspace.id)
  : null;
export const codexBrowserArgs = config => config ? ['-c', `mcp_servers.jolo_browser.command=${JSON.stringify(config.command)}`, '-c', `mcp_servers.jolo_browser.args=${JSON.stringify(config.args)}`] : [];
export const acpBrowserServers = config => config ? [{ name: 'jolo_browser', ...config, env: [] }] : [];

// Hosted tool previews are short. Keep screenshot JSON complete even for long page URLs.
export function browserPreview(text) {
  try {
    const value = JSON.parse(text);
    if (value.ok && value.mimeType === 'image/png' && value.artifactId) {
      const { ok, artifactId, mimeType, width, height, bytes } = value;
      return JSON.stringify({ ok, artifactId, mimeType, width, height, bytes });
    }
  } catch { /* other tool output is plain text */ }
  return text;
}
