import { useEffect, useState } from 'react';
import { Icon } from './icon.jsx';
import { basename } from '../presentation.js';

/**
 * The project's files as a tree the user walks: a folder opens on click and is read once, a file opens as a tab.
 * Folders are listed by the engine inside the workspace only, so the tree never leaves the project.
 * @param {{ call: (method: string, params?: any) => Promise<any>, workspaceId: string, name: string, active?: boolean, revision?: string, onOpen: (path: string) => void, onPick?: (() => void) | null }} props
 *   `active` says the tree is on screen, and `revision` moves when the workspace's files may have changed; both re-read the open folders.
 */
export function FileTree({ call, workspaceId, name, active = true, revision = '', onOpen, onPick = null }) {
  const [folders, setFolders] = useState(() => new Map()); // folder path, '' for the root -> { entries, error }
  const [open, setOpen] = useState(() => new Set(['']));
  const load = (folder) => call('workspace.files', { workspaceId, path: folder, limit: 200 })
    .then(({ entries }) => setFolders(current => new Map(current).set(folder, { entries })))
    .catch(error => setFolders(current => new Map(current).set(folder, { entries: [], error: error.message })));
  useEffect(() => { setFolders(new Map()); setOpen(new Set([''])); void load(''); }, [workspaceId]);
  useEffect(() => { if (active) for (const folder of open) void load(folder); }, [active, revision]);
  const toggle = (folder) => {
    setOpen(current => { const next = new Set(current); if (next.has(folder)) next.delete(folder); else next.add(folder); return next; });
    if (!folders.has(folder)) void load(folder);
  };
  const rows = (folder, depth) => (folders.get(folder)?.entries ?? []).map(entry => entry.kind === 'directory'
    ? <li key={entry.path}>
      <button type="button" className="explorer-row" style={{ paddingLeft: `${10 + depth * 14}px` }} aria-expanded={open.has(entry.path)} title={entry.path} onClick={() => toggle(entry.path)}><Icon name="chevron" size={12} className={`explorer-chevron${open.has(entry.path) ? ' open' : ''}`} /><span>{basename(entry.path)}</span></button>
      {open.has(entry.path) && <ul>{rows(entry.path, depth + 1)}</ul>}
    </li>
    : <li key={entry.path}><button type="button" className="explorer-row explorer-file" style={{ paddingLeft: `${28 + depth * 14}px` }} title={entry.path} onClick={() => onOpen(entry.path)}><span>{basename(entry.path)}</span></button></li>);
  const root = folders.get('');
  return <div className="explorer-tree" aria-label="Project files">
    <div className="panel-heading"><strong title={name}>{name}</strong>{onPick && <button type="button" aria-label="Open a file from disk" title="Open a file from disk" onClick={onPick}><Icon name="folderOpen" size={14} /></button>}</div>
    {root?.error && <p className="panel-note">{root.error}</p>}
    <ul className="explorer-root">{rows('', 0)}</ul>
    {root && !root.entries.length && !root.error && <p className="panel-note">This folder is empty.</p>}
  </div>;
}
