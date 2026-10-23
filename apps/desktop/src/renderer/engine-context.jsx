import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

const pendingReads = new Map();
const COALESCED = new Set(["engine.status", "session.list", "workspace.list", "plan.list", "plan.get", "agent.list", "agent.catalog", "settings.get", "board.list", "board.tasks"]);
export function engineCall(method, params) {
  const key = COALESCED.has(method) ? `${method}:${JSON.stringify(params)}` : null;
  if (key && pendingReads.has(key)) return pendingReads.get(key);
  const result = window.jolo.call(method, params).then(response => {
    if (!response.ok) throw Object.assign(new Error(response.error.message), { code: response.error.code });
    return response.result;
  }).finally(() => { if (key) pendingReads.delete(key); });
  if (key) pendingReads.set(key, result);
  return result;
}
const Context = createContext(null);
/** How many notices stand at once: enough to catch up on, few enough to read (§5.6). */
const NOTIFY_LIMIT = 4;

const BOARD_EVENTS = new Set(["run.state", "permission.requested", "permission.resolved", "workspace.viewed", "workspace.created", "workspace.removed", "session.created", "session.updated", "session.deleted", "files.changed", "run.verification", "tool.started", "tool.completed"]);

/** The notice for news from main. Its focus says what opening it shows, and which request's answer retires it. */
export function noticeFrom(payload) {
  return {
    key: `${payload.sessionId ?? payload.projectId ?? payload.kind}:${payload.kind}:${payload.title}`,
    tone: payload.tone ?? "muted",
    title: payload.title,
    body: payload.body,
    at: payload.at ?? Date.now(),
    focus: { projectId: payload.projectId, rootPath: payload.rootPath, sessionId: payload.sessionId, permissionId: payload.permissionId ?? null, dialogId: payload.dialogId ?? null },
  };
}

/**
 * The notices still news once a request is answered: a permission named by its id, or a question Claude asked by its
 * dialog id. A notice about neither, such as the engine's, stays.
 * @param {any[]} notices @param {{ permissionId?: string | null, dialogId?: string | null }} answered
 */
export function withoutAnswered(notices, { permissionId = null, dialogId = null }) {
  const about = dialogId ? (notice) => notice.focus?.dialogId === dialogId : permissionId ? (notice) => notice.focus?.permissionId === permissionId : () => false;
  return notices.filter((notice) => !about(notice));
}

