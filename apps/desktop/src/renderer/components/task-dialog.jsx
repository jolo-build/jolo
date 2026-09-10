import { useState } from "react";
import { Modal } from "./modal.jsx";

export function TaskDialog({ session, action, workspace, onSubmit, onClose }) {
  const [title, setTitle] = useState(session.title || "New task");
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const rename = action === "rename";
  const worktree = action === "remove-worktree";
  const submit = async (event) => {
    event.preventDefault();
    if (busy || (rename && !title.trim())) return;
    setBusy(true);
    setError(null);
    try { await onSubmit(worktree ? { force } : title.trim()); onClose(); }
    catch (error) { setError(error.message); setBusy(false); }
  };
  const heading = rename ? "Rename task" : worktree ? "Remove worktree?" : "Delete task?";
  return <Modal label={heading} onClose={() => { if (!busy) onClose(); }}>
    <form className="task-dialog" onSubmit={submit}>
      <h2>{heading}</h2>
      {rename && <label>Task name<input autoFocus value={title} maxLength={200} onFocus={(event) => event.target.select()} onChange={(event) => setTitle(event.target.value)} disabled={busy} /></label>}
      {worktree && <>
        <p>Remove the checkout for <code>{workspace?.branch}</code>? The branch and its commits stay in Git; open terminals in it close. This task stays in your history but cannot run again.</p>
        <label className="check-label"><input type="checkbox" checked={force} onChange={(event) => setForce(event.target.checked)} disabled={busy} />Discard uncommitted changes in the worktree</label>
      </>}
      {!rename && !worktree && <p>Remove “{session.title || "New task"}” from your history? Project files stay in place. Execution records are retained for recovery.</p>}
      {error && <p className="negative" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" autoFocus={!rename} onClick={onClose} disabled={busy}>Cancel</button><button type="submit" className={rename ? "primary" : "danger"} disabled={busy || (rename && !title.trim())}>{busy ? "Working…" : rename ? "Save name" : worktree ? "Remove worktree" : "Delete task"}</button></div>
    </form>
  </Modal>;
}
