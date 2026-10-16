const SOURCE = new Set(['c', 'cc', 'cpp', 'cs', 'dart', 'ex', 'exs', 'go', 'h', 'hpp', 'java', 'kt', 'kts', 'lua', 'php', 'py', 'rb', 'rs', 'scala', 'swift', 'vue']);
const WEB = new Set(['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx']);
const MARKUP = new Set(['css', 'scss', 'sass', 'less', 'html', 'htm', 'xml', 'svg', 'svelte']);
const DATA = new Set(['json', 'jsonl', 'toml', 'yaml', 'yml', 'csv']);
const TEXT = new Set(['md', 'markdown', 'mdx', 'txt', 'rtf', 'adoc']);
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp']);
const MEDIA = new Set(['mp3', 'wav', 'ogg', 'flac', 'mp4', 'webm', 'mov']);
const ARCHIVE = new Set(['zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'tar']);
const DATABASE = new Set(['db', 'sqlite', 'sqlite3', 'sql']);
const LOCK = new Set(['lock']);

/** A compact, themeable file identity shared by tree rows and preview tabs. */
export function projectFileKind(value) {
  const name = value.split(/[\\/]/).at(-1) || value;
  const lower = name.toLowerCase();
  const extension = lower.includes('.') ? lower.split('.').at(-1) : '';
  if (lower === 'dockerfile' || lower.startsWith('dockerfile.') || lower === 'makefile' || lower === 'justfile') return { icon: 'fileCode', tone: 'config' };
  if (/^(readme|changelog|license|contributing)(\.|$)/.test(lower)) return { icon: 'fileText', tone: 'document' };
  if (/^(package|tsconfig|jsconfig|composer|deno)\.json$/.test(lower)) return { icon: 'package', tone: 'package' };
  if (/^\.(gitignore|gitattributes|gitmodules)$/.test(lower)) return { icon: 'branch', tone: 'muted' };
  if (/^(\.env|\.env\.|\.editorconfig$|\.prettier|\.eslint|\.stylelint)/.test(lower) || ['ini', 'cfg', 'conf'].includes(extension)) return { icon: 'settings', tone: 'config' };
  if (WEB.has(extension)) return { icon: 'fileCode', tone: extension.includes('x') ? 'react' : extension.startsWith('ts') ? 'typescript' : 'javascript' };
  if (SOURCE.has(extension)) return { icon: 'fileCode', tone: extension || 'source' };
  if (MARKUP.has(extension)) return extension === 'svg' ? { icon: 'image', tone: 'image' } : { icon: 'fileCode', tone: 'markup' };
  if (DATA.has(extension)) return { icon: 'fileData', tone: 'data' };
  if (TEXT.has(extension)) return { icon: 'fileText', tone: 'document' };
  if (IMAGE.has(extension)) return { icon: 'image', tone: 'image' };
  if (MEDIA.has(extension)) return { icon: 'media', tone: 'media' };
  if (ARCHIVE.has(extension)) return { icon: 'archiveBox', tone: 'archive' };
  if (DATABASE.has(extension)) return { icon: 'database', tone: 'database' };
  if (LOCK.has(extension) || lower.endsWith('-lock.json')) return { icon: 'lock', tone: 'muted' };
  if (extension === 'pdf') return { icon: 'fileText', tone: 'pdf' };
  return { icon: 'file', tone: 'muted' };
}
