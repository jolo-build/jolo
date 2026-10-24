import { useEffect, useReducer } from 'react';
import { activityLine } from '../activity.js';

/**
 * The line above the composer while the conversation's Claude process has background work (D1): its text opens the
 * Activity panel, where the stops are (one for all of it, a square per task); a stop beside the composer was too easy
 * to hit by mistake. Nothing is shown while no background task runs.
 * @param {{
 *   activity: import('../activity.js').Activity | null,
 *   onOpenPanel: () => void,
 * }} props
 */
export function ActivityLine({ activity, onOpenPanel }) {
  const [, tick] = useReducer((/** @type {number} */ count) => count + 1, 0);
  const line = activityLine(activity, { now: Date.now() });
  const running = line !== null;
  // The elapsed time moves once a second while something runs, and nothing ticks otherwise.
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [running]);
  if (!line) return null;
  return <div className="activity-line" role="status">
    <button type="button" className="activity-line-text" aria-label="Show background work" onClick={onOpenPanel}>{line.text}</button>
  </div>;
}
