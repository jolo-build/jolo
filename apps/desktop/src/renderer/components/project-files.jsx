import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './icon.jsx';
import { projectFileKind } from '../project-file-kind.js';

function FileGlyph({ entry, expanded = false }) {
  if (entry.type === 'directory') return <Icon name={expanded ? 'folderOpen' : 'folder'} size={16} className="project-file-icon folder" />;
  if (entry.type === 'symlink') return <Icon name="link" size={15} className="project-file-icon muted" />;
  const visual = projectFileKind(entry.name);
  return <Icon name={visual.icon} size={15} className={`project-file-icon ${visual.tone}`} />;
}

function ProjectFileRow({ entry, depth, expanded, selected, onToggle, onOpen }) {
  const folder = entry.type === 'directory';
  return <div role="treeitem" aria-level={depth + 1} aria-expanded={folder ? expanded : undefined} aria-selected={!folder && selected}>
    <button className="project-file-row" data-folder={folder} data-selected={!folder && selected} style={{ paddingLeft: `${8 + depth * 16}px` }} title={entry.path} onClick={() => folder ? onToggle(entry.path) : onOpen(entry.path)} onKeyDown={event => {
      if (!folder || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      if (event.key === 'ArrowRight' && !expanded || event.key === 'ArrowLeft' && expanded) { event.preventDefault(); onToggle(entry.path); }
    }}>
      {folder ? <Icon name="chevron" size={12} className={`project-file-chevron${expanded ? ' expanded' : ''}`} /> : <span className="project-file-indent" />}
      <FileGlyph entry={entry} expanded={expanded} /><span>{entry.name}</span>
    </button>
  </div>;
}

export function ProjectFiles({ sessionId, projectId, workspaceId, rootName, available = true, selectedPath = null, onOpenFile }) {
  const [directories, setDirectories] = useState({});
  const [expanded, setExpanded] = useState(new Set());
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(new Set());
  const [errors, setErrors] = useState({});
  const generation = useRef(0);
  const load = useCallback(async (directory = '', force = false) => {
    if (!available || !window.jolo.listChatFiles || !force && directories[directory]) return;
    const ticket = generation.current;
    setLoading(previous => new Set(previous).add(directory));
    setErrors(previous => { const next = { ...previous }; delete next[directory]; return next; });
    try {
      const reply = await window.jolo.listChatFiles({ sessionId, projectId, workspaceId, path: directory });
      if (!reply.ok) throw new Error(reply.error || 'Could not load this folder.');
      if (generation.current === ticket) setDirectories(previous => ({ ...previous, [directory]: reply.result }));
    } catch (error) {
      if (generation.current === ticket) setErrors(previous => ({ ...previous, [directory]: error.message }));
    } finally {
      if (generation.current === ticket) setLoading(previous => { const next = new Set(previous); next.delete(directory); return next; });
    }
  }, [available, directories, projectId, sessionId, workspaceId]);
  useEffect(() => {
    generation.current += 1;
    setDirectories({}); setExpanded(new Set()); setSelected(null); setLoading(new Set()); setErrors({});
  }, [sessionId, projectId, workspaceId]);
  useEffect(() => { void load(''); }, [load]);
  const toggle = directory => {
    setExpanded(previous => { const next = new Set(previous); if (next.has(directory)) next.delete(directory); else next.add(directory); return next; });
    void load(directory);
  };
  const refresh = () => {
    const open = [...expanded];
    generation.current += 1;
    setDirectories({}); setErrors({}); setLoading(new Set());
    void load('', true);
    for (const directory of open) void load(directory, true);
  };
  const rows = [];
  const append = (directory, depth) => {
    const listing = directories[directory];
    for (const entry of listing?.entries ?? []) {
      const open = entry.type === 'directory' && expanded.has(entry.path);
      rows.push(<ProjectFileRow key={entry.path} entry={entry} depth={depth} expanded={open} selected={entry.path === (selectedPath ?? selected)} onToggle={toggle} onOpen={path => { setSelected(path); onOpenFile(path); }} />);
      if (!open) continue;
      if (loading.has(entry.path) && !directories[entry.path]) rows.push(<div className="project-file-state" style={{ paddingLeft: `${24 + (depth + 1) * 16}px` }} key={`${entry.path}:loading`}><Icon name="spinner" size={13} className="activity-spin" />Loading…</div>);
      else if (errors[entry.path]) rows.push(<button className="project-file-state negative" style={{ paddingLeft: `${24 + (depth + 1) * 16}px` }} key={`${entry.path}:error`} onClick={() => void load(entry.path, true)}>{errors[entry.path]} · Retry</button>);
      else append(entry.path, depth + 1);
      if (directories[entry.path]?.truncated) rows.push(<div className="project-file-state" style={{ paddingLeft: `${24 + (depth + 1) * 16}px` }} key={`${entry.path}:limit`}>Showing 2,000 of {directories[entry.path].total.toLocaleString()} entries</div>);
    }
  };
  append('', 0);
  if (!available) return <div className="panel-empty"><Icon name="folder" size={28} /><h2>No project files</h2><p>Open or link a workspace folder to browse its files.</p></div>;
  if (!window.jolo.listChatFiles) return <div className="panel-empty"><Icon name="folder" size={28} /><h2>Restart Jolo</h2><p>Restart the desktop app to enable the project file browser.</p></div>;
  const rootError = errors[''];
  return <section className="project-files" aria-label="Project files">
    <header className="project-files-header"><Icon name="folderOpen" size={16} /><strong title={rootName}>{rootName || 'Project'}</strong><span className="grow" /><button title="Refresh project files" aria-label="Refresh project files" onClick={refresh}><Icon name="refresh" size={14} /></button></header>
    {rootError ? <div className="panel-empty"><Icon name="alert" size={25} /><h2>Could not load files</h2><p>{rootError}</p><button onClick={() => void load('', true)}>Retry</button></div>
      : loading.has('') && !directories[''] ? <div className="project-files-loading"><Icon name="spinner" size={15} className="activity-spin" />Loading project files…</div>
      : <div className="project-file-tree" role="tree" aria-label={`${rootName || 'Project'} files`} onKeyDown={event => {
        if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
        const items = [...event.currentTarget.querySelectorAll('.project-file-row')].map(item => /** @type {HTMLButtonElement} */ (item));
        const current = items.findIndex(item => item === document.activeElement);
        if (current < 0) return;
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : Math.max(0, Math.min(items.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)));
        event.preventDefault(); items[next]?.focus();
      }}>{rows.length ? rows : <p className="project-file-empty">This folder is empty.</p>}{directories['']?.truncated && <p className="project-file-limit">Showing 2,000 of {directories[''].total.toLocaleString()} root entries.</p>}</div>}
  </section>;
}
