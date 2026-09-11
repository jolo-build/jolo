/** Original Jolo artwork used in conversations. */
export function JoloMark({ className = "" }) {
  return <span className={`jolo-mark ${className}`} aria-hidden="true" />;
}

export function JoloLogo({ className = "" }) {
  return <span className={`jolo-wordmark ${className}`} role="img" aria-label="Jolo">jolo</span>;
}
