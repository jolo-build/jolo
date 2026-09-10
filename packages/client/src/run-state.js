import { TERMINAL_RUN_STATES, WORKING_RUN_STATES } from '@jolo/protocol/run-state';
export const TERMINAL = new Set(TERMINAL_RUN_STATES);
export const RUNNING = new Set(WORKING_RUN_STATES);
export const PROGRESS_LABELS = Object.freeze({ queued: 'Queued', preparing: 'Preparing', model: 'Thinking', tools: 'Running tools', awaiting_permission: 'Waiting for approval', paused: 'Paused', cancelling: 'Cancelling', cancelled: 'Cancelled', completed: 'Completed', failed: 'Failed', interrupted: 'Interrupted' });
const DESKTOP_LABELS = Object.freeze({ ...PROGRESS_LABELS, completed: 'Ready for review', failed: 'Task failed', cancelled: 'Stopped', model: 'Working', tools: 'Using tools', awaiting_permission: 'Needs approval', preparing: 'Getting ready' });
export function desktopRunLabel(run) {
  if (!run) return 'Ready when you are';
  if (run.state === 'paused') return run.pauseReason === 'permission' ? 'Needs approval' : 'Paused';
  return DESKTOP_LABELS[run.state] ?? run.state;
}
export function requestId() { return `req_${globalThis.crypto.randomUUID()}`; }
