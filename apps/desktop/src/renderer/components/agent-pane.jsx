import { useState } from "react";
import { Icon } from "./icon.jsx";
import { TerminalPane } from "./terminal-pane.jsx";

// Hosting another vendor's coding agent. Jolo starts it in this workspace and shows
// what it can observe. It never answers a prompt for you, so every status says where it came from.
const STATUS_LABEL = { starting: "Starting", working: "Working", needs_input: "Needs you", idle: "Waiting", done: "Finished" };
const SOURCE_NOTE = {
  process: "reported by the process itself",
  screen: "read from what it printed, so it can be wrong",
  silence: "guessed from how long it has been quiet",
};
const statusClass = (status) => (status === "needs_input" ? "chip needs" : status === "working" || status === "starting" ? "chip running" : status === "done" ? "chip good" : "chip");

function Chooser({ catalog, onStart, busy }) {
  const installed = catalog.filter((entry) => entry.available);
  const missing = catalog.filter((entry) => !entry.available);
  return <div className="agent-chooser">
    <p className="hint">Run another coding agent inside this project. It works in the same folder with your own access, and Jolo watches without steering it.</p>
    {installed.map((entry) => <button key={entry.id} className="agent-option" disabled={busy} onClick={() => onStart(entry.id)}>
      <span><strong>{entry.displayName}</strong><small>{entry.transport !== "pty" ? "Answers your prompts as a task; its permission requests come to you here." : entry.description || entry.binary}</small></span><Icon name="right" size={14} />
    </button>)}
    {missing.length > 0 && <div className="agent-missing">
      <span className="picker-label">Not installed</span>
      {missing.map((entry) => <span key={entry.id} title={`${entry.binary} was not found on the engine's PATH`}>{entry.displayName}</span>)}
    </div>}
  </div>;
}

export function AgentPane({ workspaceId, paneId, catalog, agents, selectedId, onSelect, onStart, onStop, onStartSession }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const selected = agents.find((agent) => agent.terminalId === selectedId) ?? null;
  const guard = (operation) => async (...args) => {
    setBusy(true); setError(null);
    try { await operation(...args); } catch (failure) { setError(failure.message); } finally { setBusy(false); }
  };
  const start = guard(async (agentId) => {
    // An agent with a structured transport answers in the composer as a task; a terminal agent runs here.
    if (catalog.find((entry) => entry.id === agentId)?.transport !== "pty" && onStartSession) { await onStartSession(agentId); return; }
    const agent = await onStart(agentId); onSelect(agent.terminalId);
  });
  return <div className="agent-pane">
    <div className="agent-bar">
      {agents.map((agent) => <button key={agent.terminalId} className={`agent-tab${agent.terminalId === selectedId ? " selected" : ""}`} onClick={() => onSelect(agent.terminalId)}>
        <span className={`state-dot ${agent.status === "needs_input" ? "offline" : agent.status === "done" ? "" : "working"}`} />{agent.displayName}
      </button>)}
      <button className="agent-tab" onClick={() => onSelect(null)} aria-pressed={!selectedId} title="Start another agent"><Icon name="plus" size={13} />Add</button>
      <span className="grow" />
      {selected && <>
        <span className={statusClass(selected.status)} title={SOURCE_NOTE[selected.statusSource]}>{STATUS_LABEL[selected.status] ?? selected.status}</span>
        <span className="hint agent-source">{SOURCE_NOTE[selected.statusSource]}</span>
        <button className="subtle-danger" disabled={busy} onClick={guard(() => onStop(selected.terminalId))}>{selected.status === "done" ? "Close" : "Stop"}</button>
      </>}
    </div>
    {error && <p className="panel-note negative" role="alert">{error}</p>}
    {selected
      ? <TerminalPane key={selected.terminalId} workspaceId={workspaceId} paneId={`${paneId}:${selected.terminalId}`} attachTo={selected.terminalId} />
      : <Chooser catalog={catalog} onStart={start} busy={busy} />}
  </div>;
}
