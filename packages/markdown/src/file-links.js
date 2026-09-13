// Bare domains and filenames overlap. Keep common source/document extensions
// as files; an explicit ./ path or file: URL always identifies a local file.
const FILE_SUFFIXES = new Set('md go rs py js ts cs sh pl rb cc h c'.split(' '));
const WEB_SUFFIXES = new Set('com org net edu gov mil int app dev info biz xyz online site tech cloud shop store blog website space live news world network systems digital solutions services tools agency company design social software academy center email travel name pro mobi museum aero io ai co uk de fr us ca au eu me tv it es nl ch se no fi dk be at pt br in jp cn kr ru ua nz za ie il sg hk tw tr az ae id mx ar cl'.split(' '));
export function webReference(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > 4096 || /[\s\x00-\x1f\x7f\\]/.test(raw)) return null;
  try {
    if (/^https?:\/\//i.test(raw)) return new URL(raw).href;
    if (/^[./~]/.test(raw)) return null;
    const authority = raw.split(/[/?#]/, 1)[0];
    const host = authority.replace(/:\d{1,5}$/, '').toLowerCase();
    if (host === 'localhost' && authority !== host) return new URL(`http://${raw}`).href;
    if (!/^(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z]{2,63}$/.test(host)) return null;
    const suffix = host.split('.').at(-1);
    if (!host.startsWith('www.') && (FILE_SUFFIXES.has(suffix) || !WEB_SUFFIXES.has(suffix))) return null;
    return new URL(`https://${raw}`).href;
  } catch { return null; }
}

// Recognize file references without accepting executable URL schemes.
export function fileReference(raw, { explicit = false } = {}) {
  if (typeof raw !== 'string' || raw.length > 4096 || /[\x00-\x1f\x7f]/.test(raw)) return null;
  if (webReference(raw)) return null;
  let value = raw.replace(/:\d+(?::\d+)?$/, '');
  if (value.startsWith('sandbox:')) value = value.slice(8);
  else if (value.startsWith('file:')) {
    try { const url = new URL(value); if (url.hostname && url.hostname !== 'localhost') return null; value = decodeURIComponent(url.pathname); } catch { return null; }
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//')) return null;
  if (!value || /[\x00-\x1f\x7f]/.test(value)) return null;
  if (explicit && !/[?#]/.test(value) && !value.endsWith('/') && !['.', '..'].includes(value)) return value;
  return /(?:^|\/)[^/]+\.[a-z0-9]{1,12}(?::\d+(?::\d+)?)?$/i.test(value) ? value : null;
}
