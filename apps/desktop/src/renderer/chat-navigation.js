// Navigation is per pane and spans both workspace tasks and standalone chats.
export class ChatNavigation {
  entries = [];
  index = -1;
  pending = false;
  constructor(saved = null) {
    if (Array.isArray(saved?.entries) && saved.entries.length <= 100 && saved.entries.every(entry =>
      typeof entry?.session?.id === 'string' && typeof entry.rootPath === 'string') &&
      Number.isInteger(saved.index) && saved.index >= 0 && saved.index < saved.entries.length) {
      this.entries = saved.entries;
      this.index = saved.index;
    }
  }
  snapshot() { return { entries: this.entries, index: this.index }; }
  canMove(direction) { return !this.pending && [-1, 1].includes(direction) && this.index + direction >= 0 && this.index + direction < this.entries.length; }
  visit(entry) {
    if (!entry?.session?.id || this.pending) return;
    if (this.entries[this.index]?.session.id === entry.session.id) { this.entries[this.index] = entry; return; }
    this.entries = [...this.entries.slice(0, this.index + 1), entry].slice(-100);
    this.index = this.entries.length - 1;
  }
  async move(direction, open) {
    const index = this.index + direction;
    if (!this.canMove(direction)) return false;
    this.pending = true;
    try { await open(this.entries[index]); this.index = index; return true; }
    finally { this.pending = false; }
  }
}

export const CHAT_NAVIGATION_KEY = 'jolo.chatNavigation.v1';
export function readChatNavigation(storage) {
  try { return new ChatNavigation(JSON.parse(storage.getItem(CHAT_NAVIGATION_KEY))); }
  catch { return new ChatNavigation(); }
}

// The swipe order is the visible task rail, including chats never visited here.
export function adjacentRailChat(rows, sessionId, direction) {
  if (direction !== -1 && direction !== 1) return null;
  const index = rows.findIndex(row => row.sessionId === sessionId);
  if (index < 0) return null;
  const task = rows[index + direction];
  return task ? { ...task, session: { id: task.sessionId }, historyState: 'open' } : null;
}

// Do not lose a second swipe while the first target is still opening. Collapse
// a burst to its furthest requested chat instead of replaying every old target.
export class RailNavigation {
  target = null;
  running = false;
  settled = Promise.resolve();
  move(rows, sessionId, direction, open, onError) {
    const target = adjacentRailChat(rows, this.target?.session.id ?? sessionId, direction);
    if (!target) return false;
    this.target = target;
    if (!this.running) {
      this.running = true;
      this.settled = this.drain(open, onError);
    }
    return true;
  }
  async drain(open, onError) {
    try {
      while (this.target) {
        const target = this.target;
        await open(target);
        if (this.target === target) this.target = null;
      }
    } catch (error) { this.target = null; onError(error); }
    finally { this.running = false; }
  }
}
