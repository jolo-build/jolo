/** Shared working indicator for controls that stop an active task. */
export function StopIndicator({ size = 20 }) {
  return <svg className="stop-progress" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <circle className="stop-progress-track" cx="12" cy="12" r="9" />
    <circle className="stop-progress-arc" cx="12" cy="12" r="9" />
    <rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" />
  </svg>;
}
