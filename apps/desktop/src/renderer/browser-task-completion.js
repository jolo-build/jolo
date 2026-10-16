import { TERMINAL_RUN_STATES } from '@jolo/protocol/run-state';

// Browser tools from built-in and hosted agents share these durable events.
// Track successful browser use, not merely a chat finishing while a page is open.
export function browserTaskCompletion(closePanel) {
  const runs = new Map();
  return event => {
    if (!event.runId || !event.sessionId) return;
    if (event.type === 'tool.completed' && event.payload.status === 'ok' && event.payload.name.startsWith('browser_') && event.payload.name !== 'browser_tabs') {
      runs.set(event.runId, event.sessionId);
    }
    if (event.type !== 'run.state' || !TERMINAL_RUN_STATES.includes(event.payload.state)) return;
    const sessionId = runs.get(event.runId);
    runs.delete(event.runId);
    if (sessionId && event.payload.state === 'completed' && ![...runs.values()].includes(sessionId)) closePanel(sessionId);
  };
}
