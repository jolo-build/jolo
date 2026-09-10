// Common treatment of untrusted text. Callers choose whitespace appropriate to
// their surface; none of these profiles permits terminal control sequences.
export function sanitizeText(value, { multiline = true, tab = '  ', consumedEscape = false } = {}) {
  let text = String(value ?? '')
    .replace(/\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[PX^_][\s\S]*?\x1b\\)/g, '')
    .replace(/\t/g, tab)
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, '');
  if (!multiline) text = text.replace(/\n/g, '');
  if (consumedEscape) text = text.replace(/\[[0-9;]*m/g, '');
  return text;
}
