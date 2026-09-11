import { subscribePaneEvents } from "./engine-events.js";
import { requestId as createRequestId, TERMINAL } from "@jolo/client/run-state";
import { sessionForSend, queuedExecution } from "./session-send.js";
import { SessionHistory } from './session-history.js';
import { uploadImages } from './image-attachments.js';
// Renderer state: everything crosses the narrow bridge; the shared projection keeps text bounded (§4.1, §5.1).
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { SessionProjection } from "@jolo/client/projection";
import { engineCall as call, useEngineConnection } from "./engine-context.jsx";
import { PendingPermissions } from "./pending-permissions.js";
import { useWorkingChanges } from './use-working-changes.js';

const WORKSPACE_EVENTS = new Set(["workspace.created", "workspace.removed"]);
export function useEngine({ restoreLastProject = false, initialProject = null, initialTask = null, initialNewChat = false, visible = true, watchChanges = false } = {}) {
  const { engine, settings, board, agentCatalog, refreshSettings, refreshBoard, refreshCatalog } = useEngineConnection();
  const [agents, setAgents] = useState([]);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const [project, setProject] = useState(null);
  const [restoringProject, setRestoringProject] = useState(true);
  const [sessions, setSessionsState] = useState([]);
  const [workspaces, setWorkspaces] = useState([]);
  const [historyState, setHistoryState] = useState("open");
  const [sessionId, setSessionId] = useState(null);
  const [error, setError] = useState(null);
  const [relayNote, setRelayNote] = useState(null);
  const permissions = useRef(new PendingPermissions());
  const [changes, setChanges] = useState([]);
  const [plans, setPlans] = useState([]);
  const [, bump] = useReducer((x) => x + 1, 0);
  const paintTimer = useRef(null);
  const redraw = useCallback(() => {
    if (paintTimer.current) return;
    paintTimer.current = setTimeout(() => { paintTimer.current = null; bump(); }, 50);
  }, []);
  useEffect(() => () => clearTimeout(paintTimer.current), []);
  const projection = useRef(null);
  const history = useRef(null);
  const sessionRef = useRef(null);
  const draftSession = useRef({ id: null });
  const projectRef = useRef(null);
  const workspaceRef = useRef(null);
  const historyRef = useRef("open");
  const listRequest = useRef(0);
  const projectRequest = useRef(0);
  const sessionsRef = useRef([]);
  const setSessions = (list) => { sessionsRef.current = list; setSessionsState(list); };
  /** Keep the selected folder when a history switch temporarily clears its chat. */
  const currentWorkspaceId = () => sessionsRef.current.find((item) => item.id === sessionRef.current)?.workspaceId ?? workspaceRef.current ?? projectRef.current?.workspaceId ?? null;

  const refreshSessions = useCallback(async (projectId) => {
    const id = projectId ?? projectRef.current?.projectId;
    if (!id) return [];
    const request = ++listRequest.current;
    const { sessions: list } = await call("session.list", { projectId: id, state: historyRef.current });
    if (request === listRequest.current && id === projectRef.current?.projectId) {
      // A chat opened from a workspace's older pages may be outside this short
      // sidebar page. Keep its identity and folder while it is selected.
      const selected = sessionsRef.current.find(session => session.id === sessionRef.current);
      setSessions(selected && !list.some(session => session.id === selected.id) ? [...list, selected] : list);
    }
    return list;
  }, []);

  const refreshWorkspaces = useCallback(async (projectId) => {
    const id = projectId ?? projectRef.current?.projectId;
    if (!id) { setWorkspaces([]); return []; }
    try {
      const { workspaces: list } = await call("workspace.list", { projectId: id });
      if (id === projectRef.current?.projectId) setWorkspaces(list);
      return list;
    } catch { return []; }
  }, []);

  /** Hosted third-party agents in this pane's workspace (§4.3): Jolo watches them, it does not drive them. */
  const refreshAgents = useCallback(async (workspaceId) => {
    const id = workspaceId ?? currentWorkspaceId();
    if (!id) { setAgents([]); return []; }
    try { const { agents: list } = await call("agent.list", { workspaceId: id }); setAgents(list); return list; } catch { return []; }
  }, []);
  const startAgent = useCallback(async (agentId, prompt) => {
    const started = await call("agent.start", { workspaceId: currentWorkspaceId(), agentId, ...(prompt ? { prompt } : {}) });
    await refreshAgents();
    return started.agent;
  }, [refreshAgents]);
  const stopAgent = useCallback(async (terminalId) => { await call("agent.stop", { terminalId }); await refreshAgents(); }, [refreshAgents]);

  /** Plans of the open project, newest first. Read whole: a plan is small and the list is short (§6.6). */
  const refreshPlans = useCallback(async () => {
    const projectId = projectRef.current?.projectId;
    if (!projectId) { setPlans([]); return []; }
    try {
      let full;
      try { full = (await call("plan.list", { projectId, includeTasks: true })).plans; }
      catch (error) {
        if (error.code !== "limit_exceeded") throw error;
        // Exceptionally large collections use bounded individual detail responses.
        const { plans: rows } = await call("plan.list", { projectId });
        full = [];
        for (const plan of rows) full.push({ ...plan, ...(await call("plan.get", { planId: plan.id })) });
      }
      setPlans(full);
      return full;
    } catch { return []; }
  }, []);

  const markViewed = useCallback(async (workspaceId) => { if (!workspaceId) return; try { await call("board.viewed", { workspaceId }); } catch { /* the workspace may be gone */ } }, []);

  const selectSession = useCallback(async (id) => {
    draftSession.current = { id: null };
    sessionRef.current = id;
    setSessionId(id);
    const requests = new PendingPermissions();
    permissions.current = requests;
    setChanges([]);
    history.current = null;
    if (!id) { projection.current = null; bump(); return; }
    const next = new SessionProjection({
      readArtifact: (artifactId, offset, length) => call("artifact.read", { artifactId, offset, length }),
      maxTextBytes: 512 * 1024,
      onChange: redraw,
    });
    projection.current = next;
    const older = new SessionHistory({ sessionId: id, projection: next, call, onChange: redraw,
      isCurrent: () => sessionRef.current === id && projection.current === next });
    history.current = older;
    const page = await call("session.page", { sessionId: id });
    if (sessionRef.current !== id || projection.current !== next) return;
    workspaceRef.current = page.session.workspaceId;
    setSessions(sessionsRef.current.some(session => session.id === id)
      ? sessionsRef.current.map(session => session.id === id ? page.session : session)
      : [...sessionsRef.current, page.session]);
    requests.seed(page.pendingPermissions ?? [], page.cursor);
    // An engine already running during a desktop update may predate snapshot permissions.
    if (page.pendingPermissions === undefined) {
      void call("board.list", {}).then(({ projects }) => {
        if (permissions.current !== requests) return;
        const row = projects.find(row => row.session?.id === id && row.pendingPermission);
        if (row && !requests.first && BigInt(page.cursor) === requests.cursor) {
          requests.add({ ...row.pendingPermission, runId: row.run.id, workspaceId: row.workspaceId, isolation: "none", revision: 0 });
          redraw();
        }
      }).catch(() => {});
    }
    next.seed(page);
    older.seed(page);
    for (const message of page.messages) if (message.committedBytes > 0) void next.fill(message.id);
  }, [redraw]);

  const openProject = useCallback(async (path, options = {}) => {
    const request = ++projectRequest.current;
    setError(null);
    const opened = await call("project.open", { path });
    if (request !== projectRequest.current) return opened;
    workspaceRef.current = opened.workspaceId;
    await selectSession(null);
    projectRef.current = opened;
    historyRef.current = "open";
    setHistoryState("open");
    setProject(opened);
    try { localStorage.setItem("jolo.lastProject", path); } catch { /* optional */ }
    const [list] = await Promise.all([refreshSessions(opened.projectId), refreshWorkspaces(opened.projectId)]);
    if (request !== projectRequest.current) return opened;
    await selectSession(Object.hasOwn(options, "sessionId") ? options.sessionId : list[0]?.id ?? null);
    return opened;
  }, [refreshSessions, refreshWorkspaces, selectSession]);

  const newChat = useCallback(async () => {
    const { session, rootPath } = await call('chat.create', {});
    await openProject(rootPath, { sessionId: session.id });
    await refreshBoard();
    return session;
  }, [openProject, refreshBoard]);

  /** New task in the selected folder, or a fresh worktree when requested (§9.1). */
  const newSession = useCallback(async (title = "", options = {}) => {
    const current = projectRef.current;
    if (!current) throw new Error("open a project first");
    let workspaceId = options.workspaceId ?? currentWorkspaceId();
    if (options.worktree) {
      const { workspace } = await call("workspace.create", { projectId: current.projectId, ...(options.worktree.branch ? { branch: options.worktree.branch } : {}), ...(options.worktree.base ? { base: options.worktree.base } : {}), title });
      workspaceId = workspace.id;
    } else if (!options.workspaceId && workspaceId !== current.workspaceId) {
      // A removed worktree's conversation remains readable. Its New task
      // action must use a live folder instead of trying to recreate that checkout.
      const { workspaces } = await call('workspace.list', { projectId: current.projectId });
      if (!workspaces.some(workspace => workspace.id === workspaceId)) workspaceId = current.workspaceId;
    }
    const { session } = await call("session.create", { projectId: current.projectId, workspaceId, title, ...(options.agentId ? { agentId: options.agentId } : {}) });
    historyRef.current = "open";
    setHistoryState("open");
    const preferredMode = workspaceId === current.workspaceId ? "direct" : "worktree";
    if (current.preferredMode !== preferredMode) { projectRef.current = { ...current, preferredMode }; setProject(projectRef.current); }
    await Promise.all([refreshSessions(current.projectId), refreshWorkspaces(current.projectId)]);
    if (!options.deferSelection) await selectSession(session.id);
    return session;
  }, [refreshSessions, refreshWorkspaces, selectSession]);

  const removeWorktree = useCallback(async (workspaceId, force = false) => {
    const result = await call("workspace.remove", { workspaceId, force });
    await Promise.all([refreshWorkspaces(), refreshSessions()]);
    return result;
  }, [refreshSessions, refreshWorkspaces]);

  const setHistory = useCallback(async (state) => {
    historyRef.current = state;
    setHistoryState(state);
    setSessions([]);
    await selectSession(null);
    await refreshSessions();
  }, [refreshSessions, selectSession]);

  const manageSession = useCallback(async (session, action, title) => {
    const params = { sessionId: session.id, expectedRevision: session.revision };
    if (action === "rename") params.title = title;
    if (action === "archive") params.archived = session.state !== "archived";
    try {
      await call(`session.${action}`, params);
      if (action !== "rename" && sessionRef.current === session.id) await selectSession(null);
    } finally {
      await refreshSessions();
    }
  }, [refreshSessions, selectSession]);

  /** A model/agent choice changes the answerer, never the conversation identity. */
  const send = useCallback(async (prompt, /** @type {{ agentId?: string | null, queue?: boolean, attachments?: any[] }} */ { agentId, queue = false, attachments = [] } = {}) => {
    setError(null);
    const previousSessionId = sessionRef.current;
    const previousProjectId = projectRef.current?.projectId;
    const draft = draftSession.current;
    // Keep a new task's composer mounted until upload and send succeed, so a
    // failed first send retains both its text and pasted images for retry.
    const session = queue && sessionRef.current ? { id: sessionRef.current } : await sessionForSend({ call, sessionId: sessionRef.current ?? draft.id, agentId, prompt, newSession: async (title, options) => {
      const created = await newSession(title, { ...options, deferSelection: true });
      draft.id = created.id; // Retry the same draft in the same task after an interrupted upload.
      return created;
    } });
    if (session.revision !== undefined) {
      sessionsRef.current = sessionsRef.current.map(item => item.id === session.id ? session : item);
      setSessions(sessionsRef.current);
    }
    const requestId = createRequestId();
    const execution = queue ? queuedExecution(agentId, sessionsRef.current.find(item => item.id === session.id)?.agentId, prompt) : undefined;
    const images = await uploadImages(call, session.id, attachments);
    const { run } = await call("run.start", { sessionId: session.id, requestId, prompt, ...(images.length ? { attachments: images } : {}), ...(execution ? { execution } : {}) });
    if (!previousSessionId && !sessionRef.current && draftSession.current === draft && projectRef.current?.projectId === previousProjectId) await selectSession(session.id);
    if (sessionRef.current === session.id && projection.current) {
      const current = projection.current.runs.get(run.id);
      projection.current.runs.set(run.id, { ...run, ...current, prompt });
      redraw();
    }
    return run;
  }, [newSession, selectSession, redraw]);

  const sendNow = useCallback(async runId => call("run.sendNow", { runId }), []);
  const removeQueued = useCallback(async runId => {
    const queued = projection.current?.runs.get(runId);
    if (queued?.state === 'queued') return call("run.cancel", { runId, expectedRevision: queued.revision });
  }, []);

  const activeRun = () => {
    const runs = projection.current ? [...projection.current.runs.values()] : [];
    return runs.find(run => run.state && !TERMINAL.has(run.state) && !["paused", "queued"].includes(run.state)) ?? runs.find(run => run.state === "queued") ?? null;
  };

  /**
   * What this task has cost. Tokens add up across its runs; how full the context is does not, so that comes
   * from the most recent run that reported it. Nothing is filled in that the model did not report.
   */
  const usageSummary = () => {
    const runs = (projection.current ? [...projection.current.runs.values()] : []).filter((run) => run.usage);
    const totals = runs.reduce((sum, run) => ({
      inputTokens: sum.inputTokens + (run.usage.inputTokens ?? 0),
      outputTokens: sum.outputTokens + (run.usage.outputTokens ?? 0),
      iterations: sum.iterations + (run.usage.iterations ?? 0),
    }), { inputTokens: 0, outputTokens: 0, iterations: 0 });
    const latest = runs.filter((run) => run.usage.contextWindow > 0).at(-1) ?? null;
    return { ...totals, runs: runs.length, contextUsed: latest?.usage.contextUsed ?? null, contextWindow: latest?.usage.contextWindow ?? null };
  };

  const cancel = useCallback(async () => {
    const run = activeRun();
    if (run) await call("run.cancel", { runId: run.id });
  }, []);

  const resolvePermission = useCallback(async (permissionId, decision) => {
    const requests = permissions.current;
    await call("permission.resolve", { permissionId, decision });
    requests.remove(permissionId);
    redraw();
  }, [redraw]);

  const resumeRun = useCallback(async (runId) => call("run.resume", { runId }), []);

  /** Jump from a board row into its project and task; the row's pending request opens as the dialog. */
  const openFromBoard = useCallback(async (row) => {
    const current = projectRef.current;
    if (!current || current.projectId !== row.projectId) await openProject(row.rootPath, { sessionId: row.session?.id ?? null });
    if (historyRef.current !== (row.historyState ?? 'open')) await setHistory(row.historyState ?? 'open');
    if (row.session && sessionRef.current !== row.session.id) await selectSession(row.session.id);
    void markViewed(row.workspace?.id ?? row.workspaceId);
  }, [openProject, selectSession, markViewed, setHistory]);
  const newFromBoard = useCallback(async (row) => {
    if (projectRef.current?.projectId !== row.projectId) await openProject(row.rootPath, { sessionId: null });
    return newSession('', { workspaceId: row.workspaceId });
  }, [openProject, newSession]);
  const decideFromBoard = useCallback(async (row, decision) => {
    if (!row.pendingPermission) return;
    await call("permission.resolve", { permissionId: row.pendingPermission.permissionId, decision });
    if (sessionRef.current === row.session?.id) { permissions.current.remove(row.pendingPermission.permissionId); redraw(); }
  }, [redraw]);
  const stopFromBoard = useCallback(async (row) => { if (row.run) await call("run.cancel", { runId: row.run.id }); }, []);
  const resumeFromBoard = useCallback(async (row) => { if (row.run) await call("run.resume", { runId: row.run.id }); }, []);
  const loadDiff = useCallback(async (path) => call("workspace.diff", { workspaceId: currentWorkspaceId(), ...(path ? { path } : {}) }), []);
  const revertChange = useCallback(async (invocationId, path) => call("patch.revert", { invocationId, path }), []);
  const loadFile = useCallback(async (path) => call("workspace.readFile", { workspaceId: currentWorkspaceId(), path }), []);

  const initialized = useRef(false);
  useEffect(() => {
    if (!engine.connected || initialized.current) return;
    initialized.current = true;
    let path = initialProject;
    if (!path && restoreLastProject && !window.jolo.smoke) {
      try { path = localStorage.getItem("jolo.lastProject"); } catch { /* optional */ }
    }
    if (initialNewChat || initialTask || path) void (initialNewChat ? newChat() : initialTask ? openFromBoard(initialTask) : openProject(path, initialProject ? { sessionId: null } : {})).catch((error) => setError(error.message)).finally(() => setRestoringProject(false));
    else setRestoringProject(false);
  }, [engine.connected, initialProject, initialTask, initialNewChat, restoreLastProject, openProject, openFromBoard, newChat]);

  const wasConnected = useRef(engine.connected);
  useEffect(() => {
    const reconnected = engine.connected && !wasConnected.current;
    wasConnected.current = engine.connected;
    // A socket cursor acknowledges delivery to main, not necessarily the mounted
    // renderer. Reconcile the selected chat after reconnect without navigation.
    if (reconnected && sessionRef.current) void selectSession(sessionRef.current).catch(error => setError(error.message));
  }, [engine.connected, selectSession]);

  useEffect(() => {
    const offEvents = subscribePaneEvents(() => sessionRef.current, (items, meta) => {
      if (meta?.resyncRequired) return; // reload from a snapshot before applying any batch with a gap
      const current = projection.current;
      let sessionsChanged = false;
      let workspacesChanged = false;
      let agentsChanged = false;
      let plansChanged = false;
      for (const item of items) {
        if (item.kind === "event") {
          // A finished task the user is looking at counts as seen; the board stops calling it new.
          if (item.value.type === "run.state" && TERMINAL.has(item.value.payload.state) && item.value.sessionId === sessionRef.current && projectRef.current && document.hasFocus() && visibleRef.current) void markViewed(currentWorkspaceId());
          if (item.value.type.startsWith("agent.") && item.value.payload.workspaceId === currentWorkspaceId()) agentsChanged = true;
          if (item.value.type.startsWith("plan.")) plansChanged = true;
          if (WORKSPACE_EVENTS.has(item.value.type) && item.value.payload.projectId === projectRef.current?.projectId || (item.value.type === "workspace.created" && item.value.payload.workspace?.projectId === projectRef.current?.projectId)) workspacesChanged = true;
          if (item.value.sessionId === sessionRef.current && current) current.applyEvent(item.value);
          if (item.value.sessionId === sessionRef.current) {
            if (item.value.type === 'session.updated') {
              const session = item.value.payload.session;
              setSessions(sessionsRef.current.map(existing => existing.id === session.id ? session : existing));
            }
            if (item.value.type === "context.compacted") setRelayNote(`context compacted: ${item.value.payload.summarizedItems} earlier items summarized`);
            permissions.current.apply(item.value);
            if (item.value.type === "files.changed") setChanges((list) => [...list, ...item.value.payload.changes.map((c) => ({ ...c, invocationId: item.value.payload.invocationId, tool: item.value.payload.tool, at: item.value.at }))].slice(-200));
          }
          if (item.value.type.startsWith("session.") || (item.value.type === "run.state" && TERMINAL.has(item.value.payload.state))) sessionsChanged = true;
          if (item.value.sessionId === sessionRef.current && (item.value.type === "session.deleted" || (item.value.type === "session.updated" && item.value.payload.session.state !== historyRef.current))) void selectSession(null);
        } else if (item.kind === "preview" && item.value.sessionId === sessionRef.current && current) {
          current.applyPreview(item.value);
        }
      }
      if (sessionsChanged) void refreshSessions();
      if (workspacesChanged) void refreshWorkspaces();
      if (agentsChanged) void refreshAgents();
      if (plansChanged) void refreshPlans();
    });
    return offEvents;
  }, [refreshSessions, refreshWorkspaces, selectSession, markViewed, refreshPlans]);

  useEffect(() => {
    const off = window.jolo.onEvents((items, meta) => { if (meta?.resyncRequired) setRelayNote("renderer fell behind; reloading the session"), void selectSession(sessionRef.current); });
    return off;
  }, [selectSession]);

  const workspaceId = currentWorkspaceId();
  const working = useWorkingChanges({ workspaceId, connected: engine.connected, watching: visible && watchChanges, events: changes,
    runState: projection.current ? [...projection.current.runs.values()].filter(run => TERMINAL.has(run.state)).map(run => `${run.id}:${run.state}`).join(',') : '' });
  return {
    engine, project, restoringProject, sessions, sessionId, settings, error, relayNote, setError, historyState, setHistory, manageSession,
    workspaces, workspaceId, workspace: workspaces.find((item) => item.id === workspaceId) ?? null, removeWorktree,
    agents, agentCatalog, refreshAgents, refreshCatalog, startAgent, stopAgent,
    projection: projection.current,
    history: history.current,
    activeRun: activeRun(),
    queuedRuns: projection.current ? [...projection.current.runs.values()].filter(run => run.state === 'queued') : [],
    usage: usageSummary(),
    pendingPermission: permissions.current.first, changes: working.changes, changesStatus: working.status, refreshChanges: working.refresh,
    board, refreshBoard, markViewed, openFromBoard, newFromBoard, decideFromBoard, stopFromBoard, resumeFromBoard,
    plans, refreshPlans,
    openProject, selectSession, newSession, newChat, send, sendNow, removeQueued, cancel, refreshSettings, resolvePermission, resumeRun, loadDiff, loadFile, revertChange,
    call,
  };
}
