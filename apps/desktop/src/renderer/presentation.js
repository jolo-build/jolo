export const basename = (path) => path?.split(/[\\/]/).filter(Boolean).at(-1) || 'Workspace';
export { desktopRunLabel as runLabel } from "@jolo/client/run-state";

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
export const changeKey = (change) => `${change.invocationId}:${change.newPath ?? change.path}:${change.tool}:${change.revision ?? ''}`;
export function verificationLabel(verification) {
  if (!verification || verification.status === 'not_run') return 'Not run';
  const checks = verification.checks ?? [];
  if (verification.status === 'passed') return `${checks.filter((c) => c.exitCode === 0).length} passed`;
  return ({ failed: 'Failed', stale: 'Changes need rechecking', interrupted: 'Interrupted' })[verification.status] ?? verification.status;
}
