export const basename = (path) => path?.split(/[\\/]/).filter(Boolean).at(-1) || 'Workspace';
export { desktopRunLabel as runLabel } from "@jolo/client/run-state";

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
