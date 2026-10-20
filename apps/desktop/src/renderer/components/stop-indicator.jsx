/** The mark on controls that stop an active task: a plain stop square, since the task's own status says it is working. */
export function StopIndicator({ size = 20 }) {
  return <svg className="stop-progress" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <rect x="8" y="8" width="8" height="8" rx="1.5" fill="currentColor" />
  </svg>;
}
