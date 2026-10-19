const KEY = 'jolo.openSubtasks';
const LIMIT = 200;

/** The parent tasks whose child tasks the user left open. Shared by every pane and kept across restarts; no storage, no memory. */
export function readOpenGroups(storage) {
  try {
    const saved = JSON.parse(storage.getItem(KEY));
    return new Set(Array.isArray(saved) ? saved.filter(id => typeof id === 'string') : []);
  } catch { return new Set(); }
}

/** Remember one parent's fold; the newest choices are kept when the list grows past its limit. */
export function rememberOpenGroup(storage, sessionId, open) {
  const groups = readOpenGroups(storage);
  groups.delete(sessionId);
  if (open) groups.add(sessionId);
  try { storage.setItem(KEY, JSON.stringify([...groups].slice(-LIMIT))); }
  catch { /* Storage can be full or blocked; the fold then lasts until the next reload. */ }
}
