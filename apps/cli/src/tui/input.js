import { sanitizeText } from "@jolo/markdown/text";
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const MAX_DRAFT_CHARS = 64 * 1024;
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

/** Cursor offsets are UTF-16 indices; movement and deletion keep graphemes intact. */
export function editInput(value, cursor, chunk, key = {}) {
  cursor = Math.max(0, Math.min(cursor, value.length));
  const unchanged = { value, cursor };
  if (key.eventType === "release") return unchanged;
  if (key.return && key.shift && !key.ctrl && !key.meta && !key.super) {
    return value.length < MAX_DRAFT_CHARS ? { value: value.slice(0, cursor) + "\n" + value.slice(cursor), cursor: cursor + 1 } : unchanged;
  }
  const segments = graphemes.segment(value);
  const previous = () => cursor > 0 ? segments.containing(cursor - 1).index : 0;
  const next = () => cursor < value.length ? segments.containing(cursor).index + segments.containing(cursor).segment.length : value.length;
  const wordLeft = () => deletePreviousWord(value.slice(0, cursor)).length;
  const wordRight = () => {
    let end = cursor;
    while (end < value.length && /\s/u.test(value[end])) end++;
    while (end < value.length && !/\s/u.test(value[end])) end++;
    return end;
  };
  if (key.upArrow || key.downArrow) {
    const start = cursor === 0 ? 0 : value.lastIndexOf("\n", cursor - 1) + 1;
    const end = value.indexOf("\n", cursor);
    if ((key.upArrow && start === 0) || (key.downArrow && end < 0)) return unchanged;
    const targetStart = key.upArrow ? (start <= 1 ? 0 : value.lastIndexOf("\n", start - 2) + 1) : end + 1;
    const targetEnd = key.upArrow ? start - 1 : value.indexOf("\n", targetStart);
    const column = Bun.stringWidth(value.slice(start, cursor));
    let offset = targetStart, cells = 0;
    for (const { segment } of graphemes.segment(value.slice(targetStart, targetEnd < 0 ? value.length : targetEnd))) {
      const width = Bun.stringWidth(segment);
      if (cells + width > column) break;
      cells += width; offset += segment.length;
    }
    return { value, cursor: offset };
  }
  // macOS terminals send either modified arrows or Escape+b/f for Option+arrows.
  if (key.leftArrow || (key.meta && chunk === "b")) return { value, cursor: key.meta || key.ctrl ? wordLeft() : previous() };
  if (key.rightArrow || (key.meta && chunk === "f")) return { value, cursor: key.meta || key.ctrl ? wordRight() : next() };
  if (key.home || (key.ctrl && chunk === "a")) return { value, cursor: 0 };
  if (key.end || (key.ctrl && chunk === "e")) return { value, cursor: value.length };
  if (key.backspace || (key.ctrl && chunk === "w")) {
    const start = key.ctrl || key.meta ? wordLeft() : previous();
    return { value: value.slice(0, start) + value.slice(cursor), cursor: start };
  }
  if (key.delete) {
    const end = key.ctrl || key.meta ? wordRight() : next();
    return { value: value.slice(0, cursor) + value.slice(end), cursor };
  }
  if (key.ctrl || key.meta || key.super || key.escape || key.return || key.tab || key.upArrow || key.downArrow || key.pageUp || key.pageDown) return unchanged;
  const printable = sanitizeText(chunk, { multiline: false, tab: "", consumedEscape: true });
  // Keep the suffix intact when pasting at the limit, and never split a grapheme.
  const room = MAX_DRAFT_CHARS - value.length;
  let inserted = "";
  for (const { segment } of graphemes.segment(printable)) {
    if (inserted.length + segment.length > room) break;
    inserted += segment;
  }
  return { value: value.slice(0, cursor) + inserted + value.slice(cursor), cursor: cursor + inserted.length };
}

/** Pasted bulk text keeps its line breaks; control bytes still never reach the draft. */
export function pasteText(value, cursor, chunk) {
  cursor = Math.max(0, Math.min(cursor, value.length));
  // Terminals variously separate pasted lines with \r, \n, or \r\n; normalize before
  // sanitizeText, which deletes \r outright, or pasted lines would join without a break.
  const printable = sanitizeText(String(chunk ?? "").replace(/\r\n|\r/g, "\n"), { multiline: true, tab: "  ", consumedEscape: true });
  const room = Math.max(0, MAX_DRAFT_CHARS - value.length);
  let inserted = "";
  for (const { segment } of graphemes.segment(printable)) {
    if (inserted.length + segment.length > room) break;
    inserted += segment;
  }
  return { value: value.slice(0, cursor) + inserted + value.slice(cursor), cursor: cursor + inserted.length };
}

/** A single-line viewport that always includes the cursor, measured in terminal cells. */
export function inputViewport(value, cursor, columns) {
  const display = (text) => sanitizeText(text).replace(/\n/g, " ");
  const before = Array.from(graphemes.segment(value.slice(0, cursor)), ({ segment }) => display(segment));
  const after = Array.from(graphemes.segment(value.slice(cursor)), ({ segment }) => display(segment));
  const caret = after.shift() || " ";
  let remaining = Math.max(0, columns - Bun.stringWidth(caret));
  let left = "";
  for (let i = before.length - 1; i >= 0; i--) {
    const width = Bun.stringWidth(before[i]);
    if (width > remaining) break;
    left = before[i] + left;
    remaining -= width;
  }
  let right = "";
  for (const segment of after) {
    const width = Bun.stringWidth(segment);
    if (width > remaining) break;
    right += segment;
    remaining -= width;
  }
  return { before: left, caret, after: right };
}

/** A bounded set of logical lines, keeping the cursor's line visible. */
export function inputRows(value, cursor, columns, maxRows = 6) {
  const lines = value.split("\n");
  const active = value.slice(0, cursor).split("\n").length - 1;
  const start = Math.max(0, active - Math.max(1, maxRows) + 1);
  const lineStart = cursor === 0 ? 0 : value.lastIndexOf("\n", cursor - 1) + 1;
  return lines.slice(start, start + Math.max(1, maxRows)).map((line, offset) => ({
    ...inputViewport(line, start + offset === active ? cursor - lineStart : 0, columns),
    active: start + offset === active, index: start + offset,
  }));
}
