import { useCallback, useEffect, useState } from 'react';

export function AboutSettings({ initialState = null }) {
  const [state, setState] = useState(initialState);
  const [busy, setBusy] = useState(false);
  const check = useCallback(async force => {
    setBusy(true);
    try { setState(await window.jolo.checkForUpdate?.({ force }) ?? { managed: false }); }
    catch (error) { setState(previous => ({ ...previous, error: String(error.message ?? error) })); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => {
    const unsubscribe = window.jolo.onUpdate?.(setState);
    void check(false);
    return unsubscribe;
  }, [check]);

  const update = async (install = false) => {
    setBusy(true);
    setState(previous => ({ ...previous, error: undefined, status: install ? 'installing' : 'downloading' }));
    try { setState(await (install ? window.jolo.installUpdate() : window.jolo.downloadUpdate())); }
    catch (error) { setState(previous => ({ ...previous, status: install ? 'ready' : 'idle', error: String(error.message ?? error) })); }
    finally { setBusy(false); }
  };
  const status = state?.status;
  const downloading = status === 'downloading', ready = status === 'ready', installing = status === 'installing';
  const locked = busy || downloading || installing;
  const progress = state?.total > 0 ? Math.min(100, Math.round(100 * state.received / state.total)) : null;
  const version = state?.current;
  return <section className="settings-card">
    <div className="settings-card-heading"><div><h2>Jolo{version ? ` ${version}` : ''}</h2><p className="hint" role="status">
      {state === null ? 'Checking this installation…'
        : state.managed === false ? 'This build runs from a source checkout, so there is nothing to update.'
        : installing ? 'Restarting Jolo to finish the update…'
        : ready ? `Jolo ${state.latest} is ready. Restart to finish the update.`
        : downloading ? progress === 100 ? 'Preparing the update…' : `Downloading Jolo ${state.latest}…${progress === null ? '' : ` ${progress}%`}`
        : state.available ? `Jolo ${state.latest} has been released.`
        : state.error ? 'The update could not finish. Try again.'
        : 'This is the newest published release.'}
    </p></div></div>
    {state?.error && <p className="hint" role="alert">{state.error}</p>}
    {downloading && <progress aria-label="Update download" max={state.total || 1} {...(state.total ? { value: state.received || 0 } : {})} />}
    {state && state.managed !== false && <div className="settings-card-actions">
      <button type="button" onClick={() => void check(true)} disabled={locked || ready}>{busy && !downloading && !installing ? 'Checking…' : 'Check for updates'}</button>
      {(state.available || ready || installing) && (state.installable
        ? <button type="button" className="primary" disabled={locked} onClick={() => void update(ready)}>{installing ? 'Restarting…' : ready ? 'Restart to update' : downloading ? 'Downloading…' : `Update to ${state.latest}`}</button>
        : state.releaseUrl && <button type="button" className="primary" onClick={() => window.jolo.openExternal(state.releaseUrl)}>Download {state.latest}</button>)}
    </div>}
  </section>;
}
