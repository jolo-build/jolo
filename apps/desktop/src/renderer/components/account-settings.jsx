import { useCallback, useEffect, useRef, useState } from 'react';
import { engineCall, useEngineConnection } from '../engine-context.jsx';

export function AccountPanel({ account, connected, busy, error, server, onServer, onLogin, onConnectTasks, onSync = () => {}, onRemote = () => {}, onApprovals = () => {}, onCancel, onLogout, onRefresh, onOpen }) {
  const pending = account?.pending;
  return <section className="settings-card account-settings" aria-label="Jolo account">
    {!connected ? <p role="status">Connect to the Jolo engine to manage your account.</p> : !account ? <p role="status">Loading your account…</p> : account.state === 'signed_in' ? <>
      <div className="account-row" data-state="signed_in"><div><strong>{account.account.name}</strong><span className="hint">{account.account.email} · {account.device.name}</span></div><button type="button" className="link-button" disabled={busy} onClick={onLogout}>Sign out</button></div>
      {account.source === 'session' && <p className="hint" role="status">Your OS keychain is unavailable. This sign-in lasts only while the engine runs.</p>}
      <div className="account-row"><span><span>Chat sync</span>{account.sync?.enabled ? (account.sync.error || !account.sync.lastSyncedAt) && <span className="hint" role="status">{account.sync.error || 'Waiting to sync chat history…'}</span> : <span className="hint">Chat sync keeps conversations with their projects and folders across devices. Link each synced folder to its local checkout on a new device. Files, tool output, and credentials stay local.</span>}</span><input type="checkbox" role="switch" aria-label="Chat sync" checked={Boolean(account.sync?.enabled)} disabled={busy} onChange={onSync} /></div>
      <div className="account-row"><span><span>Web prompts</span>{account.remote?.enabled ? <span className="hint" role="status">{account.remote.error || (account.remote.connected ? 'Online · send prompts from your synced chats on the web' : 'Connecting…')}</span> : <span className="hint">Continue synced chats from the Jolo website while Jolo is open here. Runs use this device’s existing permissions; anything new waits for your approval on this device.</span>}</span><input type="checkbox" role="switch" aria-label="Web prompts" checked={Boolean(account.remote?.enabled)} disabled={busy} onChange={onRemote} /></div>
      {account.remote?.enabled && <div className="account-row"><span><span>Approve from the web</span><span className="hint">{account.remote.approvals ? 'Requests from web prompts can be allowed once or denied on the website, or here.' : 'Requests from web prompts wait for you on this device.'}</span></span><input type="checkbox" role="switch" aria-label="Approve from the web" checked={Boolean(account.remote.approvals)} disabled={busy} onChange={onApprovals} /></div>}
      <div className="account-row"><span>Web tasks</span>{account.device.scopes?.includes('tasks:read') ? <span className="hint">Connected · type # in chat</span> : <button type="button" disabled={busy} onClick={onConnectTasks}>Connect tasks</button>}</div>
      <button type="button" className="link-button" onClick={() => onOpen(`${account.origin}/account`)}>Manage devices, chats and tasks online ↗</button>
    </> : pending ? <>
      <h2>Approve this device</h2><p>Sign in in your browser, then confirm that the code matches.</p>
      <p className="account-device-code" aria-label="Device code">{pending.userCode}</p>
      <p className="hint" role="status">Waiting for approval from {account.origin}</p>
      <div className="account-actions"><button type="button" className="primary" disabled={busy} onClick={() => onOpen(pending.verificationUriComplete)}>Open sign-in page</button><button type="button" disabled={busy} onClick={onCancel}>Cancel sign-in</button></div>
    </> : <>
      <h2>Your Jolo account</h2><p>Sign in through {server} in your browser using GitHub. Jolo works locally without signing in.</p>
      <button type="button" className="primary" disabled={busy} onClick={onLogin}>{busy ? 'Starting sign-in…' : 'Sign in to Jolo'}</button>
      <details className="settings-advanced"><summary>Account server</summary><label>Server URL<input type="url" value={server} onChange={event => onServer(event.target.value)} spellCheck={false} autoComplete="off" disabled={busy} /></label><p className="hint">Change this when using a self-hosted account service.</p></details>
    </>}
    {account?.note && <p className="hint" role="status">{account.note}{account.state === 'signed_in' && <> <button type="button" className="link-button" onClick={onRefresh}>Retry</button></>}</p>}
    {error && <p className="settings-save-error" role="alert">{error}</p>}
  </section>;
}

export function AccountSettings() {
  const { engine } = useEngineConnection();
  const [account, setAccount] = useState(null), [error, setError] = useState(null), [busy, setBusy] = useState(false);
  const [server, setServer] = useState('https://access.jolo.build');
  const mounted = useRef(true), reading = useRef(null);
  const generation = useRef(0);
  const refresh = useCallback(async (force = false, preserveError = false) => {
    if (reading.current) return reading.current;
    const current = generation.current;
    reading.current = engineCall('account.status', { refresh: force }).then(value => {
      if (mounted.current && current === generation.current) { setAccount(value); if (!preserveError || value.pending) setError(null); }
      return value;
    }).catch(error => {
      if (mounted.current && current === generation.current) setError(error.code === 'unknown_method' ? 'Restart the engine to enable Jolo account sign-in.' : error.message);
    }).finally(() => { reading.current = null; });
    return reading.current;
  }, []);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (account?.origin) setServer(account.origin); }, [account?.origin]);
  useEffect(() => {
    if (!engine.connected) { setAccount(null); return; }
    void refresh();
    const off = window.jolo.onEvents(items => { if (items.some(item => item.kind === 'event' && item.value.type === 'account.changed')) void refresh(); });
    return off;
  }, [engine.connected, refresh]);
  useEffect(() => {
    if (!engine.connected || !account || account.state === 'signed_out') return;
    const timer = setInterval(() => { void refresh(); }, account.state === 'pending' ? 2000 : 60_000);
    return () => clearInterval(timer);
  }, [engine.connected, account?.state, refresh]);
  const open = async url => {
    try { await window.jolo.openExternal(url); }
    catch { if (mounted.current) setError('Could not open your browser. Try Open sign-in page again.'); }
  };
  const act = async (method, params = {}) => {
    if (busy) return;
    generation.current++;
    setBusy(true); setError(null);
    try {
      const value = await engineCall(method, params);
      if (mounted.current) setAccount(value);
      if (method === 'account.login' && value.pending) await open(value.pending.verificationUriComplete);
    } catch (error) {
      if (mounted.current) setError(error.message === `timeout: ${method}`
        ? 'The account connection timed out. Check your connection and try again. If this continues, restart Jolo.'
        : error.message);
      // A late device-code response may have succeeded after the client timed out.
      // Recover its approval link instead of leaving the UI signed out indefinitely.
      if (method === 'account.login') void refresh(false, true);
    }
    finally { if (mounted.current) setBusy(false); }
  };
  return <AccountPanel account={account} connected={engine.connected} busy={busy} error={error} server={server} onServer={setServer} onLogin={() => act('account.login', { origin: server.trim().replace(/\/$/, '') })} onConnectTasks={() => act('account.login', { tasks: true })} onSync={() => account?.device?.scopes.includes('chats:sync') ? act('account.sync', { enabled: !account.sync?.enabled }) : act('account.login', { chats: true })} onApprovals={() => act('account.remote', { approvals: !account.remote?.approvals })} onRemote={() => account?.device?.scopes.includes('prompts:run') ? act('account.remote', { enabled: !account.remote?.enabled }) : act('account.login', { remote: true })} onCancel={() => act('account.cancel')} onLogout={() => act('account.logout')} onRefresh={() => refresh(true)} onOpen={open} />;
}
