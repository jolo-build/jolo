import { useEffect, useState } from "react";
import { Modal } from "./modal.jsx";
import { Icon } from "./icon.jsx";
import { basename } from "../presentation.js";
import { engineCall } from "../engine-context.jsx";

export function PanePicker({ project, sessionId, board, onOpen, onClose }) {
  const [path, setPath] = useState(project?.rootPath ?? "");
  const [sessions, setSessions] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState(false);
  const paths = [...new Set([project?.rootPath, path, ...(board?.projects ?? []).map((row) => row.rootPath)].filter(Boolean))];
  useEffect(() => {
    let cancelled = false;
    setSessions([]); setError(null);
    if (!path) return;
    setLoading(true);
    void engineCall("project.open", { path }).then((opened) => engineCall("session.list", { projectId: opened.projectId, state: "open" }))
      .then(({ sessions }) => { if (!cancelled) setSessions(sessions); })
      .catch((error) => { if (!cancelled) setError(error.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [path]);
  const open = async (id) => {
    if (!path || opening) return;
    setOpening(true); setError(null);
    try { await onOpen(path, id); onClose(); }
    catch (error) { setError(error.message); setOpening(false); }
  };
  return <Modal label="Choose a project and task" className="pane-picker" onClose={onClose}>
    <div className="picker-heading"><div><h2>Open in this pane</h2><p className="muted">Choose a project, then start or continue a task.</p></div><button onClick={onClose} aria-label="Close project picker"><Icon name="close" /></button></div>
    <div className="picker-columns">
      <nav aria-label="Projects"><span className="picker-label">Projects</span>{paths.map((item) => <button key={item} aria-pressed={path === item} title={item} onClick={() => setPath(item)} disabled={opening}><Icon name="folder" size={14} /><span>{basename(item)}</span></button>)}<button className="picker-browse" disabled={opening} onClick={async () => { try { const next = await window.jolo.openFolder(); if (next) setPath(next); } catch (error) { setError(error.message); } }}><Icon name="plus" size={14} />Open folder…</button></nav>
      <div className="picker-tasks"><span className="picker-label">{path ? basename(path) : "Tasks"}</span>{path ? <>
        <button className="picker-new" disabled={loading || opening || Boolean(error)} onClick={() => open(null)}><Icon name="plus" size={15} />New task<span className="grow" /><Icon name="right" size={14} /></button>
        {loading ? <p className="hint">Loading tasks…</p> : sessions.map((session) => <button key={session.id} disabled={opening} className="picker-task" onClick={() => open(session.id)}><span><strong>{session.title || "New task"}</strong><small>{new Date(session.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</small></span>{project?.rootPath === path && sessionId === session.id && <Icon name="check" size={14} />}</button>)}
        {!loading && !sessions.length && <p className="hint">No tasks yet. Start something new.</p>}
      </> : <p className="hint">Choose a folder to get started.</p>}</div>
    </div>
    {error && <p role="alert" className="negative">{error}</p>}
  </Modal>;
}
