import { useEffect, useState } from 'react';
import { Icon } from './icon.jsx';
import { basename } from '../presentation.js';

/** A small badge per file type, so a list of names reads at a glance; the family sets its colour. */
/** @type {[RegExp, string, string][]} */
const BADGES = [
  [/\.(jsx?|mjs|cjs)$/i, 'JS', 'script'], [/\.(tsx?|mts|cts)$/i, 'TS', 'typed'], [/\.(md|mdx|markdown)$/i, 'MD', 'prose'],
  [/\.(json|jsonc|toml|ya?ml|lock|ini|env)$/i, '{ }', 'data'], [/\.(png|jpe?g|gif|webp|svg|ico|pdf)$/i, 'IMG', 'media'],
  [/\.(css|scss|less)$/i, 'CSS', 'style'], [/\.(html?|xml)$/i, '<>', 'markup'], [/\.(sh|zsh|bash)$/i, 'SH', 'shell'],
  [/\.(py)$/i, 'PY', 'script'], [/\.(go)$/i, 'GO', 'typed'], [/\.(rs)$/i, 'RS', 'typed'], [/\.(sql)$/i, 'SQL', 'data'],
  [/^\.git(ignore|attributes|modules)$/i, 'GIT', 'media'],
];
function FileBadge({ name }) {
  const match = BADGES.find(([pattern]) => pattern.test(name));
  return match ? <span className={`file-badge ${match[2]}`} aria-hidden="true">{match[1]}</span> : <Icon name="file" size={13} className="file-badge-plain" />;
}

/**
 * The project's files as a tree the user walks: a folder opens on click and is read once, a file opens as a tab.
 * Typing in the filter asks the engine for matches anywhere in the project and shows them as one flat list.
 * Folders are listed by the engine inside the workspace only, so the tree never leaves the project.
 * @param {{ call: (method: string, params?: any) => Promise<any>, workspaceId: string, name: string, active?: boolean, revision?: string, onOpen: (path: string) => void, onPick?: (() => void) | null }} props
 *   `active` says the tree is on screen, and `revision` moves when the workspace's files may have changed; both re-read the open folders.
 */
export function FileTree({ call, workspaceId, name, active = true, revision = '', onOpen, onPick = null }) {
  const [folders, setFolders] = useState(() => new Map()); // folder path, '' for the root -> { entries, error }
  const [open, setOpen] = useState(() => new Set(['']));
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState(/** @type {{ query: string, entries: { path: string, kind: string }[] } | null} */ (null));
  const load = (folder) => call('workspace.files', { workspaceId, path: folder, limit: 200 })
    .then(({ entries }) => setFolders(current => new Map(current).set(folder, { entries })))
    .catch(error => setFolders(current => new Map(current).set(folder, { entries: [], error: error.message })));
  useEffect(() => { setFolders(new Map()); setOpen(new Set([''])); setQuery(''); setMatches(null); void load(''); }, [workspaceId]);
  useEffect(() => { if (active) for (const folder of open) void load(folder); }, [active, revision]);
  const term = query.trim();
  useEffect(() => {
    if (!term) { setMatches(null); return; }
    let current = true;
    const timer = setTimeout(() => {
      call('workspace.files', { workspaceId, query: term, limit: 60 })
        .then(({ entries }) => { if (current) setMatches({ query: term, entries }); })
        .catch(() => { if (current) setMatches({ query: term, entries: [] }); });
    }, 120);
    return () => { current = false; clearTimeout(timer); };
  }, [term, workspaceId]);
  const toggle = (folder) => {
    setOpen(current => { const next = new Set(current); if (next.has(folder)) next.delete(folder); else next.add(folder); return next; });
    if (!folders.has(folder)) void load(folder);
  };
  /** A folder found by the filter opens in the tree, with every folder above it. */
  const reveal = (folder) => {
    const chain = folder.split('/').map((_, index, parts) => parts.slice(0, index + 1).join('/'));
    setOpen(current => new Set([...current, ...chain]));
    for (const part of chain) if (!folders.has(part)) void load(part);
    setQuery('');
  };
  const rows = (folder, depth) => (folders.get(folder)?.entries ?? []).map(entry => entry.kind === 'directory'
    ? <li key={entry.path}>
      <button type="button" className="explorer-row" style={{ paddingLeft: `${10 + depth * 14}px` }} aria-expanded={open.has(entry.path)} title={entry.path} onClick={() => toggle(entry.path)}><Icon name="chevron" size={12} className={`explorer-chevron${open.has(entry.path) ? ' open' : ''}`} /><span>{basename(entry.path)}</span></button>
      {open.has(entry.path) && <ul>{rows(entry.path, depth + 1)}</ul>}
    </li>
    : <li key={entry.path}><button type="button" className="explorer-row explorer-file" style={{ paddingLeft: `${12 + depth * 14}px` }} title={entry.path} onClick={() => onOpen(entry.path)}><FileBadge name={entry.path} /><span>{basename(entry.path)}</span></button></li>);
  const root = folders.get('');
  return <aside className="explorer-tree" aria-label="Project files">
    <div className="explorer-filter"><Icon name="search" size={14} /><input type="search" value={query} placeholder={`Filter ${name}`} aria-label="Filter files" spellCheck={false} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape' && query) { event.preventDefault(); setQuery(''); } }} />{onPick && <button type="button" aria-label="Open a file from disk" title="Open a file from disk" onClick={onPick}><Icon name="folderOpen" size={14} /></button>}</div>
    {term
      ? <ul className="explorer-root explorer-matches" aria-label="Matching files">
        {(matches?.query === term ? matches.entries : []).map(entry => <li key={entry.path}><button type="button" className="explorer-row explorer-file" title={entry.path} onClick={() => entry.kind === 'directory' ? reveal(entry.path) : onOpen(entry.path)}>{entry.kind === 'directory' ? <Icon name="folder" size={13} className="file-badge-plain" /> : <FileBadge name={entry.path} />}<span>{basename(entry.path)}</span>{entry.path.includes('/') && <small>{entry.path.slice(0, entry.path.lastIndexOf('/'))}</small>}</button></li>)}
        {matches?.query === term && !matches.entries.length && <li className="panel-note">No files match.</li>}
      </ul>
      : <ul className="explorer-root">{rows('', 0)}</ul>}
    {!term && root?.error && <p className="panel-note">{root.error}</p>}
    {!term && root && !root.entries.length && !root.error && <p className="panel-note">This folder is empty.</p>}
  </aside>;
}
