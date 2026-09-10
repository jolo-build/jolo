/** Original Jolo artwork shared by the desktop header and conversation. */
export function JoloMark({ className = "" }) {
  return <span className={`jolo-mark ${className}`} aria-hidden="true" />;
}

export function JoloLogo() {
  return <span className="jolo-mark header-mark" role="img" aria-label="Jolo" />;
}
