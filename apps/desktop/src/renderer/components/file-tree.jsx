import { useEffect, useRef, useState } from 'react';
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
 * What an arrow key does among the rows on screen, top to bottom: where focus goes, or which folder opens or closes.
 * Up and Down step between rows; Right opens a closed folder or steps into an open one; Left closes an open folder
 * or steps out to the folder above. Enter is the row's own button.
 * @param {{ path: string, folder: boolean, open: boolean }[]} rows
 * @param {number} index the focused row
 * @param {string} key
 * @returns {{ focus: string } | { toggle: string } | null}
 */
export function treeKey(rows, index, key) {
  const row = rows[index], next = rows[index + 1];
  if (!row) return null;
  if (key === 'ArrowDown') return next ? { focus: next.path } : null;
  if (key === 'ArrowUp') return index > 0 ? { focus: rows[index - 1].path } : null;
  if (key === 'ArrowRight') return !row.folder ? null : !row.open ? { toggle: row.path } : next?.path.startsWith(`${row.path}/`) ? { focus: next.path } : null;
  if (key !== 'ArrowLeft') return null;
  if (row.folder && row.open) return { toggle: row.path };
  const parent = row.path.slice(0, Math.max(0, row.path.lastIndexOf('/')));
  return rows.some(other => other.folder && other.path === parent) ? { focus: parent } : null;
}

/**
 * The project's files as a tree the user walks: a folder opens on click and is read once, a file opens as a tab.
 * Typing in the filter asks the engine for matches anywhere in the project and shows them as one flat list.
 * Folders are listed by the engine inside the workspace only, so the tree never leaves the project.
 * @param {{ call: (method: string, params?: any) => Promise<any>, workspaceId: string, name: string, active?: boolean, revision?: string, selectedPath?: string | null, reveal?: { path: string } | null, onOpen: (path: string) => void, onPick?: (() => void) | null }} props
 *   `active` says the tree is on screen, and `revision` moves when the workspace's files may have changed; both re-read the open folders.
 *   `selectedPath` is the open file, whose row is marked and kept in view. Each new `reveal` opens that folder with
 *   every folder above it and scrolls to it; a fresh object each time, so asking for the same folder twice still works.
 */
