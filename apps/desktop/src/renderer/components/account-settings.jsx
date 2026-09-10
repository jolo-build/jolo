import { useCallback, useEffect, useRef, useState } from 'react';
import { engineCall, useEngineConnection } from '../engine-context.jsx';

export function AccountPanel({ account, connected, busy, error, server, onServer, onLogin, onConnectTasks, onCancel, onLogout, onRefresh, onOpen }) {
  const pending = account?.pending;
  return <section className="settings-card account-settings" aria-label="Jolo account">
    {!connected ? <p role="status">Connect to the Jolo engine to manage your account.</p> : !account ? <p role="status">Loading your account…</p> : account.state === 'signed_in' ? <>
      <div className="settings-card-heading"><div><h2>{account.account.name}</h2><p>{account.account.email}</p></div><span className="hint">Signed in</span></div>
      <p className="hint">This profile is connected as {account.device.name}.</p>
      {account.source === 'session' && <p className="hint" role="status">Your OS keychain is unavailable. This sign-in lasts only while the engine runs.</p>}
      <p className="hint">{account.device.scopes?.includes('tasks:read') ? 'Task access is connected. Type #JOLO- in chat to select a web task.' : 'Approve task access to reference your web tasks in chat.'}</p>
      <div className="account-actions">{account.device.scopes?.includes('tasks:read') ? <button type="button" onClick={() => onOpen(`${account.origin}/tasks`)}>Open tasks</button> : <button type="button" disabled={busy} onClick={onConnectTasks}>Connect tasks</button>}<button type="button" disabled={busy} onClick={() => onOpen(`${account.origin}/devices`)}>Manage devices</button><button type="button" disabled={busy} onClick={onRefresh}>Refresh account</button><button type="button" disabled={busy} onClick={onLogout}>Sign out</button></div>
    </> : pending ? <>
      <h2>Approve this device</h2><p>Sign in in your browser, then confirm that the code matches.</p>
      <p className="account-device-code" aria-label="Device code">{pending.userCode}</p>
      <p className="hint" role="status">Waiting for approval from {account.origin}</p>
      <div className="account-actions"><button type="button" className="primary" disabled={busy} onClick={() => onOpen(pending.verificationUriComplete)}>Open sign-in page</button><button type="button" disabled={busy} onClick={onCancel}>Cancel sign-in</button></div>
    </> : <>
      <h2>Your Jolo account</h2><p>Connect your account through GitHub. Jolo works locally without signing in.</p>
      <button type="button" className="primary" disabled={busy} onClick={onLogin}>{busy ? 'Starting sign-in…' : 'Sign in to Jolo'}</button>
      <details className="settings-advanced"><summary>Account server</summary><label>Server URL<input type="url" value={server} onChange={event => onServer(event.target.value)} spellCheck={false} autoComplete="off" disabled={busy} /></label><p className="hint">Change this when using a self-hosted account service.</p></details>
    </>}
    {account?.note && <p className="hint" role="status">{account.note}</p>}
    {error && <p className="settings-save-error" role="alert">{error}</p>}
  </section>;
}

export function AccountSettings() {
  const { engine } = useEngineConnection();
  const [account, setAccount] = useState(null), [error, setError] = useState(null), [busy, setBusy] = useState(false);
  const [server, setServer] = useState('https://access.jolo.build');
  const mounted = useRef(true), reading = useRef(null);
  const generation = useRef(0);
  const refresh = useCallback(async (force = false) => {
    if (reading.current) return reading.current;
    const current = generation.current;
    reading.current = engineCall('account.status', { refresh: force }).then(value => {
      if (mounted.current && current === generation.current) { setAccount(value); setError(null); }
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
    } catch (error) { if (mounted.current) setError(error.message); }
    finally { if (mounted.current) setBusy(false); }
  };
  return <AccountPanel account={account} connected={engine.connected} busy={busy} error={error} server={server} onServer={setServer} onLogin={() => act('account.login', { origin: server.trim().replace(/\/$/, '') })} onConnectTasks={() => act('account.login', { tasks: true })} onCancel={() => act('account.cancel')} onLogout={() => act('account.logout')} onRefresh={() => refresh(true)} onOpen={open} />;
}
