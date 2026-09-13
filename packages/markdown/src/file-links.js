// A suffix can name both a domain and a file. Ambiguous names need either an
// HTTP URL or an explicit local reference; never use them to infer a file link.
const FILE_SUFFIXES = new Set('md markdown mdx go rs py js jsx ts tsx cs sh pl rb cc cpp h c java css html json yaml yml toml txt log csv pdf doc docx odt ods odp rtf ipynb sql swift kt xls xlsx ppt pptx png jpg jpeg gif webp svg zip gz tar db sqlite mp3 mp4 wav webm ogg lock env'.split(' '));
const CONTROL = /[\x00-\x1f\x7f]/;
const WINDOWS_PATH = /^[a-z]:[\\/]/i;
const LOCAL_MARKER = /^(?:\.{1,2}[\\/]|~[\\/]|file:|sandbox:|[a-z]:[\\/])/i;
const LOCATION = /(?::([1-9]\d*)(?::([1-9]\d*))?|#L([1-9]\d*)(?:C([1-9]\d*))?)$/;

export function webReference(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > 4096 || /[\s\x00-\x1f\x7f\\]/.test(raw)) return null;
  try {
    if (/^https?:\/\//i.test(raw)) return new URL(raw).href;
    if (/^[./~]/.test(raw) || WINDOWS_PATH.test(raw)) return null;
    const authority = raw.split(/[/?#]/, 1)[0];
    const host = authority.replace(/:\d{1,5}$/, '').toLowerCase();
    if (host === 'localhost' || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) || /^\[[\da-f:]+\]$/i.test(host)) return new URL(`http://${raw}`).href;
    if (!/^(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z]{2,63}$/.test(host)) return null;
    if (!host.startsWith('www.') && FILE_SUFFIXES.has(host.split('.').at(-1))) return null;
    return new URL(`https://${raw}`).href;
  } catch { return null; }
}

// A dotted name can be a code property even when its suffix is also a domain
// suffix (e.g. account.name). Only deliberate Markdown destinations may infer
// a scheme from a bare hostname. Automatic links need visible URL syntax.
function hasAutomaticWebSyntax(raw) {
  return /^(?:https?:\/\/|www\.)/i.test(raw)
    || /^(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|\[[\da-f:]+\]):\d{1,5}(?:[/?#]|$)/i.test(raw);
}

/** Decode a local reference once, preserving its source location separately. */
export function parseFileReference(raw, { explicit = false, urlEncoded = false } = {}) {
  if (typeof raw !== 'string' || !raw || raw.length > 4096 || CONTROL.test(raw) || webReference(raw)) return null;
  const location = raw.match(LOCATION);
  let value = location ? raw.slice(0, location.index) : raw;
  const line = location ? Number(location[1] || location[3]) : undefined;
  const column = location && (location[2] || location[4]) ? Number(location[2] || location[4]) : undefined;
  if ((line !== undefined && !Number.isSafeInteger(line)) || (column !== undefined && !Number.isSafeInteger(column))) return null;
  try {
    if (/^sandbox:/i.test(value)) { value = value.slice(8); urlEncoded = true; if (!value.startsWith('/') || value.startsWith('//')) return null; }
    else if (/^file:/i.test(value)) {
      const url = new URL(value);
      if ((url.hostname && url.hostname !== 'localhost') || url.search || url.hash) return null;
      value = url.pathname;
      urlEncoded = true;
      if (/^\/[a-z]:\//i.test(value)) value = value.slice(1);
    } else if ((!WINDOWS_PATH.test(value) && /^[a-z][a-z0-9+.-]*:/i.test(value)) || value.startsWith('//') || value.startsWith('\\\\')) return null;
    // Reject URL syntax before decoding, so encoded ? and # in real filenames work.
    if (/[?#]/.test(value)) return null;
    if (urlEncoded) value = decodeURIComponent(value);
  } catch { return null; }
  if (!value || CONTROL.test(value) || /[\\/]$/.test(value) || ['.', '..', '~'].includes(value)) return null;
  if (!explicit && (/\s/.test(raw) || !/(?:^|[\\/])[^\\/]+\.[a-z][a-z0-9]{0,11}$/i.test(value))) return null;
  return { path: value, line, column };
}

// Main-process file operations use this parser after the user selected a local
// destination. Classification of text belongs to classifyReference below.
export function fileReference(raw, options = {}) {
  return parseFileReference(raw, options)?.path ?? null;
}

/** @param {string} raw @param {{ explicit?: boolean, webBaseUrl?: string | null }} [options] */
export function classifyReference(raw, { explicit = false, webBaseUrl = null } = {}) {
  const web = webReference(raw);
  if (web) return explicit || hasAutomaticWebSyntax(raw) ? { kind: 'web', href: web } : { kind: 'ambiguous' };
  if (typeof raw !== 'string' || !raw || /\s/.test(raw) || raw.length > 4096 || CONTROL.test(raw)) return { kind: 'text' };
  // Only an explicitly supplied document origin resolves website paths. Never
  // borrow the browser's current URL or a neighboring link in the conversation.
  if (webBaseUrl && (explicit || /[/?#]/.test(raw)) && !LOCATION.test(raw) && !/^(?:file:|sandbox:|~[\\/]|[a-z]:[\\/])/i.test(raw)) {
    try {
      const base = new URL(webBaseUrl);
      const url = new URL(raw, base);
      if (['http:', 'https:'].includes(base.protocol) && ['http:', 'https:'].includes(url.protocol)) return { kind: 'web', href: url.href };
    } catch { /* An invalid base must not change the destination type. */ }
  }
  const file = parseFileReference(raw, { explicit: true, urlEncoded: explicit });
  if (file && (explicit || LOCAL_MARKER.test(raw) || LOCATION.test(raw))) return { kind: 'file', reference: raw, urlEncoded: explicit };
  const relativeWebPath = /[/?#]/.test(raw) && !raw.includes('\\') && !/^[a-z][a-z0-9+.-]*:/i.test(raw);
  return { kind: file || relativeWebPath ? 'ambiguous' : 'text' };
}

export function automaticFileReference(raw) {
  return classifyReference(raw).kind === 'file' ? fileReference(raw, { explicit: true }) : null;
}

// Match whole tokens, not file-shaped substrings: ~, //, query strings and
// source locations must survive intact. Prose and inline code share classification.
export function referenceTokens(text) {
  return text.split(/(\s+)/u).filter(Boolean).flatMap(part => {
    if (/^\s+$/u.test(part)) return [part];
    let value = part, before = '', after = '';
    const pairs = { '(': ')', '[': ']', '{': '}', '<': '>', '"': '"', "'": "'", '`': '`' };
    for (;;) {
      const punctuation = value.match(/[.!?,;:]+$/);
      if (punctuation) { value = value.slice(0, -punctuation[0].length); after = punctuation[0] + after; }
      // Brackets within IPv6 addresses and punctuation within filenames belong
      // to the destination. Only remove matching wrappers around a whole token.
      if (!webReference(value) && value.length > 1 && pairs[value[0]] === value.at(-1)) {
        before += value[0]; after = value.at(-1) + after; value = value.slice(1, -1);
      } else break;
    }
    return [before, value, after].filter(Boolean);
  });
}