// All panes share connection status, provider settings, and one debounced board subscription.
export function EngineProvider({ children }) {
  const [engine, setEngine] = useState({ connected: false });
  const [initializing, setInitializing] = useState(true);
  const [settings, setSettings] = useState(null);
  const [board, setBoard] = useState(null);
  const [agentCatalog, setAgentCatalog] = useState([]);
  const overlays = useRef(new Set());
  const setOverlay = useCallback((id, active) => {
    if (active) overlays.current.add(id); else overlays.current.delete(id);
    window.jolo.setOverlay(overlays.current.size > 0);
  }, []);
  const refreshSettings = useCallback(async () => { try { setSettings((await engineCall("settings.get", {})).settings); } catch { /* engine not ready */ } }, []);
  // The catalog carries each agent's chosen model, so it is reloaded whenever that choice changes.
  const refreshCatalog = useCallback(async () => { try { setAgentCatalog((await engineCall("agent.catalog", {})).agents); } catch { /* engine not ready */ } }, []);
  const refreshBoard = useCallback(async () => {
    try { const next = await engineCall("board.list", {}); setBoard(next); return next; }
    catch (error) { console.error("board refresh failed", error); return null; }
  }, []);

  // In-app notices. The main process shows an OS notification when the window is not focused; these are for
  // when it is, so a task that finishes in another project is never missed just because it was not on screen.
  const [notices, setNotices] = useState([]);
  const onScreen = useRef(new Map()); // sessions a visible pane is showing: they need no telling
  const approvalOnScreen = useRef(new Map()); // of those, the ones whose approval request is on screen too
  const focusListeners = useRef(new Set());
  const dismissNotice = useCallback((key) => setNotices((list) => list.filter((notice) => notice.key !== key)), []);
  const showNotice = useCallback((notice) => setNotices((list) => [...list.filter((entry) => entry.key !== notice.key), notice].slice(-NOTIFY_LIMIT)), []);
  /** A pane says which task it is showing, and whether it shows that task's approvals, so neither is announced twice. */
  const watchSession = useCallback((sessionId, { approvals = false } = {}) => {
    if (!sessionId) return () => {};
    const maps = approvals ? [onScreen.current, approvalOnScreen.current] : [onScreen.current];
    for (const map of maps) map.set(sessionId, (map.get(sessionId) ?? 0) + 1);
    return () => { for (const map of maps) { const count = map.get(sessionId) - 1; if (count) map.set(sessionId, count); else map.delete(sessionId); } };
  }, []);
  /** Opening a task from a notice takes the same path a clicked OS notification does. */
  const requestFocus = useCallback((payload) => { for (const listener of focusListeners.current) listener(payload); }, []);
  const onFocusRequest = useCallback((listener) => { focusListeners.current.add(listener); return () => focusListeners.current.delete(listener); }, []);

  useEffect(() => {
    let disposed = false, notified = false, timer = null, offline = null;
    const receive = (next) => {
      if (disposed) return;
      setEngine(next);
      clearTimeout(offline);
      if (next.connected) {
        dismissNotice("engine");
        void Promise.allSettled([refreshSettings(), refreshBoard(), refreshCatalog()]).then(() => {
          if (!disposed) setInitializing(false);
        });
        return;
      }
      if (next.error) setInitializing(false); // let the interface show connection failures
      // A blip under a second says nothing; a longer outage stays on screen until the engine is back.
      offline = setTimeout(() => showNotice({ key: "engine", tone: "needs", title: next.error ? "Local engine stopped" : "Reconnecting to the local engine…", body: next.error ?? "" }), 1000);
    };
    const offEngine = window.jolo.onEngine((next) => { notified = true; receive(next); });
    void engineCall("engine.status", {}).then((status) => { if (!notified) receive({ connected: true, status }); }).catch((error) => { if (!notified) receive({ connected: false, error: error.message }); });
    const offEvents = window.jolo.onEvents((items) => {
      if (!timer && items.some((item) => item.kind === "event" && BOARD_EVENTS.has(item.value.type))) timer = setTimeout(() => { timer = null; void refreshBoard(); }, 400);
      // A request that has been answered is no longer news, wherever it was answered.
      for (const item of items) {
        if (item.kind !== "event") continue;
        if (item.value.type === "permission.resolved") setNotices((list) => withoutAnswered(list, { permissionId: item.value.payload.permissionId }));
        else if (item.value.type === "dialog.resolved") setNotices((list) => withoutAnswered(list, { dialogId: item.value.payload.dialogId }));
      }
    });
    // News from main, which alone knows whether the window is focused. A task the user is already watching
    // needs no notice: they can see it finish.
    const offNotice = window.jolo.onNotice((payload) => {
      if (disposed) return;
      if (payload.dismiss) {
        setNotices(list => withoutAnswered(list, payload));
        return;
      }
      if (payload.sessionId && (payload.kind === "approval" ? approvalOnScreen : onScreen).current.has(payload.sessionId)) return;
      showNotice(noticeFrom(payload));
    });
    return () => { disposed = true; offEngine(); offEvents(); offNotice(); clearTimeout(timer); clearTimeout(offline); };
  }, [refreshSettings, refreshBoard, refreshCatalog, showNotice, dismissNotice]);
  // One object per change, not per render: every pane reads this context, so a fresh object each time
  // would re-render all of them whenever a notice comes or goes.
  const value = useMemo(() => ({ engine, initializing, settings, board, agentCatalog, refreshSettings, refreshBoard, refreshCatalog, setOverlay, notices, showNotice, dismissNotice, watchSession, requestFocus, onFocusRequest }),
    [engine, initializing, settings, board, agentCatalog, refreshSettings, refreshBoard, refreshCatalog, setOverlay, notices, showNotice, dismissNotice, watchSession, requestFocus, onFocusRequest]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export const useEngineConnection = () => useContext(Context);
