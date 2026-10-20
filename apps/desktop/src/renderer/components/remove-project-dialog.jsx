import { useState } from 'react';
import { Modal } from './modal.jsx';

/** Forget a folder in the sidebar. One line is enough: nothing on disk changes and its chats stay in history. */
export function RemoveProjectDialog({ name, onSubmit, onClose }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const submit = async (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(null);
    try { await onSubmit(); onClose(); }
    catch (e) { setError(e.message); setBusy(false); }
  };
  return <Modal label="Remove from sidebar" onClose={() => { if (!busy) onClose(); }}>
    <form className="task-dialog remove-project" onSubmit={submit}>
      <h2>Remove “{name}” from the sidebar?</h2>
      <p>Its chats are kept in history, and nothing on disk changes.</p>
      {error && <p className="negative" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" autoFocus onClick={onClose} disabled={busy}>Cancel</button><button type="submit" className="primary" disabled={busy}>{busy ? 'Removing…' : 'Remove'}</button></div>
    </form>
  </Modal>;
}
