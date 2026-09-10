import { sanitizeText } from "@jolo/markdown/text";
// Draft editing for the interactive client. Pure text transforms: no terminal writes,
// no engine calls, and nothing a paste can carry reaches the draft as a control sequence.
/** Delete the last word and any trailing whitespace, retaining the separator before it. */
export function deletePreviousWord(value) {
  let end = value.length;
  while (end > 0 && /\s/u.test(value[end - 1])) end--;
  while (end > 0 && !/\s/u.test(value[end - 1])) end--;
  return value.slice(0, end);
}

/** Editing only; submission, permissions, and app shortcuts are handled by the caller. */
export function editDraft(value, chunk, key = {}) {
  if (key.eventType === "release") return value;
  if ((key.backspace && (key.ctrl || key.meta)) || (key.ctrl && chunk === "w")) return deletePreviousWord(value);
  if (key.backspace || key.delete) return value.slice(0, -1);
  if (key.ctrl || key.meta || key.super || key.escape || key.return || key.tab) return value;
  // Pasted terminal output carries escape sequences; Ink may already have consumed the escape byte itself.
  const printable = sanitizeText(chunk, { multiline: false, tab: "", consumedEscape: true });
  return (value + printable).slice(0, 64 * 1024);
}
