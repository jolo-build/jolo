import { useEffect, useState } from "react";
import { Icon } from "./icon.jsx";
import { StopIndicator } from "./stop-indicator.jsx";
import { JoloMark } from "./brand.jsx";
import { branchLabel, checksLabel, elapsedLabel, relativeTime, stateLabel, summaryLine, clip } from "@jolo/client/board";

const GROUPS = [["needs_you", "Needs attention"], ["done", "Recently completed"], ["running", "In progress"], ["idle", "Projects"]];
const chipClass = (row) => row.attention === "needs_you" ? "chip needs" : row.attention === "running" ? "chip running" : row.reason === "completed" ? "chip good" : "chip";
const checksClass = (row) => ({ passed: "chip good", failed: "chip needs" })[row.run?.verification?.status] ?? "chip";
const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);

function ProjectStatus({ row }) {
  const state = row.run?.state;
  const status = row.pendingPermission || state === "awaiting_permission" || state === "paused" && row.run.pauseReason === "permission" ? "attention"
    : ["preparing", "model", "tools", "cancelling"].includes(state) ? "running"
    : state === "completed" ? "done"
    : state === "failed" ? "failed"
    : state === "paused" || state === "interrupted" ? "paused"
    : state === "cancelled" ? "stopped"
    : state === "queued" ? "queued" : "ready";
  return <span className={`board-progress ${status}`} aria-hidden="true">
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle className="board-progress-track" cx="12" cy="12" r="9" />
      {status === "running" && <circle className="board-progress-arc" cx="12" cy="12" r="9" strokeDasharray="19 38" />}
      {status === "done" && <path d="m8 12 2.6 2.6L16 9" />}
      {status === "attention" && <path d="M12 7.5v5M12 16h.01" />}
      {status === "failed" && <path d="m9 9 6 6m0-6-6 6" />}
      {status === "paused" && <path d="M9.5 8.5v7m5-7v7" />}
      {status === "stopped" && <rect x="9" y="9" width="6" height="6" rx=".6" fill="currentColor" stroke="none" />}
    </svg>
  </span>;
}

function Question({ row, onDecide }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const request = row.pendingPermission;
  const decide = async (decision) => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await onDecide(decision); } catch (e) { setError(e.message); setBusy(false); }
  };
  return <div className="board-question">
    <div className="label">Pending question</div>
    <div>Run this command in <code>{request.cwd}</code>?</div>
    <pre>{request.argv ? request.argv.join(" ") : request.script ?? request.summary}</pre>
    {error && <p className="negative" role="alert">{error}</p>}
    <div className="modal-actions"><button className="primary" disabled={busy} onClick={() => decide("allow_once")}>Allow once</button><button className="outline" disabled={busy} onClick={() => decide("allow_run")}>Allow for task</button><button className="outline" disabled={busy} onClick={() => decide("deny")}>Deny</button></div>
  </div>;
}

function Detail({ row, now, onOpen, onDecide, onStop, onResume }) {
  const run = row.run;
  return <div className="board-detail" id={`board-detail-${row.workspaceId}`} role="region" aria-label={`${row.name} details`}>
    <div>
      <div><div className="label">Where you left off</div><div className="lead">{row.summary}</div></div>
      {run && <div><div className="label">Task</div><div>{run.prompt}</div></div>}
      {row.actions.length > 0 && <div><div className="label">Last actions</div><div className="action-list">{row.actions.map((action) => <div key={action.invocationId} className={`action-row ${action.status}`}><code title={action.preview}>{action.name} · {clip(action.preview.startsWith(action.name) ? action.preview.slice(action.name.length) : action.preview, 110)}</code><span>{action.status === "running" ? "running" : action.status === "ok" ? time(action.at) : action.status}</span></div>)}</div></div>}
      {row.nextStep && <div><div className="label">Next step</div><div>{row.nextStep}</div></div>}
    </div>
    <div>
      {row.pendingPermission && <Question row={row} onDecide={onDecide} />}
      {run && <div><div className="label">Changed files</div><div>{row.changedFiles === 0 ? "None" : `${row.changedFiles} file${row.changedFiles === 1 ? "" : "s"}`}</div></div>}
      {run && <div><div className="label">Checks</div><div className="board-checks"><span className={checksClass(row)}>{capitalize(checksLabel(row))}</span>{run.verification?.checks?.length > 0 && <span className="muted">last {time(run.verification.checks.at(-1).at)}</span>}</div></div>}
      {run && <div><div className="label">Started</div><div>{relativeTime(run.createdAt, now)} · {elapsedLabel(row, now)}</div></div>}
      <div className="board-actions detail-actions">
        <button className="primary" onClick={onOpen}>{run ? "Open task" : "Open project"}<Icon name="right" size={14} /></button>
        {run && (run.state === "paused" && run.pauseReason !== "permission" || run.state === "interrupted") && <button className="outline" onClick={onResume}>Resume</button>}
        {run && ["queued", "preparing", "model", "tools", "awaiting_permission"].includes(run.state) && <button className="stop-button" onClick={onStop}><StopIndicator size={18} />Stop</button>}
      </div>
    </div>
  </div>;
}

