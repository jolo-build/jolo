// Mouse reporting for the interactive client.
// Ink assembles fragmented CSI packets and removes the leading escape byte before useInput.
// Consume all mouse reports so clicks/releases can never become prompt text.
/** Decode one SGR mouse report; null when the input is ordinary text. Wheel reports carry a scroll delta. */
export function mouseReport(input) {
  const match = /^(?:\x1b)?\[<(\d+);(\d+);(\d+)([Mm])$/.exec(input ?? "");
  if (!match) return null;
  const button = Number(match[1]);
  const wheel = (button & 64) !== 0 && (button & 32) === 0 && match[4] === "M";
  return { delta: wheel && (button & 3) < 2 ? ((button & 1) ? 5 : -5) : 0 };
}

/** Ask for cell-based reports and return the restore function; a no-op off a terminal. */
export function enableMouse(stdout = process.stdout) {
  if (!stdout.isTTY) return () => {};
  // Save the previous modes, request cell-based reports, and restore on every unmount.
  stdout.write("\x1b[?1000;1006s\x1b[?1000;1006h");
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    stdout.write("\x1b[?1000;1006l\x1b[?1000;1006r");
  };
}
