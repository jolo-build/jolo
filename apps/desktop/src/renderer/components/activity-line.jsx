import { useEffect, useReducer } from 'react';
import { activityLine } from '../activity.js';

/**
 * The line above the composer while the conversation's Claude process has background work (D1): its text opens the
 * Activity panel, and one button stops all of it. Nothing is shown while no background task runs.
 * @param {{
 *   activity: import('../activity.js').Activity | null,
 *   onStop: () => void,
 *   onOpenPanel: () => void,
 *   stopping: boolean,
 * }} props
 */
export function ActivityLine({ activity, onStop, onOpenPanel, stopping }) {
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
    <button type="button" className="activity-line-stop" disabled={stopping} onClick={onStop}>{stopping ? 'Stopping…' : 'Stop background work'}</button>
  </div>;
}
