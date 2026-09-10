/** Text identity shared by the desktop header and conversation. */
export function JoloMark({ className = "" }) {
  return <span className={`jolo-mark ${className}`} aria-hidden="true">J</span>;
}

export function JoloLogo() {
  return <span className="jolo-mark header-mark" role="img" aria-label="Jolo">J</span>;
}
