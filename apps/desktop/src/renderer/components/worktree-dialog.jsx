import { useState } from "react";
import { Modal } from "./modal.jsx";
import { Icon } from "./icon.jsx";

const stamp = () => { const d = new Date(); const p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; };

/** Start a task in its own Git worktree: a new branch from a recorded commit, in a Jolo-owned directory (§9.1). */
export function WorktreeDialog({ projectName, onSubmit, onClose }) {
  const [branch, setBranch] = useState(`jolo/${stamp()}`);
  const [base, setBase] = useState("HEAD");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const submit = async (event) => {
    event.preventDefault();
    if (busy || !branch.trim()) return;
    setBusy(true); setError(null);
    try { await onSubmit({ branch: branch.trim(), base: base.trim() || "HEAD" }); onClose(); }
    catch (e) { setError(e.message); setBusy(false); }
  };
  return <Modal label="New task in a worktree" onClose={() => { if (!busy) onClose(); }}>
    <form className="task-dialog" onSubmit={submit}>
      <div className="modal-eyebrow"><Icon name="branch" />{projectName}</div>
      <h2>New task in a worktree</h2>
      <p className="muted">The task gets its own checkout on a new branch, so it never collides with your working files or another task.</p>
      <label>Branch<input autoFocus value={branch} maxLength={120} spellCheck={false} onFocus={(e) => e.target.select()} onChange={(e) => setBranch(e.target.value)} disabled={busy} /></label>
      <label>Start from<input value={base} maxLength={120} spellCheck={false} placeholder="HEAD" onChange={(e) => setBase(e.target.value)} disabled={busy} /></label>
      <p className="hint">Starts from that commit. Uncommitted changes in the main checkout are not copied.</p>
      {error && <p className="negative" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" className="primary" disabled={busy || !branch.trim()}>{busy ? "Creating…" : "Create worktree"}</button></div>
    </form>
  </Modal>;
}
