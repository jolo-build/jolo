import { useEffect, useId, useRef, useState } from 'react';
import { Icon } from './icon.jsx';

export function FileOpenMenu({ file, onError }) {
  const id = useId(), menu = useRef(null), trigger = useRef(null);
  const [open, setOpen] = useState(false), [choices, setChoices] = useState(null), [loadError, setLoadError] = useState(null);
  const params = { sessionId: file.sessionId ?? null, projectId: file.projectId, workspaceId: file.workspaceId, path: file.path };
  useEffect(() => {
    if (!open) return;
    let active = true;
    setChoices(null); setLoadError(null);
    if (!window.jolo.fileApplications) { setLoadError('Restart Jolo to load applications.'); return; }
    window.jolo.fileApplications(params).then(reply => {
      if (!active) return;
      if (!reply.ok) throw new Error(reply.error || 'Could not load applications.');
      setChoices(reply.result);
    }).catch(error => { if (active) setLoadError(error.message); });
    return () => { active = false; };
  }, [open, file]);
  const dismiss = () => { menu.current.hidePopover(); trigger.current.focus(); };
  const act = async (action, application) => {
    dismiss(); onError(null);
    try {
      if (!window.jolo.fileApplicationAction) throw new Error('Restart Jolo to open this file.');
      const reply = await window.jolo.fileApplicationAction({ ...params, action, application });
      if (!reply.ok) throw new Error(reply.error || 'Could not open this file.');
    } catch (error) { onError(error.message); }
  };
  return <>
    <button ref={trigger} className="file-open-trigger" aria-haspopup="menu" aria-expanded={open} popoverTarget={id} onClick={() => {
      const rect = trigger.current.getBoundingClientRect();
      menu.current.style.top = `${rect.bottom + 6}px`;
      menu.current.style.left = `${Math.max(8, Math.min(innerWidth - 272, rect.right - 264))}px`;
    }}>Open with<Icon name="down" size={12} /></button>
    <div ref={menu} id={id} className="panel-menu file-app-menu" popover="auto" role="menu" aria-label="Open file with" onToggle={event => { setOpen(event.newState === 'open'); }} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(); return; }
      if (event.key === 'Tab') { menu.current.hidePopover(); return; }
      const items = [...event.currentTarget.querySelectorAll(/** @type {'button'} */ ('button:not(:disabled)'))];
      const index = items.findIndex(item => item === document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowDown' ? (index + 1) % items.length : event.key === 'ArrowUp' ? (index - 1 + items.length) % items.length : -1;
      if (next >= 0) { event.preventDefault(); items[next]?.focus(); }
    }}>
      {loadError || choices?.error ? <p role="status">{loadError || choices.error}</p> : !choices && <p role="status">Loading apps…</p>}
      <div className="file-app-list" role="group" aria-label="Compatible applications">
        {choices?.apps.map(application => <button role="menuitem" key={application.path} title={application.path} onClick={() => void act('application', application.path)}>
          {application.icon ? <img src={application.icon} alt="" /> : <Icon name="file" size={20} />}<span>{application.name === 'Visual Studio Code' ? 'VS Code' : application.name}</span>{application.preferred && <small>Default</small>}
        </button>)}
      </div>
      {choices && !choices.apps.length && !choices.error && <p role="status">No compatible apps found.</p>}
      {file.canOpenExternally && <button role="menuitem" onClick={() => void act('default', undefined)}><Icon name="folderOpen" size={20} /><span>Default app</span></button>}
      {choices?.canChoose && <button role="menuitem" onClick={() => void act('choose', undefined)}><Icon name="plus" size={20} /><span>Choose another app…</span></button>}
      <hr />
      <button role="menuitem" onClick={() => void act('reveal', undefined)}><Icon name="folder" size={20} /><span>Open in folder</span></button>
      <button role="menuitem" disabled={!choices?.githubUrl} title={choices?.githubUrl ? 'Open the committed version on GitHub' : 'No tracked GitHub location for this file'} onClick={() => void act('github', undefined)}><Icon name="branch" size={20} /><span>Open in GitHub</span></button>
      <button role="menuitem" onClick={() => void act('save', undefined)}><Icon name="download" size={20} /><span>Save as…</span></button>
    </div>
  </>;
}
