// Recognize file references without accepting executable URL schemes.
export function fileReference(raw, { explicit = false } = {}) {
  if (typeof raw !== 'string' || raw.length > 4096 || /[\x00-\x1f\x7f]/.test(raw)) return null;
  let value = raw.replace(/:\d+(?::\d+)?$/, '');
  if (value.startsWith('sandbox:')) value = value.slice(8);
  else if (value.startsWith('file:')) {
    try { const url = new URL(value); if (url.hostname && url.hostname !== 'localhost') return null; value = decodeURIComponent(url.pathname); } catch { return null; }
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//')) return null;
  if (!value || /[\x00-\x1f\x7f]/.test(value)) return null;
  if (explicit && !/[?#]/.test(value) && !value.endsWith('/') && !['.', '..'].includes(value)) return value;
  return /(?:^|\/)[^/]+\.[a-z0-9]{1,12}(?::\d+(?::\d+)?)?$/i.test(value) ? value : null;
}
