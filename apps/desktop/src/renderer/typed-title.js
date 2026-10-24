// A generated title is typed out when it replaces the "being named" shimmer: one character after another, the first
// at once, every 28 ms, and faster for a long title so that the whole of it is out within 1.2 s.

export const TYPE_STEP_MS = 28, TYPE_TOTAL_MS = 1200;

/** The characters a title types in, one step each: code points, so a surrogate pair or a CJK character is one. */
export function titleSteps(title) {
  return Array.from(String(title ?? ''));
}

/** How many code points of `title` are shown `elapsedMs` after typing began; the whole title once it is done. */
export function typedLength(title, elapsedMs) {
  const total = titleSteps(title).length;
  if (!total) return 0;
  return Math.min(total, Math.floor(Math.max(0, elapsedMs) / typeStepMs(title)) + 1);
}

/** The time between two characters of `title`. */
export function typeStepMs(title) {
  return Math.min(TYPE_STEP_MS, TYPE_TOTAL_MS / Math.max(1, titleSteps(title).length));
}
