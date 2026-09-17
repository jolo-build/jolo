import { modelLabel } from '../model-options.js';
import { readLastModelChoice, rememberModelChoice, newSessionModelChoice } from '../last-model-choice.js';
import { lazy, memo, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useEngine } from "../use-engine.js";
import { TaskRail } from "./task-rail.jsx";
import { Sidebar } from "./sidebar.jsx";
import { Conversation } from "./conversation.jsx";
import { ModelControls } from "./model-controls.jsx";
import { Composer } from "./composer.jsx";
import { BrowserPane } from "./browser-pane.jsx";
import { ContextSplit } from './context-split.jsx';
import { FilePreview } from './file-preview.jsx';
import { FilePreviewContext } from '../file-preview-context.js';
import { PanelItemTabs } from './panel-item-tabs.jsx';
import { usePanelTabs } from '../use-panel-tabs.js';
import { PermissionDialog } from "./permission-dialog.jsx";
import { PermissionNotice } from "./permission-notice.jsx";
import { ChangesPanel } from "./changes-panel.jsx";
import { Icon } from "./icon.jsx";
import { ChecksPanel } from "./checks-panel.jsx";
import { PlanPane } from "./plan-pane.jsx";
import { SchedulesPanel } from "./schedules-panel.jsx";
import { JoloLogo } from "./brand.jsx";
import { TaskDialog } from "./task-dialog.jsx";
import { TaskHeader } from "./task-header.jsx";
import { Board } from "./board.jsx";
import { BoardHeader } from "./board-header.jsx";
import { WorktreeDialog } from "./worktree-dialog.jsx";
import { Onboarding } from './onboarding.jsx';
import { initialOnboardingState, readOnboardingState, saveOnboardingState, onboardingAgentAvailable } from '../onboarding.js';
import { basename, runLabel, pauseDescription, uniqueChanges, verificationLabel } from "../presentation.js";

import { createPortal } from "react-dom";
import { useEngineConnection } from "../engine-context.jsx";
import { PanePicker } from "./pane-picker.jsx";
import { finishStartup } from "../startup.js";
import { CONTEXT_PANELS, PanelMenu } from './panel-menu.jsx';

// Settings carries the provider schema runtime and the terminal carries xterm. Neither belongs in the
// script the window parses before it can show a conversation, so each loads the first time it is opened.
const SettingsPage = lazy(() => import("./settings.jsx").then(module => ({ default: module.SettingsPage })));
const TerminalPane = lazy(() => import("./terminal-pane.jsx").then(module => ({ default: module.TerminalPane })));

/**
 * One split of the window: its own engine state, its own task, and the slots it portals its chrome into.
 * The shell owns the layout, so every geometry answer and every layout command arrives as a prop.
 *
 * @typedef {{
 *   pane: { id: string, path?: string | null, task?: any, newChat?: boolean },
 *   active: boolean,
 *   visible: boolean,
 *   multi: boolean,
 *   zoomed: boolean,
 *   canSplit: boolean,
 *   hosts: {
 *     header: HTMLElement | null,
 *     sidebar: HTMLElement | null,
 *     footer: HTMLElement | null,
 *     settings: HTMLElement | null,
 *     sidebarCollapsed: boolean,
 *     toggleSidebar: () => void,
 *   },
 *   settingsOpen: boolean,
 *   onSettingsChange: (paneId: string | null) => void,
 *   onViewChange: (paneId: string, view: string) => void,
 *   onFocus: (paneId: string) => void,
 *   onSplit: (source: string, axis: string, options?: { task?: any, before?: boolean }) => void,
 *   onClose: (paneId: string) => void,
 *   onZoom: (paneId: string) => void,
 *   register: (paneId: string, controller: any) => void,
 *   onBrowserOpen: (paneId: string) => void,
 * }} WorkspacePaneProps
 */
