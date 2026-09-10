import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

const pendingReads = new Map();
const COALESCED = new Set(["engine.status", "session.list", "workspace.list", "plan.list", "plan.get", "agent.list", "agent.catalog", "settings.get", "board.list"]);
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

// All panes share connection status, provider settings, and one debounced board subscription.
export function EngineProvider({ children }) {
  const [engine, setEngine] = useState({ connected: false });
  const [initializing, setInitializing] = useState(true);
  const [settings, setSettings] = useState(null);
  const [board, setBoard] = useState(null);
  const [tasks, setTasks] = useState([]); // every open task, across every project (§5.1)
  // null until the engine has been asked; false when it cannot answer, so a caller can fall back to what it
  // already has rather than showing an empty list as though there were nothing to show.
  const [tasksAvailable, setTasksAvailable] = useState(null);
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

  const refreshTasks = useCallback(async () => {
    try {
      const next = await engineCall("board.tasks", {});
      setTasks(next.tasks);
      setTasksAvailable(true);
      return next.tasks;
    } catch (error) {
      // An engine older than this method cannot list across projects. Say so, so the list falls back to the
      // open project's own tasks instead of reading as "you have none".
      setTasksAvailable(false);
      if (error?.code !== "unknown_method") console.error("task list refresh failed", error);
      return null;
    }
  }, []);

  // In-app notices. The main process shows an OS notification when the window is not focused; these are for
  // when it is, so a task that finishes in another project is never missed just because it was not on screen.
  const [notices, setNotices] = useState([]);
  const onScreen = useRef(new Map()); // sessions a visible pane is showing: they need no telling
  const focusListeners = useRef(new Set());
  const dismissNotice = useCallback((key) => setNotices((list) => list.filter((notice) => notice.key !== key)), []);
  const showNotice = useCallback((notice) => setNotices((list) => [...list.filter((entry) => entry.key !== notice.key), notice].slice(-NOTIFY_LIMIT)), []);
  /** A pane says which task it is showing, so finishing in front of the user is not announced to them. */
  const watchSession = useCallback((sessionId) => {
    if (!sessionId) return () => {};
    onScreen.current.set(sessionId, (onScreen.current.get(sessionId) ?? 0) + 1);
    return () => { const count = onScreen.current.get(sessionId) - 1; if (count) onScreen.current.set(sessionId, count); else onScreen.current.delete(sessionId); };
  }, []);
  /** Opening a task from a notice takes the same path a clicked OS notification does. */
  const requestFocus = useCallback((payload) => { for (const listener of focusListeners.current) listener(payload); }, []);
  const onFocusRequest = useCallback((listener) => { focusListeners.current.add(listener); return () => focusListeners.current.delete(listener); }, []);

  useEffect(() => {
    let disposed = false, notified = false, timer = null;
    const receive = (next) => {
      if (disposed) return;
      setEngine(next);
      if (next.connected) {
        void Promise.allSettled([refreshSettings(), refreshBoard(), refreshTasks(), refreshCatalog()]).then(() => {
          if (!disposed) setInitializing(false);
        });
      } else if (next.error) setInitializing(false); // let the interface show connection failures
    };
    const offEngine = window.jolo.onEngine((next) => { notified = true; receive(next); });
    void engineCall("engine.status", {}).then((status) => { if (!notified) receive({ connected: true, status }); }).catch((error) => { if (!notified) receive({ connected: false, error: error.message }); });
    const offEvents = window.jolo.onEvents((items) => {
      if (!timer && items.some((item) => item.kind === "event" && BOARD_EVENTS.has(item.value.type))) timer = setTimeout(() => { timer = null; void refreshBoard(); void refreshTasks(); }, 400);
      // A request that has been answered is no longer news, wherever it was answered.
      for (const item of items) {
        if (item.kind !== "event" || item.value.type !== "permission.resolved") continue;
        const { permissionId } = item.value.payload;
        setNotices((list) => list.filter((notice) => notice.focus?.permissionId !== permissionId));
      }
    });
    // News from main, which alone knows whether the window is focused. A task the user is already watching
    // needs no notice: they can see it finish.
    const offNotice = window.jolo.onNotice((payload) => {
      if (disposed) return;
      if (payload.dismiss) {
        setNotices(list => list.filter(notice => notice.focus?.permissionId !== payload.permissionId));
        return;
      }
      if (payload.kind !== "approval" && payload.sessionId && onScreen.current.has(payload.sessionId)) return;
      showNotice({
        key: `${payload.sessionId ?? payload.projectId ?? payload.kind}:${payload.kind}:${payload.title}`,
        tone: payload.tone ?? "muted",
        title: payload.title,
        body: payload.body,
        at: payload.at ?? Date.now(),
        focus: { projectId: payload.projectId, rootPath: payload.rootPath, sessionId: payload.sessionId, permissionId: payload.permissionId ?? null },
      });
    });
    return () => { disposed = true; offEngine(); offEvents(); offNotice(); clearTimeout(timer); };
  }, [refreshSettings, refreshBoard, refreshTasks, refreshCatalog, showNotice]);
  return <Context.Provider value={{ engine, initializing, settings, board, tasks, tasksAvailable, refreshTasks, agentCatalog, refreshSettings, refreshBoard, refreshCatalog, setOverlay, notices, showNotice, dismissNotice, watchSession, requestFocus, onFocusRequest }}>{children}</Context.Provider>;
}
export const useEngineConnection = () => useContext(Context);