export function FileTree({ call, workspaceId, name, active = true, revision = '', selectedPath = null, reveal = null, onOpen, onPick = null }) {
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
  const tree = useRef(/** @type {HTMLElement | null} */ (null));
  const filter = useRef(/** @type {HTMLInputElement | null} */ (null));
  const scrollTo = useRef(/** @type {string | null} */ (null)); // a revealed folder, until its row is drawn
  const rowElements = () => /** @type {HTMLButtonElement[]} */ ([...(tree.current?.querySelectorAll('.explorer-row') ?? [])]);
  /** Scrolls the tree, and only the tree, so a row is in sight: centred if it was out of view, left alone if it was not. */
  const bring = (path) => {
    const row = rowElements().find(element => element.dataset.path === path);
    if (!row || !tree.current) return false;
    const box = tree.current.getBoundingClientRect(), place = row.getBoundingClientRect();
    if (place.top < box.top || place.bottom > box.bottom) tree.current.scrollTop += place.top - box.top - (box.height - place.height) / 2;
    return true;
  };
  /** A folder found by the filter or asked for by `reveal` opens in the tree, with every folder above it. */
  const revealFolder = (folder) => {
    const chain = folder.split('/').map((_, index, parts) => parts.slice(0, index + 1).join('/'));
    setOpen(current => new Set([...current, ...chain]));
    for (const part of chain) if (!folders.has(part)) void load(part);
    setQuery('');
    scrollTo.current = folder;
  };
  const shownReveal = useRef(reveal); // what was asked before this tree existed is not a new request
  useEffect(() => { if (reveal && reveal !== shownReveal.current) revealFolder(reveal.path); shownReveal.current = reveal; }, [reveal]);
  useEffect(() => { if (active && selectedPath) bring(selectedPath); }, [selectedPath, active]);
  useEffect(() => { if (active && !term && scrollTo.current && bring(scrollTo.current)) scrollTo.current = null; });
  /** Arrow keys walk the rows on screen; from the first row, Up goes back to the filter. */
  const onRowKey = (/** @type {import('react').KeyboardEvent} */ event) => {
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    const elements = rowElements(), index = elements.indexOf(/** @type {any} */ (event.target));
    if (index < 0) return;
    event.preventDefault();
    if (event.key === 'ArrowUp' && index === 0) { filter.current?.focus(); return; }
    const move = treeKey(elements.map(element => ({ path: element.dataset.path, folder: element.hasAttribute('aria-expanded'), open: element.getAttribute('aria-expanded') === 'true' })), index, event.key);
    if (!move) return;
    if ('toggle' in move) { toggle(move.toggle); return; }
    const target = move.focus;
    elements.find(element => element.dataset.path === target)?.focus();
  };
  const rows = (folder, depth) => (folders.get(folder)?.entries ?? []).map(entry => entry.kind === 'directory'
    ? <li key={entry.path}>
      <button type="button" className="explorer-row" data-path={entry.path} style={{ paddingLeft: `${10 + depth * 14}px` }} aria-expanded={open.has(entry.path)} title={entry.path} onClick={() => toggle(entry.path)}><Icon name="chevron" size={12} className={`explorer-chevron${open.has(entry.path) ? ' open' : ''}`} /><span>{basename(entry.path)}</span></button>
      {open.has(entry.path) && <ul style={/** @type {import('react').CSSProperties} */ ({ '--guide': `${16 + depth * 14}px` })}>{rows(entry.path, depth + 1)}</ul>}
    </li>
    : <li key={entry.path}><button type="button" className="explorer-row explorer-file" data-path={entry.path} style={{ paddingLeft: `${12 + depth * 14}px` }} aria-current={entry.path === selectedPath || undefined} title={entry.path} onClick={() => onOpen(entry.path)}><FileBadge name={entry.path} /><span>{basename(entry.path)}</span></button></li>);
  const root = folders.get('');
  return <aside className="explorer-tree" aria-label="Project files" ref={tree}>
    <div className="explorer-filter"><Icon name="search" size={14} /><input ref={filter} type="search" value={query} placeholder={`Filter ${name}`} aria-label="Filter files" spellCheck={false} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape' && query) { event.preventDefault(); setQuery(''); } else if (event.key === 'ArrowDown' && rowElements().length) { event.preventDefault(); rowElements()[0].focus(); } }} />{onPick && <button type="button" aria-label="Open a file from disk" title="Open a file from disk" onClick={onPick}><Icon name="folderOpen" size={14} /></button>}</div>
    {term
      ? <ul className="explorer-root explorer-matches" aria-label="Matching files" onKeyDown={onRowKey}>
        {(matches?.query === term ? matches.entries : []).map(entry => <li key={entry.path}><button type="button" className="explorer-row explorer-file" data-path={entry.path} aria-current={(entry.kind !== 'directory' && entry.path === selectedPath) || undefined} title={entry.path} onClick={() => entry.kind === 'directory' ? revealFolder(entry.path) : onOpen(entry.path)}>{entry.kind === 'directory' ? <Icon name="folder" size={13} className="file-badge-plain" /> : <FileBadge name={entry.path} />}<span>{basename(entry.path)}</span>{entry.path.includes('/') && <small>{entry.path.slice(0, entry.path.lastIndexOf('/'))}</small>}</button></li>)}
        {matches?.query === term && !matches.entries.length && <li className="panel-note">No files match.</li>}
      </ul>
      : <ul className="explorer-root" onKeyDown={onRowKey}>{rows('', 0)}</ul>}
    {!term && root?.error && <p className="panel-note">{root.error}</p>}
    {!term && root && !root.entries.length && !root.error && <p className="panel-note">This folder is empty.</p>}
  </aside>;
}
