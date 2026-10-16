import { useEffect, useRef, useState } from 'react';
import { adjacentRailChat, RailNavigation, ChatNavigation, CHAT_NAVIGATION_KEY, readChatNavigation } from './chat-navigation.js';
import { chatSwipe, canSwipeChat, railSwipeDirection } from './chat-swipe.js';

export function useChatSwipe({ root, paneId, enabled, entry, rows, sessionId, open, onError }) {
  // Only the primary pane is restored by desktop reload. Extra panes have a
  // lifetime of their own and must not inherit a previously closed split's visits.
  const key = paneId === 'pane-1' ? CHAT_NAVIGATION_KEY : null;
  const navigation = useRef(null);
  if (!navigation.current) {
    navigation.current = key ? readChatNavigation(window.sessionStorage) : new ChatNavigation();
  }
  const save = () => {
    try { if (key) window.sessionStorage.setItem(key, JSON.stringify(navigation.current.snapshot())); } catch { /* navigation still works in memory */ }
  };
  const [hint, setHint] = useState(null);
  const pending = useRef(new RailNavigation());
  const current = useRef(null);
  current.current = { enabled, rows, sessionId, open, onError };
  useEffect(() => { navigation.current.visit(entry); save(); }, [entry?.session?.id, entry?.rootPath, entry?.historyState]);
  useEffect(() => {
    if (window.jolo.platform !== 'darwin') return;
    const element = root.current;
    let hintTimer;
    // Follow physical left/up and right/down even with natural scrolling off.
    const receive = chatSwipe(wheelDirection => {
      const direction = railSwipeDirection(wheelDirection, window.jolo.naturalScrolling);
      return pending.current.move(current.current.rows, current.current.sessionId, direction,
        target => current.current.open(target), error => current.current.onError(error.message));
    }, (wheelDirection, progress) => {
      if (!wheelDirection) { clearTimeout(hintTimer); setHint(null); return; }
      const direction = railSwipeDirection(wheelDirection, window.jolo.naturalScrolling);
      const target = adjacentRailChat(current.current.rows, pending.current.target?.session.id ?? current.current.sessionId, direction);
      if (!target) return;
      setHint({ direction, progress, title: target.title || (target.standalone ? 'New chat' : 'New task') });
      clearTimeout(hintTimer);
      hintTimer = setTimeout(() => setHint(null), 400);
    });
    const wheel = event => {
      const target = event.target instanceof Element ? event.target : null;
      // Header/sidebar are portals outside the pane root. They still navigate
      // the active pane; browser, terminal and file panels retain their gestures.
      const surface = target?.closest('main[aria-label="Conversation"], .task-rail, .header, .sidebar, .workspace-sidebar');
      const ownSurface = surface && (element.contains(surface) || !surface.closest('.pane-slot'));
      const allowed = current.current.enabled && ownSurface && !event.defaultPrevented &&
        !document.querySelector('dialog[open], [popover]:popover-open, .settings-page, .mention-list') &&
        !element.querySelector('.composer[data-swipe-blocked="true"]') && canSwipeChat(target, surface);
      const claimed = receive(event, Boolean(allowed));
      if (claimed && event.cancelable) event.preventDefault();
    };
    const offGesture = window.jolo.onScrollGestureBegin?.(() => receive.begin());
    document.addEventListener('wheel', wheel, { passive: false });
    return () => { document.removeEventListener('wheel', wheel); offGesture?.(); clearTimeout(hintTimer); };
  }, [root]);
  return enabled ? hint : null;
}
