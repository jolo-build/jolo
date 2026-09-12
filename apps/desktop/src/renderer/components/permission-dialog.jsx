import { useRef, useState } from 'react';
import { Modal } from './modal.jsx';
import { Icon } from './icon.jsx';
import { Select } from './select.jsx';
export function PermissionDialog({ request, onDecide, workspacePath = null }) {
  const [scope, setScope] = useState('allow_once');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  const deciding = useRef(false);
  const allowButton = useRef(null);
  const command = request.argv?.join(' ').trim() || request.script?.trim();
  const directory = !request.cwd || request.cwd === '.' ? workspacePath || 'Current task folder' : request.cwd;
  const decide = async (decision) => {
    if (deciding.current) return;
    deciding.current = true;
    setPending(true); setError(null);
    try { await onDecide(decision); }
    catch (e) { deciding.current = false; setError(e.message); setPending(false); }
  };
  return <Modal label="Permission request" onClose={() => decide('deny')} initialFocus={allowButton} className="permission-modal" onKeyDown={event => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    // Holding Enter must not approve a second request that appears after this one.
    if (event.repeat || deciding.current) { event.preventDefault(); return; }
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    // Handle the primary action directly; other controls retain their native behavior.
    const control = /** @type {Element} */ (event.target).closest('button, select, input, textarea, [contenteditable="true"]');
    if (control && control !== allowButton.current) return;
    event.preventDefault();
    void decide(scope);
  }}>
    <div className="modal-eyebrow"><Icon name="shield" />{command ? 'Command permission' : 'Tool permission'}</div>
    <h2>{command ? 'Run this command?' : 'Allow this action?'}</h2>
    <p className="muted">Jolo needs your approval to continue this task.</p>
    <div className="command-card"><pre className="command">{command || request.summary || request.tool || 'Tool details unavailable'}</pre><div className="hint">Runs in: {directory}</div></div>
    <p className="hint">Runs with your account’s access. This action can read or change files outside this project.</p>
    <label className="permission-scope">Allow for<Select value={scope} onChange={(event) => setScope(event.target.value)} disabled={pending}><option value="allow_once">{command ? 'This command only' : 'This action only'}</option><option value="allow_run">This task</option><option value="allow_project">This project</option></Select></label>
    {error && <p className="negative" role="alert">{error}</p>}
    <div className="modal-actions"><button className="outline" disabled={pending} onClick={() => decide('deny')}>Don’t run</button><button ref={allowButton} className="primary" disabled={pending} onClick={() => decide(scope)}>{pending ? 'Applying…' : ({ allow_once: 'Allow once', allow_run: 'Allow for task', allow_project: 'Allow for project' })[scope]}</button></div>
  </Modal>;
}
