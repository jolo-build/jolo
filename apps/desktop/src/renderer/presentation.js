export const basename = (path) => path?.split(/[\\/]/).filter(Boolean).at(-1) || 'Workspace';
export { desktopRunLabel as runLabel } from "@jolo/client/run-state";
export { formatEveryMs as everyLabel } from "@jolo/protocol/schemas";

// Abbreviate only this user's home, preserving other folders' identity.
export function workspacePath(path, homeDirectory) {
  if (!homeDirectory) return path;
  const normalized = path.replaceAll('\\', '/');
  const home = homeDirectory.replaceAll('\\', '/').replace(/\/+$/, '');
  if (!home) return path;
  const windows = /^[a-z]:\//i.test(home) || home.startsWith('//');
  const value = windows ? normalized.toLowerCase() : normalized;
  const prefix = windows ? home.toLowerCase() : home;
  if (value === prefix) return '~';
  return value.startsWith(`${prefix}/`) ? `~${normalized.slice(home.length)}` : path;
}

export function pauseDescription(run) {
  if (run.pauseReason === 'budget') {
    const detail = {
      'hosted tool deadline reached': 'a tool exceeded its time limit',
      'active time budget reached': 'the task reached its time limit',
      'iteration budget reached': 'the task reached its step limit',
    }[run.failure] ?? run.failure ?? 'the task reached a limit';
    return `Task paused: ${detail}.`;
  }
  return `Task paused${run.pauseReason ? `: ${run.pauseReason.replaceAll('_', ' ')}` : ''}`;
}

export function uniqueChanges(changes) {
  const paths = new Map();
  for (const change of changes) paths.set(change.newPath ?? change.path, change);
  return [...paths.values()];
}

/** When a schedule fires next, relative to now: "in 12m", "in 3h", "due". */
export function untilLabel(iso) {
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return 'due';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `in ${Math.max(minutes, 1)}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

/**
 * The artifact a finished hosted browser_screenshot call produced, for any spelling a transport
 * gives it: bare, MCP-prefixed, or server/tool. Returns null for anything else.
 * @param {string} text the tool block's head + first line of output
 */
export function screenshotArtifactId(text) {
  const at = text.indexOf('\n');
  const [head, rest] = at < 0 ? [text, ''] : [text.slice(0, at), text.slice(at + 1)];
  if (!/^(?:jolo_browser\/|jolo\/|mcp__jolo_browser__|mcp__jolo__)?browser_screenshot(?:\s|$)/.test(head)) return null;
  try {
    const parsed = JSON.parse(rest.split('\n', 1)[0]);
    return parsed.ok && parsed.mimeType === 'image/png' && parsed.artifactId ? parsed.artifactId : null;
  } catch { return null; }
}
export const changeKey = (change) => `${change.invocationId}:${change.newPath ?? change.path}:${change.tool}:${change.revision ?? ''}`;
export function verificationLabel(verification) {
  if (!verification || verification.status === 'not_run') return 'Not run';
  const checks = verification.checks ?? [];
  if (verification.status === 'passed') return `${checks.filter((c) => c.exitCode === 0).length} passed`;
  return ({ failed: 'Failed', stale: 'Changes need rechecking', interrupted: 'Interrupted' })[verification.status] ?? verification.status;
}