export const WorkspacePane = memo(function WorkspacePane(/** @type {WorkspacePaneProps} */ { pane, active, visible, multi, zoomed, canSplit, hosts, settingsOpen, onSettingsChange, onViewChange, onFocus, onSplit, onClose, onZoom, register, onBrowserOpen }) {
  const root = useRef(null);
  const [view, setView] = useState(pane.id === "pane-1" ? "board" : "task");
  useLayoutEffect(() => { onViewChange(pane.id, view); }, [onViewChange, pane.id, view]);
  const [watchChanges, setWatchChanges] = useState(false);
  const previewSession = useRef(null);
  const previewWorkspace = useRef(null);
  const state = useEngine({ restoreLastProject: pane.id === "pane-1", initialProject: pane.path, initialTask: pane.task, initialNewChat: pane.newChat, visible: visible && view === "task", watchChanges });
  const connection = useEngineConnection();
  const [onboarding, setOnboarding] = useState(readOnboardingState);
  const [firstTaskDraft, setFirstTaskDraft] = useState(null);
  const updateOnboarding = value => { saveOnboardingState(value); setOnboarding(value); };
  useEffect(() => {
    if (pane.id !== 'pane-1' || onboarding !== null || connection.initializing || state.restoringProject) return;
    const next = initialOnboardingState(null, state.board);
    if (next) updateOnboarding(next);
  }, [pane.id, onboarding, connection.initializing, state.restoringProject, state.board]);
  const { setOverlay } = connection;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [panelMenuOpen, setPanelMenuOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const showSettings = settingsOpen;
  const [settingsSection, setSettingsSection] = useState('agents');
  const [taskDialog, setTaskDialog] = useState(null);
  const setShowSettings = (open) => {
    if (open) setSettingsSection(typeof open === 'string' ? open : 'agents');
    onSettingsChange(open ? pane.id : null);
  };
  const [worktreeDialog, setWorktreeDialog] = useState(false);
  const [answerer, setAnswerer] = useState(null); // null follows the current task; otherwise the agent id, or "jolo"
  const { engine, project, sessions, sessionId, settings, error, relayNote, projection, activeRun, usage, pendingPermission, changes, workspaces, workspaceId, workspace, agents, agentCatalog } = state;
  const panelScope = state.panelScope;
  const panelTabs = usePanelTabs(panelScope, (file, remaining) => {
    if (file.panelType === 'file' && file.url && !remaining.some(item => item.url === file.url)) void window.jolo.releaseChatFile?.(file.url);
  });
  const { context, setContext } = panelTabs;
  const plansOpen = panelTabs.items.some(tab => tab.id === 'plans');
  const schedulesOpen = panelTabs.items.some(tab => tab.id === 'schedules');
  useLayoutEffect(() => { setWatchChanges(context === 'changes' || context === 'files'); }, [context]);
  const contextFor = tab => tab?.panelType === 'file' ? 'files' : tab?.panelType ?? null;
  const selectTab = id => { panelTabs.select(id); setContext(contextFor(panelTabs.items.find(tab => tab.id === id))); };
  const closeTab = id => {
    const remaining = panelTabs.items.filter(tab => tab.id !== id);
    if (!remaining.length) setContext(null);
    else if (panelTabs.activeId === id) setContext(contextFor(remaining[Math.min(panelTabs.items.findIndex(tab => tab.id === id), remaining.length - 1)]));
    panelTabs.close(id);
  };
  const tabsFor = panelType => {
    const items = panelTabs.items.filter(item => item.panelType === panelType);
    return { items, activeId: panelTabs.activeId, active: items.find(item => item.id === panelTabs.activeId) ?? (panelType === 'file' ? null : items[0]),
      add: item => panelTabs.add({ ...item, panelType }), update: panelTabs.update, close: closeTab };
  };
  const browserTabs = tabsFor('browser'), terminalTabs = tabsFor('terminal'), fileTabs = tabsFor('file');
  const browser = browserTabs.active;
  const browserTitle = browser?.title ?? '';
  previewSession.current = sessionId;
  previewWorkspace.current = workspaceId;
  const openFilePreview = file => {
    if (file.sessionId !== previewSession.current) { if (file.url) void window.jolo.releaseChatFile?.(file.url); return; }
    fileTabs.add({ ...file, id: file.path, title: basename(file.path) }); setContext('files'); setView('task');
  };
  const pickFile = async (path = null) => {
    try {
      if (!window.jolo.pickChatFile) throw new Error('Quit and reopen Jolo to enable file tabs.');
      const params = { sessionId, projectId: project.projectId, workspaceId };
      const reply = path ? await window.jolo.previewChatFile({ ...params, path }) : await window.jolo.pickChatFile(params);
      if (!reply.ok) throw new Error(reply.error || 'Could not open this file.');
      if (reply.result) {
        if (previewWorkspace.current !== workspaceId) { if (reply.result.url) void window.jolo.releaseChatFile?.(reply.result.url); return; }
        openFilePreview(reply.result);
      }
    } catch (error) { state.setError(error.message); }
  };
  useLayoutEffect(() => {
    if (pane.id === 'pane-1' && hosts.header && hosts.sidebar && hosts.footer && !connection.initializing && (!state.restoringProject || engine.error)) return finishStartup();
  }, [pane.id, hosts.header, hosts.sidebar, hosts.footer, connection.initializing, state.restoringProject, engine.error]);
  const hostedAgents = useMemo(() => agentCatalog.filter((entry) => entry.transport !== "pty"), [agentCatalog]); // every structured transport answers as a task
  const livePlans = state.plans.filter((plan) => !["done", "cancelled"].includes(plan.state));
  const planCount = livePlans.length;
  const plansNeedingYou = livePlans.some((plan) => (plan.tasks ?? []).some((task) => task.state === "blocked"));
  const activeSchedules = state.schedules.filter((schedule) => schedule.state === "active").length;
  const agentName = (id) => agentCatalog.find((entry) => entry.id === id)?.displayName ?? id;
  const lastRun = projection ? [...projection.runs.values()].at(-1) : null;
  const session = sessions.find((item) => item.id === sessionId);
  useEffect(() => { setAnswerer(null); }, [sessionId, project?.projectId]);
  const needsFolder = workspace?.needsFolder ?? project?.needsFolder ?? false;
  const linkFolder = () => reportError(async () => {
    const folder = await window.jolo.openFolder();
    if (!folder) return;
    const linked = await state.call('project.linkFolder', { workspaceId, path: folder });
    await state.openProject(linked.rootPath, { sessionId });
    await state.refreshBoard();
  });
  const projectLabel = project?.standalone ? 'Chat' : project ? basename(project.rootPath) : 'Workspace';
  const newChat = () => reportError(async () => { await state.newChat(); setAnswerer(null); showTask(); });
  const changedFiles = useMemo(() => uniqueChanges(changes), [changes]);
  const verification = lastRun?.verification;
  const newBrowser = (url = '') => { onBrowserOpen(pane.id); browserTabs.add({ id: crypto.randomUUID(), title: 'New tab', url, icon: 'browser' }); setContext('browser'); };
  const openBrowser = (url = undefined) => { if (!browser || (url !== undefined && url !== browser.url)) newBrowser(url); else { onBrowserOpen(pane.id); selectTab(browser.id); } };
  const newTerminal = () => { const id = crypto.randomUUID(); const number = Math.max(0, ...terminalTabs.items.map(tab => tab.number ?? 0)) + 1; terminalTabs.add({ id, number, workspaceId, hookId: panelTabs.retained.some(({ item }) => item.panelType === 'terminal') ? `${pane.id}:${id}` : pane.id, title: `Terminal ${number}`, icon: 'terminal' }); setContext('terminal'); };
  const openTerminal = () => { if (!terminalTabs.items.length) newTerminal(); else selectTab(terminalTabs.active.id); };
  const closeTerminal = () => { if (terminalTabs.active) closeTab(terminalTabs.active.id); };
  const closeContext = () => setContext(null);
  const selectContext = (id) => {
    if (id === 'browser') return openBrowser();
    if (id === 'terminal') return openTerminal();
    const [, title, icon] = CONTEXT_PANELS.find(([key]) => key === id);
    if (!panelTabs.items.some(tab => tab.id === id)) panelTabs.add({ id, panelType: id, title, icon });
    else panelTabs.select(id);
    setContext(id);
  };
  const needsYou = state.board?.projects.filter((row) => row.attention === "needs_you").length ?? 0;
  const showTask = () => setView("task");
  const openRow = (row) => reportError(async () => { await state.openFromBoard(row); showTask(); });

  useEffect(() => {
    if (pane.id !== "pane-1") root.current?.querySelector(".pane-project")?.focus();
  }, [pane.id]);

  useEffect(() => {
    setOverlay(pane.id, active && Boolean(showSettings || pendingPermission || taskDialog || worktreeDialog || pickerOpen));
    return () => setOverlay(pane.id, false);
  }, [active, pane.id, setOverlay, showSettings, pendingPermission, taskDialog, worktreeDialog, pickerOpen]);
  useEffect(() => { void state.refreshAgents(); }, [workspaceId]);
  // Coming back to a task's window means its latest outcome was seen; a notification click lands on its task.
  // The listeners read the pane's state through a ref, so a board refresh does not take these
  // subscriptions down and put them back several times a second while a task runs.
  const latest = useRef(state);
  latest.current = state;
  const { onFocusRequest, watchSession } = connection;
  useEffect(() => {
    const onWindowFocus = () => { if (visible && view === "task" && workspaceId) void latest.current.markViewed(workspaceId); };
    window.addEventListener("focus", onWindowFocus);
    const open = (payload) => reportError(async () => {
      if (!active) return;
      const current = latest.current;
      const row = current.board?.projects.find((r) => r.projectId === payload.projectId) ?? (await current.refreshBoard())?.projects.find((r) => r.projectId === payload.projectId);
      if (row) { await current.openFromBoard(row); setView("task"); }
    });
    const offFocus = window.jolo.onFocusRequest(open); // a clicked OS notification
    const offNotice = onFocusRequest(open); // a clicked in-app notice, by the same path
    // While this pane is showing a task, that task finishing needs no notice: the user can see it happen.
    const offWatch = visible && view === "task" ? watchSession(sessionId) : null;
    return () => { window.removeEventListener("focus", onWindowFocus); offFocus(); offNotice(); offWatch?.(); };
  }, [active, visible, view, workspaceId, sessionId, onFocusRequest, watchSession]);

  const reportError = (operation) => Promise.resolve().then(operation).catch((e) => state.setError(e.message));
  const openFolder = () => reportError(async () => {
    const path = await window.jolo.openFolder();
    if (!path) return;
    await state.openProject(path);
    showTask();
  });
  const openOnboardingFolder = async () => {
    const path = await window.jolo.openFolder();
    if (path) await state.openProject(path, { sessionId: null });
  };
  const finishOnboarding = async (prompt, agentId, model) => {
    const [{ agents }, { presets }] = await Promise.all([state.call('agent.catalog', {}), state.call('provider.presets', {})]);
    if (!onboardingAgentAvailable(agentId, agents, model, presets)) throw new Error('This agent or provider is no longer available. Go back to choose another one.');
    if (!project || project.standalone) throw new Error('Choose a project folder first.');
    rememberModelChoice(agentId, model);
    const created = await state.newSession('', { agentId: agentId === 'jolo' ? null : agentId, workspaceId: project.workspaceId });
    setFirstTaskDraft({ sessionId: created.id, prompt });
    setAnswerer(null);
    updateOnboarding('completed');
    showTask();
  };

  useLayoutEffect(() => {
    register(pane.id, {
      project: state.project,
      workspaceId,
      hasBrowser: context === 'browser' && Boolean(browser),
      closePanelItem: () => {
        if (!visible || showSettings || view !== 'task' || !context) return false;
        if (panelTabs.items.length) {
          closeTab(panelTabs.activeId ?? panelTabs.items.at(-1).id);
        } else setContext(null);
        return true;
      },
      selectSession: state.selectSession,
      openTarget: (path, sessionId) => state.openProject(path, { sessionId }).then(() => setView("task")),
      closeBrowser: () => { panelTabs.removeType('browser'); if (context === 'browser') setContext(contextFor(panelTabs.items.filter(tab => tab.panelType !== 'browser').at(-1))); },
      pickProject: () => setPickerOpen(true),
      openProject: (path) => state.openProject(path).then(() => setView("task")).catch((e) => state.setError(e.message)),
      showBoard: async () => { await state.refreshBoard(); setView("board"); },
      showTask: () => setView("task"),
      newTask: () => (project?.standalone ? state.newChat() : state.newSession("")).then(() => setView("task")),
      newChat: () => state.newChat().then(() => setView('task')),
      board: () => state.board,
      closeTerminal,
      showPlans: () => selectContext("plans"),
      plans: () => state.plans,
      startAgent: async (agentId) => { const agent = await state.startAgent(agentId);  return agent; },
      stopAgent: (terminalId) => state.stopAgent(terminalId),
      agents: () => state.agents,
      pickAnswerer: (agentId) => chooseAnswerer(agentId ?? "jolo"),
      hostedAgents: () => hostedAgents,
      showSettings: () => setShowSettings(true),
      closeSettings: () => setShowSettings(false),
      showChanges: () => selectContext("changes"),
      newWorktreeTask: (branch) => state.newSession("", { worktree: { branch } }).then(() => setView("task")).catch((e) => state.setError(e.message)),
      removeWorktree: () => state.removeWorktree(workspaceId, true).catch((e) => state.setError(e.message)),
      send: (prompt) => state.send(prompt, { agentId: chosenAgentId }).then((run) => { setAnswerer(null); return run; }).catch((e) => state.setError(e.message)), // the same route the composer takes
      openBrowser,
      openTerminal,
      resolvePermission: (decision) => state.resolvePermission(pendingPermission?.permissionId, decision),
      state: () => {
        const runs = projection ? [...projection.runs.values()] : [];
        const last = runs.at(-1);
        return {
          projectId: project?.projectId ?? null,
          standalone: Boolean(project?.standalone),
          workspaceId,
          workspaceMode: workspace?.mode ?? null,
          answerer: answererLabel,
          sessionAgentId,
          branch: workspace?.branch ?? null,
          view,
          boardRows: state.board?.projects.length ?? 0,
          needsYou,
          sessionId,
          runState: last?.state ?? null,
          runCount: runs.length,
          lastRunId: last?.id ?? null,
          assistantText: projection ? projection.ordered().filter((m) => m.role === "assistant" && m.kind === "text").map((m) => m.text).join("") : "",
          messageCount: projection ? projection.messages.size : 0,
          toolText: projection ? projection.ordered().filter((m) => m.kind === "tool").map((m) => m.text).join("\n") : "",
          pendingPermission: pendingPermission?.permissionId ?? null,
          terminalText: window.__joloTerminals?.get(terminalTabs.active?.hookId)?.text() ?? "",
          changes: changes.length,
          browserTitle,
          error,
        };
      },
    });
  });
  useEffect(() => () => register(pane.id, null), [pane.id, register]);

  const selectedModel = session ? session.model ?? settings?.model : readLastModelChoice()?.model ?? settings?.model;
  const providerLabel = (selectedModel?.preset === "fake" ? "Demo provider" : selectedModel?.model) ?? (settings?.demoProviderEnabled ? "Demo provider" : "Configure provider");
  const sessionAgentId = session?.agentId ?? null;
  const chosenAgentId = answerer === null ? (session ? sessionAgentId : newSessionModelChoice(hostedAgents, settings?.model).agentId ?? null) : answerer === "jolo" ? null : answerer;
  const chooseAnswerer = agentId => {
    setAnswerer(agentId);
    rememberModelChoice(agentId, selectedModel);
  };
  const answererLabel = chosenAgentId ? agentName(chosenAgentId) : `Jolo · ${modelLabel(providerLabel)}`;
  const saveModelChoice = async ({ agentId, preset, model, effort }) => {
    if (agentId !== 'jolo') {
      await state.call('settings.update', { agents: { [agentId]: { model, effort } } });
      rememberModelChoice(agentId, selectedModel);
      await Promise.all([state.refreshSettings(), state.refreshCatalog()]);
      setAnswerer(agentId);
      return;
    }
    const selection = { ...(selectedModel?.preset === preset && selectedModel?.model === model ? selectedModel : {}), preset, model, effort };
    if (sessionId) {
      const current = (await state.call('session.page', { sessionId })).session;
      await state.call('session.setModel', { sessionId, model: selection, expectedRevision: current.revision });
    } else {
      await state.call('settings.update', { model: selection });
    }
    rememberModelChoice(null, selection);
    setAnswerer('jolo');
    if (!sessionId) await state.refreshSettings();
  };
  const taskMenu = (session) => reportError(async () => {
    const sessionWorkspace = workspaces.find((item) => item.id === session.workspaceId);
    const action = await window.jolo.taskMenu({ archived: session.state === "archived", worktree: Boolean(sessionWorkspace && sessionWorkspace.mode === "worktree" && sessionWorkspace.owned) });
    if (action === "archive") await state.manageSession(session, action);
    else if (action === "rename" || action === "delete") setTaskDialog({ session, action });
    else if (action === "remove-worktree") setTaskDialog({ session, action, workspace: sessionWorkspace });
  });
  const startWorktree = async ({ branch, base }) => { await state.newSession("", { worktree: { branch, base } }); showTask(); };
  const showTaskRail = view !== 'board' && !showSettings && hosts.sidebarCollapsed;
  const boardHeader = view === 'board' && !multi && !showSettings;
  return (
    <FilePreviewContext.Provider value={openFilePreview}>
    <div ref={root} className={`pane-workspace${context && view !== "board" ? " with-context" : ""}`} data-view={view}>
      {active && hosts.header && createPortal(boardHeader ? <BoardHeader connected={engine.connected} call={state.call} onSettings={() => setShowSettings('account')} /> : <header className="header">
        <div className="header-brand"><JoloLogo />{view !== "board" && <button className="sidebar-toggle" onClick={hosts.toggleSidebar} aria-label={hosts.sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'} aria-expanded={!hosts.sidebarCollapsed} aria-controls="workspace-sidebar" title={`${hosts.sidebarCollapsed ? 'Show' : 'Hide'} sidebar (${window.jolo.platform === 'darwin' ? '⌘' : 'Ctrl+'}B)`} disabled={showSettings}><Icon name="sidebar" /></button>}</div>
        <div className="header-workspace">
          <div className="header-breadcrumb">
            {showSettings ? <span className="settings-window-title">Settings</span> : multi ? <span className="header-task-title">Workspace</span> : <>
            <button className="workspace-title" onClick={() => setPickerOpen(true)} title={project?.standalone ? 'Choose a workspace' : project?.rootPath} aria-label="Open project"><Icon name={project?.standalone ? 'chat' : 'folder'} size={14} /><span>{projectLabel}</span><Icon name="down" size={12} /></button>
            <span className="header-separator">/</span>
            <h1 className="header-task-title" title={view === "board" ? "Workspaces" : session?.title || (project?.standalone ? "New chat" : "New task")}>{view === "board" ? "Workspaces" : session?.title || (project?.standalone ? "New chat" : "New task")}</h1>
            </>}
          </div>
          <div className="header-actions">
            {showSettings ? <button onClick={() => setShowSettings(false)} aria-label="Back to workspace"><Icon name="back" size={14} />Back to workspace</button> : <>
            {view === "board" && <button onClick={() => setShowSettings(true)} aria-label="Settings" title="Settings"><Icon name="settings" /></button>}
            <button className={view === "board" ? "active" : ""} onClick={() => setView(view === "board" ? "task" : "board")} aria-label="Board" title="Board" aria-pressed={view === "board"}><Icon name="board" /><span className="header-action-label">Board</span>{needsYou > 0 && <span className="count needs">{needsYou}</span>}</button>
            <PanelMenu selected={view === 'board' ? null : context} panels={project?.standalone ? CONTEXT_PANELS.filter(([id]) => ['changes', 'browser', 'files', 'schedules'].includes(id)) : CONTEXT_PANELS} disabled={!project} details={{ changes: changedFiles.length ? `${changedFiles.length} files` : null, plans: planCount ? `${planCount}${plansNeedingYou ? ' · needs you' : ''}` : null, schedules: activeSchedules ? `${activeSchedules} active` : null, checks: verificationLabel(verification) }} onSelect={id => { selectContext(id); showTask(); }} onHide={() => setContext(null)} onOpenChange={setPanelMenuOpen} />
            {!multi && <span className="header-divider" aria-hidden="true" />}
            {!multi && <button className="header-split" disabled={!canSplit} onClick={() => onSplit(pane.id, "x")} aria-label="Split right" title="Split right"><Icon name="splitRight" size={14} /></button>}
            {!multi && <button className="header-split" disabled={!canSplit} onClick={() => onSplit(pane.id, "y")} aria-label="Split below" title="Split below"><Icon name="splitBelow" size={14} /></button>}
            </>}
          </div>
        </div>
      </header>, hosts.header)}
      {active && hosts.sidebar && createPortal(<Sidebar project={project} sessions={sessions} sessionId={sessionId} workspaceId={workspaceId} lastRun={lastRun} board={state.board} visible={view !== 'board'} call={state.call}
        onOpenTask={row => reportError(async () => { await state.openFromBoard(row); showTask(); })} onOpenFolder={openFolder} agentName={agentName}
        onNewChat={newChat} onNewSession={() => reportError(async () => { await state.newSession(); showTask(); })} onNewWorktree={() => setWorktreeDialog(true)}
        onNewWorkspaceTask={row => reportError(async () => { await state.newFromBoard(row); showTask(); })} onSettings={() => setShowSettings(true)} onTaskMenu={taskMenu} onError={state.setError} historyState={state.historyState} onHistory={view => reportError(() => state.setHistory(view))} />, hosts.sidebar)}
      {/* Name each task once: in the window bar for one pane, or in its own bar when split. */}
      {multi && <div className="pane-heading">
        <span className={`pane-indicator ${pendingPermission ? "needs-attention" : activeRun ? "is-running" : ""}`} title={pendingPermission ? "Needs your approval" : runLabel(lastRun)} />
        <button className="pane-project" onClick={() => setPickerOpen(true)} title={project?.standalone ? 'Choose a workspace' : project?.rootPath ?? "Choose project and task"} aria-label="Choose project and task"><span>{projectLabel}</span><Icon name="down" size={11} /></button>
        <span className="pane-heading-separator">/</span><h1 className="pane-task-name" title={view === "board" ? "Workspaces" : session?.title || (project?.standalone ? "New chat" : "New task")}>{view === "board" ? "Workspaces" : session?.title || (project?.standalone ? "New chat" : "New task")}</h1>
        <div className="pane-actions">
          {pendingPermission && <span className="pane-attention-label">Approval</span>}
          <button disabled={!canSplit} onClick={() => onSplit(pane.id, "x")} aria-label="Split right" title="Split right"><Icon name="splitRight" size={14} /></button>
          <button disabled={!canSplit} onClick={() => onSplit(pane.id, "y")} aria-label="Split below" title="Split below"><Icon name="splitBelow" size={14} /></button>
          {multi && <><button onClick={() => onZoom(pane.id)} aria-label={zoomed ? "Restore panes" : "Maximize pane"} title={zoomed ? "Restore panes" : "Maximize pane"}><Icon name={zoomed ? "restore" : "maximize"} size={13} /></button><button onClick={() => onClose(pane.id)} aria-label="Close pane" title="Close pane · tasks keep running"><Icon name="close" size={13} /></button></>}
        </div>
      </div>}
      <ContextSplit enabled={Boolean(context) && view !== 'board'}>
        <main className={`main${view === "board" ? " board-main" : showTaskRail ? " has-task-rail" : ""}`} aria-label={view === "board" ? "Work board" : "Conversation"}>
          {error && <div className="error" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => state.setError(null)}><Icon name="close" size={14} /></button></div>}
          {view === "board" ? pane.id === 'pane-1' && onboarding === 'active' ? <Onboarding connected={engine.connected} active={active && visible && !showSettings} settings={settings} project={project} call={state.call} onSettings={setShowSettings} onOpenFolder={openOnboardingFolder} onFinish={finishOnboarding} onDismiss={() => updateOnboarding('dismissed')} /> : pane.id === 'pane-1' && onboarding === null && (connection.initializing || state.restoringProject || state.board) && !engine.error ? <div className="empty-state" role="status">Getting your workspace ready…</div> : <Board board={state.board} connected={engine.connected} onGetStarted={pane.id === 'pane-1' ? () => updateOnboarding('active') : null} onOpen={openRow} onNewChat={newChat} onChatMenu={task => reportError(async () => taskMenu((await state.call('session.page', { sessionId: task.sessionId })).session))} onNewTask={row => reportError(async () => { await state.newFromBoard(row); showTask(); })} onOpenFolder={openFolder} call={state.call} /> : <>
          {(!project?.standalone || activeRun || pendingPermission) && <TaskHeader status={runLabel(activeRun ?? lastRun)} working={Boolean(activeRun)} branch={session && session.workspaceId !== project?.workspaceId ? workspace ? workspace.branch || "worktree" : "worktree removed" : null} branchPath={workspace?.path} agent={sessionAgentId ? agentName(sessionAgentId) : null} />}
          {needsFolder && <div className="resume-note" role="status"><span>This conversation belongs to {projectLabel}. Link its folder on this device to continue working.</span><button onClick={linkFolder}>Link local folder<Icon name="folderOpen" size={14} /></button></div>}
          <Conversation key={`conversation:${sessionId ?? project?.workspaceId ?? "empty"}`} agents={hostedAgents} projection={projection} sessionId={sessionId} history={state.history} standalone={Boolean(project?.standalone)} hasProject={Boolean(project)} onReview={() => selectContext("changes")} onOpenFolder={openFolder} assistantName={sessionAgentId ? agentName(sessionAgentId) : "Jolo"} assistantAgentId={sessionAgentId} providerModel={selectedModel?.model} />
          <PermissionNotice request={pendingPermission} active={active} onReview={() => onFocus(pane.id)} />
          {lastRun?.state === "paused" && lastRun.pauseReason !== "permission" && <div className="resume-note"><span>{pauseDescription(lastRun)}</span><button onClick={() => reportError(() => state.resumeRun(lastRun.id))}>Resume task<Icon name="right" size={14} /></button></div>}
          {session?.state === "archived" ? <div className="resume-note"><span>This task is archived.</span><button onClick={() => reportError(() => state.manageSession(session, "archive"))}>Restore task</button></div> : <Composer key={`composer:${sessionId ?? project?.workspaceId ?? "draft"}`} initialText={firstTaskDraft?.sessionId === sessionId ? firstTaskDraft.prompt : ""} onInitialTextUsed={() => setFirstTaskDraft(null)} agents={hostedAgents} disabled={!project || !engine.connected || needsFolder} autoFocusOnType={active && visible && !showSettings && !pendingPermission && !taskDialog && !worktreeDialog && !pickerOpen && !modelMenuOpen} running={Boolean(activeRun)} model={modelLabel(providerLabel)} projectName={project?.standalone ? "Chat" : project ? basename(project.rootPath) : null} standalone={Boolean(project?.standalone)} changesCount={changedFiles.length} onReview={() => selectContext("changes")} onSettings={() => setShowSettings(true)} answerer={answererLabel} answererId={chosenAgentId ?? "jolo"} answererName={chosenAgentId ? agentName(chosenAgentId) : "Jolo"} usage={usage} modelControl={<ModelControls agentId={chosenAgentId ?? 'jolo'} agents={hostedAgents} nativeModel={selectedModel} hasSession={Boolean(sessionId)} disabled={!engine.connected || !active || !visible || showSettings || Boolean(pendingPermission || taskDialog || worktreeDialog)} onSave={saveModelChoice} call={state.call} onSettings={setShowSettings} onOpenChange={setModelMenuOpen} />} queuedRuns={state.queuedRuns} onSendNow={id => reportError(() => state.sendNow(id))} onRemoveQueued={id => reportError(() => state.removeQueued(id))} onSend={async (prompt, options) => { try { const run = await state.send(prompt, { ...options, agentId: chosenAgentId }); setAnswerer(null); return run; } catch (e) { state.setError(e.message); throw e; } }} onStop={() => reportError(() => state.cancel())} />}
          </>}
        {showTaskRail && <TaskRail call={state.call} revision={state.board?.generatedAt} sessionId={sessionId} onOpen={row => reportError(async () => { await state.openFromBoard(row); showTask(); })} />}
        </main>
        <aside id={`${pane.id}-context`} className="inspector" aria-label="Task context" hidden={!context || view === "board"}>
          <div className="context-bar">
            <PanelItemTabs label="Panel tabs" paneId={pane.id} tabs={panelTabs.items} activeId={panelTabs.activeId} onSelect={selectTab} onClose={closeTab} newControl={<PanelMenu compact selected={null} panels={[
              ['browser', 'Browser', 'browser'], ['file', 'Open file…', 'file'], ['terminal', 'Terminal', 'terminal'],
              ...CONTEXT_PANELS.filter(([id]) => !['browser', 'terminal'].includes(id)),
            ]} disabled={!project} details={{}} onSelect={id => { if (id === 'browser') newBrowser(); else if (id === 'terminal') newTerminal(); else if (id === 'file') void pickFile(); else selectContext(id); }} onHide={closeContext} onOpenChange={setPanelMenuOpen} />} />
            <button className="context-close" onClick={closeContext} aria-label="Close context panel" title="Hide panel"><Icon name="close" size={15} /></button>
          </div>
          <div id={`${pane.id}-context-content`} className="context-content" role="tabpanel" aria-labelledby={panelTabs.activeId ? `${pane.id}-item-${encodeURIComponent(panelTabs.activeId)}` : undefined} aria-label={panelTabs.activeId ? undefined : 'Empty panel'}>
            <div className="changes-host" hidden={context !== "changes" && context !== "files"}>
              <div className="panel-item-content" hidden={context === 'files' && Boolean(fileTabs.active)}><ChangesPanel key={sessionId ?? "empty"} changes={changes} status={state.changesStatus} onRefresh={state.refreshChanges} view={context} onSelectFile={() => selectContext("changes")} onOpenFile={pickFile} onLoadDiff={state.loadDiff} onLoadFile={state.loadFile} onRevert={state.revertChange} /></div>
              {panelTabs.retained.filter(({ item }) => item.panelType === 'file').map(({ scope, item: file }) => <div className="panel-item-content" key={`${scope}:${file.id}`} hidden={scope !== panelScope || context !== 'files' || fileTabs.activeId !== file.id}><FilePreview file={file} onClose={null} /></div>)}
            </div>
            <div className="browser-host" hidden={context !== 'browser'}>
              {workspaceId && browserTabs.items.map(tab => <div className="panel-item-content" key={tab.id} hidden={browserTabs.activeId !== tab.id}><BrowserPane workspaceId={workspaceId} working={Boolean(activeRun)} cursorKey={lastRun?.id ?? sessionId} initialUrl={tab.url} onTitle={title => browserTabs.update(tab.id, { title: title || 'New tab' })} onNavigate={url => browserTabs.update(tab.id, { url })} /></div>)}
              {!browserTabs.items.length && <div className="panel-empty"><Icon name="browser" size={26} /><h2>No open tabs</h2><button onClick={() => newBrowser()}>New browser tab</button></div>}
            </div>
            <div className="tool-panel" id={`${pane.id}-checks-panel`} hidden={context !== "checks"}><ChecksPanel verification={verification} /></div>
            <div className="tool-panel" id={`${pane.id}-terminal-panel`} hidden={context !== "terminal"}>
              {panelTabs.retained.filter(({ item }) => item.panelType === 'terminal').map(({ scope, item: tab }) => <div className="panel-item-content" key={tab.id} hidden={scope !== panelScope || terminalTabs.activeId !== tab.id}><Suspense fallback={null}><TerminalPane workspaceId={tab.workspaceId} paneId={tab.hookId} onClose={() => terminalTabs.close(tab.id)} /></Suspense></div>)}
              {!terminalTabs.items.length && <div className="panel-empty"><Icon name="terminal" size={26} /><h2>No open terminals</h2><button onClick={newTerminal}>New terminal tab</button></div>}
            </div>
            <div className="tool-panel" id={`${pane.id}-plans-panel`} hidden={context !== "plans"}>{plansOpen && project && <PlanPane projectId={project.projectId} plans={state.plans} catalog={hostedAgents} call={state.call} refresh={state.refreshPlans} onOpenSession={(sessionId) => { state.selectSession(sessionId); setContext(null); showTask(); }} />}</div>
            <div className="tool-panel" id={`${pane.id}-schedules-panel`} hidden={context !== "schedules"}>{schedulesOpen && project && <SchedulesPanel sessionId={sessionId} schedules={state.schedules} call={state.call} refresh={state.refreshSchedules} />}</div>
          </div>
        </aside>
      </ContextSplit>
      {active && hosts.footer && createPortal(<footer className={`status${boardHeader && !engine.error && !relayNote ? ' board-status' : ''}`} hidden={boardHeader && !engine.error && !relayNote}><span><Icon name={project?.standalone ? "chat" : "folder"} size={12} />{project ? projectLabel : "No project"}</span><span title={engine.connected ? `Engine process ${engine.status?.pid ?? ""}` : engine.error}><span className={`state-dot ${engine.connected ? "" : "offline"}`} />{engine.connected ? "Local engine" : "Connecting…"}</span><span className="grow" /><span className={engine.error ? "warn" : ""}>{engine.error || relayNote || (activeRun ? runLabel(activeRun) : runLabel(lastRun))}</span></footer>, hosts.footer)}
      {active && pickerOpen && !pendingPermission && <PanePicker project={project} sessionId={sessionId} board={state.board} onOpen={async (path, sessionId) => { await state.openProject(path, { sessionId }); showTask(); }} onClose={() => setPickerOpen(false)} />}
      {active && showSettings && hosts.settings && createPortal(<Suspense fallback={null}><SettingsPage settings={settings} initialSection={settingsSection} session={session} onPresets={() => state.call("provider.presets", {})} onDiscoverProviderModels={(preset, options) => state.call("provider.models", { preset, ...options })} onSaveConnection={async (providers) => { await state.call("settings.update", { providers }); await state.refreshSettings(); }} onUseModel={async (model) => { let current = (await state.call("session.page", { sessionId: session.id })).session; if (current.agentId) current = (await state.call("session.setAgent", { sessionId: current.id, agentId: null, expectedRevision: current.revision })).session; await state.call("session.setModel", { sessionId: current.id, model, expectedRevision: current.revision }); setAnswerer("jolo"); rememberModelChoice(null, model); }} agents={agentCatalog} onSaveAgents={async (agents) => { await state.call("settings.update", { agents }); await state.refreshSettings(); await state.refreshCatalog(); }} onDiscoverModels={(agentId, { refresh = false } = {}) => state.call("agent.models", { agentId, refresh })} onSave={async (model) => { await state.call("settings.update", { model }); rememberModelChoice(null, model); await state.refreshSettings(); }} onSetCredential={async (provider, value) => (await state.call("credential.set", { provider, value })).stored} onClose={() => setShowSettings(false)} /></Suspense>, hosts.settings)}
      {active && pendingPermission && <PermissionDialog key={pendingPermission.permissionId} request={pendingPermission} workspacePath={workspaces.find(item => item.id === pendingPermission.workspaceId)?.path ?? workspace?.path} onDecide={(decision) => state.resolvePermission(pendingPermission.permissionId, decision)} />}
      {active && taskDialog && !pendingPermission && <TaskDialog key={`${taskDialog.session.id}:${taskDialog.action}`} {...taskDialog} onSubmit={(value) => taskDialog.action === "remove-worktree" ? state.removeWorktree(taskDialog.workspace.id, value.force) : state.manageSession(sessions.find((item) => item.id === taskDialog.session.id) ?? taskDialog.session, taskDialog.action, value)} onClose={() => setTaskDialog(null)} />}
      {active && worktreeDialog && !pendingPermission && project && <WorktreeDialog projectName={basename(project.rootPath)} onSubmit={startWorktree} onClose={() => setWorktreeDialog(false)} />}
    </div>
    </FilePreviewContext.Provider>
  );
});
