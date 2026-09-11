import { useEffect, useState } from 'react';
import { readWorkspaceTasks } from './workspace-tasks.js';

/**
 * @param {{
 *   call: (method: string, params?: any) => Promise<any>,
 *   workspaceId?: string,
 *   revision?: string,
 *   state?: string,
 *   standalone?: boolean,
 * }} options a folder's tasks are read by `workspaceId`; the chats that belong to no folder are read
 *   with `standalone` instead, so callers pass one or the other.
 */
export function useWorkspaceTasks({ call, workspaceId, revision, state = 'open', standalone }) {
  const [pages, setPages] = useState(1);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    readWorkspaceTasks(call, workspaceId, pages, state, standalone).then(next => {
      if (!cancelled) setResult(next);
    }).catch(error => {
      if (!cancelled) setError(['unknown_method', 'invalid_params'].includes(error.code)
        ? 'Restart Jolo with the updated engine to list tasks by workspace.' : 'Couldn’t load tasks. Try again.');
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [call, workspaceId, revision, state, standalone, pages, retry]);
  return { result, loading, error, retry: () => setRetry(value => value + 1), loadMore: () => setPages(value => value + 1) };
}