function Row({ row, now, expanded, onToggle, onOpen, onDecide, onStop, onResume }) {
  const run = row.run;
  const branch = branchLabel(row);
  return <div className={`board-card${expanded ? " expanded" : ""}`}>
    <div className="board-row">
      <button className="board-project" aria-expanded={expanded} aria-controls={expanded ? `board-detail-${row.workspaceId}` : undefined} onClick={onToggle} title={`Show details for ${row.name}`}>
        <ProjectStatus row={row} />
        <span className="board-title">
          <span className="board-name-line"><span className="name">{row.name}</span>{row.workspace.mode === "worktree" && <span className="worktree-tag">worktree</span>}{branch !== "—" && <span className="branch" title={branch}><Icon name="branch" size={12} />{branch}</span>}</span>
          <span className={`prompt${run ? "" : " no-task"}`} title={run?.prompt}>{run ? run.prompt : "Ready for a new task"}</span>
          {run && <span className="board-meta"><span><Icon name="clock" size={11} />{elapsedLabel(row, now)} run</span><span className={run.verification?.status === "failed" ? "negative" : ""}>Checks {checksLabel(row)}</span>{row.changedFiles > 0 && <span>{row.changedFiles} {row.changedFiles === 1 ? "file changed" : "files changed"}</span>}</span>}
        </span>
      </button>
      <div className="board-state">
        <span className={chipClass(row)} title={row.summary}>{run?.state === "tools" ? "Running tools" : run ? capitalize(stateLabel(row)) : "Ready"}</span>
        {row.lastActivityAt && <span className="board-updated" title={`Last activity: ${new Date(row.lastActivityAt).toLocaleString()}`}>{relativeTime(row.lastActivityAt, now)}</span>}
      </div>
      <div className="board-actions">
        <button className={row.pendingPermission ? "primary" : "board-open"} onClick={onOpen} aria-label={`${row.pendingPermission ? "Review request for" : "Open"} ${row.name}`}>{row.pendingPermission ? "Review" : "Open"}<Icon name="right" size={13} /></button>
        <button className="board-expand" onClick={onToggle} aria-expanded={expanded} aria-label={`${expanded ? "Collapse" : "Expand"} ${row.name}`}><Icon name="down" size={14} className={expanded ? "flipped" : ""} /></button>
      </div>
    </div>
    {expanded && <Detail row={row} now={now} onOpen={onOpen} onDecide={onDecide} onStop={onStop} onResume={onResume} />}
  </div>;
}

export function Board({ board, connected, onOpen, onDecide, onStop, onResume, onOpenFolder }) {
  const [now, setNow] = useState(Date.now());
  const [expanded, setExpanded] = useState(null);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(timer); }, []);
  useEffect(() => { setNow(Date.now()); }, [board]);
  const rows = board?.projects ?? [];
  const groups = GROUPS.map(([key, title]) => ({ key, title, rows: rows.filter((row) => row.attention === key) })).filter((group) => group.rows.length);
  return <div className="board" aria-label="Work board">
    <div className="board-content">
    <div className="board-head"><div><div className="eyebrow">Workspace overview</div><h1>Your projects<span className="board-total">{rows.length}</span></h1><p><span className={`state-dot ${connected ? "" : "offline"}`} />{connected ? rows.length ? capitalize(summaryLine(rows)) : "A place for your next idea." : "Connecting to the engine…"}</p></div><button className="outline board-add" onClick={onOpenFolder}><Icon name="plus" size={14} />Open project</button></div>
    {!rows.length && board && <div className="empty-state"><JoloMark className="welcome-mark" /><h2>Nothing on the board yet.</h2><p>Open a project and give Jolo a task. Every project you work on shows up here with what it needs from you.</p><button onClick={onOpenFolder} className="outline"><Icon name="folder" />Open a folder</button></div>}
    {groups.map((group) => <section key={group.key} className={`board-group ${group.key}`}><h2>{group.title}<span>{group.rows.length}</span></h2><div className="board-list">{group.rows.map((row) => <Row key={row.workspaceId} row={row} now={now} expanded={expanded === row.workspaceId} onToggle={() => setExpanded(expanded === row.workspaceId ? null : row.workspaceId)} onOpen={() => onOpen(row)} onDecide={(decision) => onDecide(row, decision)} onStop={() => onStop(row)} onResume={() => onResume(row)} />)}</div></section>)}
    </div>
  </div>;
}
