import { useEffect, useReducer } from 'react';
import { activityLine, childRows } from '../activity.js';

const NO_DELEGATIONS = new Map();

/**
 * The line above the composer while the conversation's Claude process has background work (D1) or one of its child
 * tasks works: its text opens the Activity panel, where the stops are (one for all the work, a square per task and per
 * child); a stop beside the composer was too easy to hit by mistake. Nothing is shown while neither runs.
 * @param {{
 *   activity: import('../activity.js').Activity | null,
 *   childTasks?: import('../activity.js').ChildTask[],
 *   delegations?: Map<string, import('../activity.js').DelegationRow>,
 *   onOpenPanel: () => void,
 * }} props
 */
export function ActivityLine({ activity, childTasks = [], delegations = NO_DELEGATIONS, onOpenPanel }) {
  const [, tick] = useReducer((/** @type {number} */ count) => count + 1, 0);
  const now = Date.now();
  const working = childRows(childTasks, delegations, now).filter(row => row.running);
  const starts = working.map(row => row.since).filter(since => since !== null);
  const line = activityLine(activity, { now, children: working.length, childrenSince: starts.length ? Math.min(...starts) : null });
  const running = line !== null;
  // The elapsed time moves once a second while something runs, and nothing ticks otherwise.
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [running]);
  if (!line) return null;
  return <div className="activity-line" role="status">
    <button type="button" className="activity-line-text" aria-label={line.running ? 'Show background work' : 'Show child tasks'} onClick={onOpenPanel}>{line.text}</button>
  </div>;
}
