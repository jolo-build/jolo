import { useCallback, useEffect, useRef, useState } from 'react';
import { engineCall } from './engine-context.jsx';

/** Git is authoritative; file-tool events only supply the optional undo record. */
export function useWorkingChanges({ workspaceId, connected, watching, events, runState }) {
  const [snapshot, setSnapshot] = useState(null);
  const scope = useRef(workspaceId);
  scope.current = workspaceId;
  const pending = useRef(null);
  const refresh = useCallback(async () => {
    if (!workspaceId || !connected) return;
    if (pending.current?.workspaceId === workspaceId) return pending.current.promise;
    const request = { workspaceId };
    pending.current = request;
    request.promise = engineCall('workspace.changes', { workspaceId }).then(result => {
      if (scope.current === workspaceId) setSnapshot({ ...result, workspaceId, error: null });
    }).catch(error => {
      if (scope.current === workspaceId) setSnapshot(previous => ({ ...(previous?.workspaceId === workspaceId ? previous : {}), workspaceId,
        error: error.code === 'unknown_method' ? 'Restart Jolo to load working changes from the updated engine.' : error.message }));
    }).finally(() => { if (pending.current === request) pending.current = null; });
    return request.promise;
  }, [workspaceId, connected]);
  useEffect(() => { void refresh(); }, [refresh, events, runState]);
  useEffect(() => {
    if (!watching) return;
    void refresh();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 3000);
    window.addEventListener('focus', refresh);
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [watching, refresh]);
  const current = snapshot?.workspaceId === workspaceId ? snapshot : null;
  const records = new Map(events.map(file => [file.newPath ?? file.path, file]));
  const changes = current?.source === 'git'
    ? current.files.map(file => ({ ...records.get(file.newPath ?? file.path), ...file })) : events;
  return { changes, refresh, status: { source: current?.source, loading: Boolean(workspaceId && !current), error: current?.error, truncated: current?.truncated } };
}
