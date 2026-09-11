import { useEffect, useState } from 'react';
import { JoloLogo } from './brand.jsx';
import { Icon } from './icon.jsx';

export function BoardHeader({ connected, call, onSettings }) {
  const [account, setAccount] = useState(null);
  useEffect(() => {
    if (!connected) { setAccount(null); return; }
    let live = true, generation = 0;
    const refresh = async () => {
      const current = ++generation;
      try {
        const status = await call('account.status', { refresh: false });
        if (live && current === generation) setAccount(status.state === 'signed_in' ? status.account : null);
      } catch { if (live && current === generation) setAccount(null); }
    };
    void refresh();
    const off = window.jolo.onEvents(items => {
      if (items.some(item => item.kind === 'event' && item.value.type === 'account.changed')) void refresh();
    });
    return () => { live = false; off(); };
  }, [connected, call]);
  const name = connected ? account?.name?.trim() || account?.email : null;
  const initial = name ? Array.from(name)[0].toLocaleUpperCase() : null;
  return <header className="header board-header">
    <JoloLogo className="board-wordmark" />
    <span className="board-header-separator" aria-hidden="true">/</span>
    <span className="board-header-title">Workspaces</span>
    <button className="board-account" onClick={onSettings} aria-label="Settings" title={name ? `${name} · Account and settings` : 'Account and settings'}>
      {initial ? <span aria-hidden="true">{initial}</span> : <Icon name="user" size={15} />}
    </button>
  </header>;
}
