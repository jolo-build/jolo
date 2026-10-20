import { modelLabel } from '../model-options.js';
import { readLastModelChoice, rememberModelChoice, newSessionModelChoice } from '../last-model-choice.js';
import { lazy, memo, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useEngine } from "../use-engine.js";
import { Sidebar } from "./sidebar.jsx";
import { Conversation } from "./conversation.jsx";
import { ModelControls } from "./model-controls.jsx";
import { Composer } from "./composer.jsx";
import { BrowserPane } from "./browser-pane.jsx";
import { ContextSplit } from './context-split.jsx';
import { FilePreview } from './file-preview.jsx';
import { FileTree } from './file-tree.jsx';
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
import { useWorkspaceTasks } from "../use-workspace-tasks.js";
import { taskFamily } from "../workspace-tasks.js";
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
 *     settings: HTMLElement | null,
 *     sidebarCollapsed: boolean,
 *     toggleSidebar: () => void,
 *   },
 *   settingsOpen: boolean,
 *   onSettingsChange: (paneId: string | null) => void,
 *   onFocus: (paneId: string) => void,
 *   onSplit: (source: string, axis: string, options?: { task?: any, before?: boolean }) => void,
 *   onClose: (paneId: string) => void,
 *   onZoom: (paneId: string) => void,
 *   register: (paneId: string, controller: any) => void,
 *   onBrowserOpen: (paneId: string) => void,
 * }} WorkspacePaneProps
 */
export const WorkspacePane = memo(function WorkspacePane(/** @type {WorkspacePaneProps} */ { pane, active, visible, multi, zoomed, canSplit, hosts, settingsOpen, onSettingsChange, onFocus, onSplit, onClose, onZoom, register, onBrowserOpen }) {
  const root = useRef(null);
  const [watchChanges, setWatchChanges] = useState(false);
  const previewSession = useRef(null);
  const previewWorkspace = useRef(null);
  const state = useEngine({ restoreLastProject: pane.id === "pane-1", initialProject: pane.path, initialTask: pane.task, initialNewChat: pane.newChat, visible, watchChanges });
  const connection = useEngineConnection();
  const [onboarding, setOnboarding] = useState(readOnboardingState);
  const [firstTaskDraft, setFirstTaskDraft] = useState(null);
  const onboardingNow = useRef(onboarding);
  const updateOnboarding = value => { onboardingNow.current = value; saveOnboardingState(value); setOnboarding(value); };
  useEffect(() => {
    if (pane.id !== 'pane-1' || onboarding !== null || connection.initializing || state.restoringProject) return;
    const next = initialOnboardingState(null, state.board);
    if (next) updateOnboarding(next);
  }, [pane.id, onboarding, connection.initializing, state.restoringProject, state.board]);
  // Opening any conversation leaves the first-run guide; Settings can bring it back. The guide's own first task
  // completes it first, so this reads the latest state rather than the render's.
  useEffect(() => {
    if (pane.id === 'pane-1' && onboardingNow.current === 'active' && state.sessionId) updateOnboarding('dismissed');
  }, [pane.id, onboarding, state.sessionId]);
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
  const [changesFocus, setChangesFocus] = useState(null);
  const [revealPath, setRevealPath] = useState(/** @type {{ path: string } | null} */ (null)); // a folder a breadcrumb asked the tree to show
  const [filesExpanded, setFilesExpanded] = useState(false); // the Files panel over the whole pane, the conversation set aside
  const [answerer, setAnswerer] = useState(null); // null follows the current task; otherwise the agent id, or "jolo"
  const { engine, project, sessions, sessionId, settings, error, projection, activeRun, pendingPermission, changes, workspaces, workspaceId, workspace, agents, agentCatalog } = state;
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
  // Expanded lasts while a file is on screen in the Files panel, whose heading holds the button that gives the
  // conversation back; Esc does too, unless Settings, which Esc closes, is open over it. An error, which the
  // conversation shows, gives it back as well.
  const fileShown = context === 'files' && Boolean(fileTabs.active);
  const expanded = filesExpanded && fileShown;
  useEffect(() => { if (!fileShown || error) setFilesExpanded(false); }, [fileShown, error]);
  useEffect(() => {
    if (!expanded || !active || showSettings) return;
    const restore = event => { if (event.key === 'Escape' && !event.defaultPrevented && !document.querySelector('dialog[open]')) setFilesExpanded(false); };
    window.addEventListener('keydown', restore);
    return () => window.removeEventListener('keydown', restore);
  }, [expanded, active, showSettings]);
  const browser = browserTabs.active;
  const browserTitle = browser?.title ?? '';
  previewSession.current = sessionId;
  previewWorkspace.current = workspaceId;
  /** A project file picked in the tree opens as a tab, at `line` when a search found it there; a text file can be edited
   * there and written back. Opening it again keeps the tab's unsaved mark, since its edits stay in the tab. `opened` is
   * new with each opening, so the line is revealed again then, and not when the tab's mark or text changes. */
  const openWorkspaceFile = (relative, line = 0) => reportError(async () => {
    const result = await state.call('workspace.readFile', { workspaceId, path: relative });
    const name = basename(relative);
    const kind = result.binary ? 'details' : /\.(md|markdown|mdx)$/i.test(relative) ? 'markdown' : 'text';
    const title = fileTabs.items.find(item => item.id === relative)?.title ?? name;
    fileTabs.add({ id: relative, path: relative, title, kind, workspaceId, sessionId, ...(line > 0 && !result.binary ? { line, opened: {} } : {}), ...(result.binary
      ? { size: result.bytes, extension: (relative.match(/\.([^./]+)$/)?.[1] ?? '').toUpperCase(), note: 'This file is not text, so it is not shown here.' }
      : { text: result.text, truncated: result.truncated, editable: !result.truncated }) });
    setContext('files');
  });
  const saveWorkspaceFile = async (file, text) => {
    await state.call('workspace.writeFile', { workspaceId: file.workspaceId, path: file.path, text });
    fileTabs.update(file.id, { text });
  };
  const openFilePreview = file => {
    if (file.sessionId !== previewSession.current) { if (file.url) void window.jolo.releaseChatFile?.(file.url); return; }
    fileTabs.add({ ...file, id: file.path, title: basename(file.path) }); setContext('files');
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
    if (pane.id === 'pane-1' && hosts.header && hosts.sidebar && !connection.initializing && (!state.restoringProject || engine.error)) return finishStartup();
  }, [pane.id, hosts.header, hosts.sidebar, connection.initializing, state.restoringProject, engine.error]);
  const hostedAgents = useMemo(() => agentCatalog.filter((entry) => entry.transport !== "pty"), [agentCatalog]); // every structured transport answers as a task
  // What "@" can point a message at besides an agent: this checkout's files, and the other folders the sidebar lists.
  const mentionWorkspace = useMemo(() => project && !project.standalone && workspaceId ? { id: workspaceId, path: workspace?.path ?? project.rootPath } : null, [project, workspaceId, workspace?.path]);
  const otherProjects = useMemo(() => (state.board?.projects ?? []).filter(row => !row.standalone && row.workspaceId !== workspaceId).sort((a, b) => a.workspace.path.localeCompare(b.workspace.path)).map(row => ({ name: basename(row.workspace.path) || row.name, path: row.workspace.path, workspaceId: row.workspaceId })), [state.board, workspaceId]);
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
  const newChat = () => reportError(async () => { await state.newChat(); setAnswerer(null); });
  const changedFiles = useMemo(() => uniqueChanges(changes), [changes]);
  const verification = lastRun?.verification;
  const newBrowser = (url = '') => { onBrowserOpen(pane.id); browserTabs.add({ id: crypto.randomUUID(), title: 'New tab', url, icon: 'browser' }); setContext('browser'); };
  const openBrowser = (url = undefined) => { if (!browser || (url !== undefined && url !== browser.url)) newBrowser(url); else { onBrowserOpen(pane.id); selectTab(browser.id); } };
  const newTerminal = () => { const id = crypto.randomUUID(); const number = Math.max(0, ...terminalTabs.items.map(tab => tab.number ?? 0)) + 1; terminalTabs.add({ id, number, workspaceId, hookId: panelTabs.retained.some(({ item }) => item.panelType === 'terminal') ? `${pane.id}:${id}` : pane.id, title: `Terminal ${number}`, icon: 'terminal' }); setContext('terminal'); };
  const openTerminal = () => { if (!terminalTabs.items.length) newTerminal(); else selectTab(terminalTabs.active.id); };
  const closeTerminal = () => { if (terminalTabs.active) closeTab(terminalTabs.active.id); };
  const closeContext = () => setContext(null);
  const togglePanel = () => { if (context) { setContext(null); return true; } if (panelTabs.active) { selectTab(panelTabs.active.id); return true; } return false; };
  const selectContext = (id) => {
    if (id === 'browser') return openBrowser();
    if (id === 'terminal') return openTerminal();
    const [, title, icon] = CONTEXT_PANELS.find(([key]) => key === id);
    if (!panelTabs.items.some(tab => tab.id === id)) panelTabs.add({ id, panelType: id, title, icon });
    else panelTabs.select(id);
    setContext(id);
  };
  const needsYou = state.board?.projects.filter((row) => row.attention === "needs_you").length ?? 0;

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
    const onWindowFocus = () => { if (visible && workspaceId) void latest.current.markViewed(workspaceId); };
    window.addEventListener("focus", onWindowFocus);
    const open = (payload) => reportError(async () => {
      if (!active) return;
      const current = latest.current;
      const row = current.board?.projects.find((r) => r.projectId === payload.projectId) ?? (await current.refreshBoard())?.projects.find((r) => r.projectId === payload.projectId);
      if (row) await current.openFromBoard(row);
    });
    const offFocus = window.jolo.onFocusRequest(open); // a clicked OS notification
    const offNotice = onFocusRequest(open); // a clicked in-app notice, by the same path
    // While this pane is showing a task, that task finishing needs no notice: the user can see it happen.
    // Its approvals need none either, unless a narrow pane's open panel may be hiding the inline request.
    const offWatch = visible ? watchSession(sessionId, { approvals: active || !context }) : null;
    return () => { window.removeEventListener("focus", onWindowFocus); offFocus(); offNotice(); offWatch?.(); };
  }, [active, visible, workspaceId, sessionId, context, onFocusRequest, watchSession]);

  const reportError = (operation) => Promise.resolve().then(operation).catch((e) => state.setError(e.message));
  const openFolder = () => reportError(async () => {
    const path = await window.jolo.openFolder();
    if (!path) return;
    await state.openProject(path);
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
    // The guide closes as soon as the task opens, so the draft must be waiting before its message bar mounts.
    setFirstTaskDraft({ sessionId: null, prompt });
    let created;
    try { created = await state.newSession('', { agentId: agentId === 'jolo' ? null : agentId, workspaceId: project.workspaceId }); }
    catch (error) { setFirstTaskDraft(null); throw error; }
    setFirstTaskDraft(draft => draft && { ...draft, sessionId: created.id });
    setAnswerer(null);
    updateOnboarding('completed');
  };

  useLayoutEffect(() => {
    register(pane.id, {
      project: state.project,
      workspaceId,
      hasBrowser: context === 'browser' && Boolean(browser),
      closePanelItem: () => {
        if (!visible || showSettings || !context) return false;
        if (panelTabs.items.length) {
          closeTab(panelTabs.activeId ?? panelTabs.items.at(-1).id);
        } else setContext(null);
        return true;
      },
      selectSession: state.selectSession,
      openTarget: (path, sessionId) => state.openProject(path, { sessionId }),
      closeBrowser: () => { panelTabs.removeType('browser'); if (context === 'browser') setContext(contextFor(panelTabs.items.filter(tab => tab.panelType !== 'browser').at(-1))); },
      pickProject: () => setPickerOpen(true),
      openProject: (path) => state.openProject(path).catch((e) => state.setError(e.message)),
      refreshBoard: () => state.refreshBoard(),
      newTask: () => (project?.standalone ? state.newChat() : state.newSession("")),
      newChat: () => state.newChat(),
      board: () => state.board,
      closeTerminal,
      togglePanel,
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
      newWorktreeTask: (branch) => state.newSession("", { worktree: { branch } }).catch((e) => state.setError(e.message)),
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
  // The chip and menu show this chat's own choice for its agent, over the agent's setting.
  const chatAgents = useMemo(() => session?.agentId && session.agentModel ? hostedAgents.map((entry) => entry.id === session.agentId ? { ...entry, model: session.agentModel.model ?? entry.model, effort: session.agentModel.effort ?? entry.effort } : entry) : hostedAgents, [hostedAgents, session?.agentId, session?.agentModel]);
  const providerLabel = (selectedModel?.preset === "fake" ? "Demo provider" : selectedModel?.model) ?? (settings?.demoProviderEnabled ? "Demo provider" : "Configure provider");
  const sessionAgentId = session?.agentId ?? null;
  // Child tasks live in the same folder (or among the chats) as the conversation that started them.
  const familyList = useWorkspaceTasks({ call: state.call, revision: state.board?.generatedAt, ...(project?.standalone ? { standalone: true } : { workspaceId: session?.workspaceId ?? project?.workspaceId }) });
  const family = taskFamily(familyList.result?.tasks ?? [], sessionId);
  const branch = session && session.workspaceId !== project?.workspaceId ? workspace ? workspace.branch || "worktree" : "worktree removed" : null;
  const chosenAgentId = answerer === null ? (session ? sessionAgentId : newSessionModelChoice(hostedAgents, settings?.model).agentId ?? null) : answerer === "jolo" ? null : answerer;
  // Claude Code and Codex compact their own context when asked; the usage panel offers it for the agent answering here.
  const compactable = Boolean(session) && ["claude-stream", "codex-app-server"].includes(hostedAgents.find((entry) => entry.id === chosenAgentId)?.transport);
  const chooseAnswerer = agentId => {
    setAnswerer(agentId);
    rememberModelChoice(agentId, selectedModel);
  };
  const answererLabel = chosenAgentId ? agentName(chosenAgentId) : `Jolo · ${modelLabel(providerLabel)}`;
  // The usage panel has a tab per agent worth looking at: the one answering now, any that answered in this task
  // (a mention included), and every installed agent that can report its plan's limits.
  const usageTabs = [...new Set([chosenAgentId ?? 'jolo', ...state.taskAgents(), ...hostedAgents.filter((entry) => entry.available && entry.supportsLimits).map((entry) => entry.id)])]
    .map((id) => ({ id, name: id === 'jolo' ? 'Jolo' : agentName(id), usage: state.usageFor(id) }));
  const saveModelChoice = async ({ agentId, preset, model, effort }) => {
    if (agentId !== 'jolo') {
      if (session?.agentId === agentId) {
        // The chat's own agent: the choice belongs to this chat, and the agent's setting stays the default for new ones.
        const current = (await state.call('session.page', { sessionId, limit: 1 })).session;
        await state.call('session.setAgentModel', { sessionId, model: model ?? null, effort: effort ?? null, expectedRevision: current.revision });
        rememberModelChoice(agentId, selectedModel);
        return;
      }
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
    const action = await window.jolo.taskMenu({ archived: session.state === "archived", pinned: Boolean(session.pinnedAt), worktree: Boolean(sessionWorkspace && sessionWorkspace.mode === "worktree" && sessionWorkspace.owned) });
    if (action === "archive" || action === "pin") await state.manageSession(session, action);
    else if (action === "rename" || action === "delete") setTaskDialog({ session, action });
    else if (action === "remove-worktree") setTaskDialog({ session, action, workspace: sessionWorkspace });
  });
  const startWorktree = async ({ branch, base }) => { await state.newSession("", { worktree: { branch, base } }); };
  const mac = window.jolo.platform === 'darwin';
  return (
    <FilePreviewContext.Provider value={openFilePreview}>
    <div ref={root} className={`pane-workspace${context ? " with-context" : ""}${expanded ? " files-expanded" : ""}`}>
      {active && hosts.header && createPortal(<header className="header">
        <div className="header-brand"><JoloLogo /><button className="sidebar-toggle" onClick={hosts.toggleSidebar} aria-label={hosts.sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'} aria-expanded={!hosts.sidebarCollapsed} aria-controls="workspace-sidebar" title={`${hosts.sidebarCollapsed ? 'Show' : 'Hide'} sidebar (${window.jolo.platform === 'darwin' ? '⌘' : 'Ctrl+'}B)`} disabled={showSettings}><Icon name="sidebar" /></button></div>
        <div className="header-workspace">
          <div className="header-breadcrumb">
            {showSettings ? <span className="settings-window-title">Settings</span> : multi ? <span className="header-task-title">Workspace</span> : <>
            <button className="workspace-title" onClick={() => setPickerOpen(true)} title={project?.standalone ? 'Choose a workspace' : project?.rootPath} aria-label="Open project"><Icon name={project?.standalone ? 'chat' : 'folder'} size={14} /><span>{projectLabel}</span><Icon name="down" size={12} /></button>
            <span className="header-separator">/</span>
            <h1 className="header-task-title" title={session?.title || (project?.standalone ? "New chat" : "New task")}>{session?.title || (project?.standalone ? "New chat" : "New task")}</h1>
            </>}
          </div>
          <div className="header-actions">
            {showSettings ? <button onClick={() => setShowSettings(false)} aria-label="Back to workspace"><Icon name="back" size={14} />Back to workspace</button> : <>
            <PanelMenu selected={context} panels={project?.standalone ? CONTEXT_PANELS.filter(([id]) => ['changes', 'browser', 'files', 'schedules'].includes(id)) : CONTEXT_PANELS} disabled={!project} details={{ changes: changedFiles.length ? `${changedFiles.length} files` : null, plans: planCount ? `${planCount}${plansNeedingYou ? ' · needs you' : ''}` : null, schedules: activeSchedules ? `${activeSchedules} active` : null, checks: verification && verification.status !== 'not_run' ? verificationLabel(verification) : null }} onSelect={selectContext} onHide={() => setContext(null)} onOpenChange={setPanelMenuOpen}
              onToggle={togglePanel} extra={[['x', 'Split right', 'splitRight', mac ? '⌘\\' : 'Ctrl+\\', !canSplit], ['y', 'Split below', 'splitBelow', mac ? '⇧⌘\\' : 'Ctrl+Shift+\\', !canSplit]]} onExtra={axis => onSplit(pane.id, axis)} />
            </>}
          </div>
        </div>
      </header>, hosts.header)}
      {active && hosts.sidebar && createPortal(<Sidebar project={project} sessions={sessions} sessionId={sessionId} workspaceId={workspaceId} lastRun={lastRun} board={state.board} call={state.call}
        onOpenTask={row => reportError(() => state.openFromBoard(row))} onOpenFolder={openFolder} agentName={agentName}
        onNewChat={newChat} onNewSession={() => reportError(() => state.newSession())} onNewWorktree={() => setWorktreeDialog(true)}
        onNewWorkspaceTask={row => reportError(() => state.newFromBoard(row))} onSettings={() => setShowSettings(true)} onTaskMenu={taskMenu} onError={state.setError} historyState={state.historyState} onHistory={view => reportError(() => state.setHistory(view))} />, hosts.sidebar)}
      {/* Name each task once: in the window bar for one pane, or in its own bar when split. */}
      {multi && <div className="pane-heading">
        <span className={`pane-indicator ${pendingPermission ? "needs-attention" : activeRun ? "is-running" : ""}`} title={pendingPermission ? "Needs your approval" : runLabel(lastRun)} />
        <button className="pane-project" onClick={() => setPickerOpen(true)} title={project?.standalone ? 'Choose a workspace' : project?.rootPath ?? "Choose project and task"} aria-label="Choose project and task"><span>{projectLabel}</span><Icon name="down" size={11} /></button>
        <span className="pane-heading-separator">/</span><h1 className="pane-task-name" title={session?.title || (project?.standalone ? "New chat" : "New task")}>{session?.title || (project?.standalone ? "New chat" : "New task")}</h1>
        <div className="pane-actions">
          <button disabled={!canSplit} onClick={() => onSplit(pane.id, "x")} aria-label="Split right" title="Split right"><Icon name="splitRight" size={14} /></button>
          <button disabled={!canSplit} onClick={() => onSplit(pane.id, "y")} aria-label="Split below" title="Split below"><Icon name="splitBelow" size={14} /></button>
          {multi && <><button onClick={() => onZoom(pane.id)} aria-label={zoomed ? "Restore panes" : "Maximize pane"} title={zoomed ? "Restore panes" : "Maximize pane"}><Icon name={zoomed ? "restore" : "maximize"} size={13} /></button><button onClick={() => onClose(pane.id)} aria-label="Close pane" title="Close pane · tasks keep running"><Icon name="close" size={13} /></button></>}
        </div>
      </div>}
      <ContextSplit enabled={Boolean(context)} kind={context === 'files' ? 'files' : 'panel'}>
        <main className="main" aria-label="Conversation">
          {error && <div className="error" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => state.setError(null)}><Icon name="close" size={14} /></button></div>}
          {pane.id === 'pane-1' && onboarding === 'active' && !sessionId ? <Onboarding connected={engine.connected} active={active && visible && !showSettings} settings={settings} project={project} call={state.call} onSettings={setShowSettings} onOpenFolder={openOnboardingFolder} onFinish={finishOnboarding} onDismiss={() => updateOnboarding('dismissed')} /> : <>
          {(branch || family.children.length > 0 || family.parent) && <TaskHeader branch={branch} branchPath={workspace?.path}
            childTasks={family.children} parentTask={family.parent} onOpenTask={id => reportError(() => state.selectSession(id))} />}
          {needsFolder && <div className="resume-note" role="status"><span>This conversation belongs to {projectLabel}. Link its folder on this device to continue working.</span><button onClick={linkFolder}>Link local folder<Icon name="folderOpen" size={14} /></button></div>}
          <Conversation key={`conversation:${sessionId ?? project?.workspaceId ?? "empty"}`} agents={hostedAgents} projection={projection} sessionId={sessionId} history={state.history} standalone={Boolean(project?.standalone)} hasProject={Boolean(project)} onReview={path => { if (typeof path === 'string') setChangesFocus({ path, at: Date.now() }); selectContext("changes"); }} onOpenFolder={openFolder} assistantName={sessionAgentId ? agentName(sessionAgentId) : "Jolo"} assistantAgentId={sessionAgentId} providerModel={selectedModel?.model} />
          <PermissionNotice request={pendingPermission} active={active} onReview={() => onFocus(pane.id)} />
          {lastRun?.state === "paused" && lastRun.pauseReason !== "permission" && <div className="resume-note"><span>{pauseDescription(lastRun)}</span><button onClick={() => reportError(() => state.resumeRun(lastRun.id))}>Resume task<Icon name="right" size={14} /></button></div>}
          {session?.state === "archived" ? <div className="resume-note"><span>This task is archived.</span><button onClick={() => reportError(() => state.manageSession(session, "archive"))}>Restore task</button></div> : <Composer key={`composer:${sessionId ?? project?.workspaceId ?? "draft"}`} initialText={firstTaskDraft && (firstTaskDraft.sessionId ?? sessionId) === sessionId ? firstTaskDraft.prompt : ""} onInitialTextUsed={() => setFirstTaskDraft(null)} agents={hostedAgents} workspace={mentionWorkspace} projects={otherProjects} disabled={!project || !engine.connected || needsFolder} offline={!engine.connected} autoFocusOnType={active && visible && !showSettings && !pendingPermission && !taskDialog && !worktreeDialog && !pickerOpen && !modelMenuOpen} running={Boolean(activeRun)} model={modelLabel(providerLabel)} standalone={Boolean(project?.standalone)} changesCount={changedFiles.length} onReview={() => selectContext("changes")} onSettings={() => setShowSettings(true)} answerer={answererLabel} answererId={chosenAgentId ?? "jolo"} answererName={chosenAgentId ? agentName(chosenAgentId) : "Jolo"} usageTabs={usageTabs} onCompact={compactable ? () => reportError(() => state.send("/compact", { agentId: chosenAgentId })) : null} modelControl={<ModelControls agents={chatAgents} hiddenSources={settings?.hiddenSources ?? []} agentId={chosenAgentId ?? 'jolo'} nativeModel={selectedModel} hasSession={Boolean(sessionId)} disabled={!engine.connected || !active || !visible || showSettings || Boolean(pendingPermission || taskDialog || worktreeDialog)} onSave={saveModelChoice} call={state.call} onSettings={setShowSettings} onOpenChange={setModelMenuOpen} />} queuedRuns={state.queuedRuns} onSendNow={id => reportError(() => state.sendNow(id))} onRemoveQueued={id => reportError(() => state.removeQueued(id))} onSend={async (prompt, options) => { try { const run = await state.send(prompt, { ...options, agentId: chosenAgentId }); setAnswerer(null); return run; } catch (e) { state.setError(e.message); throw e; } }} onStop={() => reportError(() => state.cancel())} />}
          </>}
        </main>
        <aside id={`${pane.id}-context`} className="inspector" aria-label="Task context" hidden={!context}>
          <div className="context-bar">
            <PanelItemTabs label="Panel tabs" paneId={pane.id} tabs={panelTabs.items} activeId={panelTabs.activeId} onSelect={selectTab} onClose={closeTab} newControl={<PanelMenu compact selected={null} panels={[
              ['browser', 'Browser', 'browser'], ['file', 'Open file…', 'file'], ['terminal', 'Terminal', 'terminal'],
              ...CONTEXT_PANELS.filter(([id]) => !['browser', 'terminal'].includes(id)),
            ]} disabled={!project} details={{}} onSelect={id => { if (id === 'browser') newBrowser(); else if (id === 'terminal') newTerminal(); else if (id === 'file') void pickFile(); else selectContext(id); }} onHide={closeContext} onOpenChange={setPanelMenuOpen} />} />
            <button className="context-close" onClick={closeContext} aria-label="Close context panel" title="Hide panel"><Icon name="close" size={15} /></button>
          </div>
          <div id={`${pane.id}-context-content`} className="context-content" role="tabpanel" aria-labelledby={panelTabs.activeId ? `${pane.id}-item-${encodeURIComponent(panelTabs.activeId)}` : undefined} aria-label={panelTabs.activeId ? undefined : 'Empty panel'}>
            <div className="changes-host" hidden={context !== "changes" && context !== "files"}>
              <div className="panel-item-content" hidden={context !== 'changes'}><ChangesPanel key={sessionId ?? "empty"} changes={changes} status={state.changesStatus} onRefresh={state.refreshChanges} view="changes" focus={changesFocus} onSelectFile={() => selectContext("changes")} onOpenFile={pickFile} onLoadDiff={state.loadDiff} onLoadFile={state.loadFile} onRevert={state.revertChange} /></div>
              <div className="files-layout" hidden={context !== 'files'}>
                <div className="files-main">
                  {panelTabs.retained.filter(({ item }) => item.panelType === 'file').map(({ scope, item: file }) => <div className="panel-item-content" key={`${scope}:${file.id}`} hidden={scope !== panelScope || fileTabs.activeId !== file.id}><FilePreview file={file} onClose={null} onSave={file.editable ? text => saveWorkspaceFile(file, text) : null} onDirty={file.editable ? dirty => fileTabs.update(file.id, { title: dirty ? `${basename(file.path)} •` : basename(file.path) }) : null} onReveal={file.workspaceId === workspaceId && !project?.standalone ? folder => setRevealPath({ path: folder }) : null} expanded={expanded} onExpand={() => setFilesExpanded(value => !value)} /></div>)}
                  {!fileTabs.active && <div className="panel-empty files-empty"><Icon name="folder" size={28} /><h2>Open files appear here</h2><p>{workspaceId && !project?.standalone ? 'Pick a file in the tree, or click a file path in the conversation.' : 'Click a file path in the conversation, or open a folder to browse its files.'}</p></div>}
                </div>
                {workspaceId && !project?.standalone && <FileTree key={workspaceId} call={state.call} workspaceId={workspaceId} active={context === 'files'} revision={`${changes.length}:${lastRun?.updatedAt ?? ''}`} selectedPath={fileTabs.active?.path ?? null} reveal={revealPath} onOpen={openWorkspaceFile} onPick={() => void pickFile()} />}
              </div>
            </div>
            <div className="browser-host" hidden={context !== 'browser'}>
              {workspaceId && browserTabs.items.map(tab => <div className="panel-item-content" key={tab.id} hidden={browserTabs.activeId !== tab.id}><BrowserPane workspaceId={workspaceId} working={Boolean(activeRun)} cursorKey={lastRun?.id ?? sessionId} initialUrl={tab.url} onTitle={title => browserTabs.update(tab.id, { title: title || 'New tab' })} onNavigate={url => browserTabs.update(tab.id, { url })} /></div>)}
              {!browserTabs.items.length && <div className="panel-empty"><Icon name="browser" size={26} /><h2>No open tabs</h2><button onClick={() => newBrowser()}>New browser tab</button></div>}
            </div>
            <div className="tool-panel" id={`${pane.id}-checks-panel`} hidden={context !== "checks"}><ChecksPanel verification={verification} /></div>
            <div className="tool-panel" id={`${pane.id}-terminal-panel`} hidden={context !== "terminal"}>
              {panelTabs.retained.filter(({ item }) => item.panelType === 'terminal').map(({ scope, item: tab }) => <div className="panel-item-content" key={tab.id} hidden={scope !== panelScope || terminalTabs.activeId !== tab.id}><Suspense fallback={null}><TerminalPane workspaceId={tab.workspaceId} paneId={tab.hookId} /></Suspense></div>)}
              {!terminalTabs.items.length && <div className="panel-empty"><Icon name="terminal" size={26} /><h2>No open terminals</h2><button onClick={newTerminal}>New terminal tab</button></div>}
            </div>
            <div className="tool-panel" id={`${pane.id}-plans-panel`} hidden={context !== "plans"}>{plansOpen && project && <PlanPane projectId={project.projectId} plans={state.plans} catalog={hostedAgents} call={state.call} refresh={state.refreshPlans} onOpenSession={(sessionId) => { state.selectSession(sessionId); setContext(null); }} />}</div>
            <div className="tool-panel" id={`${pane.id}-schedules-panel`} hidden={context !== "schedules"}>{schedulesOpen && project && <SchedulesPanel sessionId={sessionId} schedules={state.schedules} call={state.call} refresh={state.refreshSchedules} />}</div>
          </div>
        </aside>
      </ContextSplit>
      {active && pickerOpen && !pendingPermission && <PanePicker project={project} sessionId={sessionId} board={state.board} onOpen={(path, sessionId) => state.openProject(path, { sessionId })} onClose={() => setPickerOpen(false)} />}
      {active && showSettings && hosts.settings && createPortal(<Suspense fallback={null}><SettingsPage settings={settings} onHideSource={async (key, hide) => { const current = settings?.hiddenSources ?? []; await state.call("settings.update", { hiddenSources: hide ? [...current, key] : current.filter((entry) => entry !== key) }); await state.refreshSettings(); }} initialSection={settingsSection} onGetStarted={pane.id === 'pane-1' ? () => { setShowSettings(false); reportError(async () => { await state.selectSession(null); updateOnboarding('active'); }); } : null} session={session} onPresets={() => state.call("provider.presets", {})} onDiscoverProviderModels={(preset, options) => state.call("provider.models", { preset, ...options })} onSaveConnection={async (providers) => { await state.call("settings.update", { providers }); await state.refreshSettings(); }} onUseModel={async (model) => { let current = (await state.call("session.page", { sessionId: session.id })).session; if (current.agentId) current = (await state.call("session.setAgent", { sessionId: current.id, agentId: null, expectedRevision: current.revision })).session; await state.call("session.setModel", { sessionId: current.id, model, expectedRevision: current.revision }); setAnswerer("jolo"); rememberModelChoice(null, model); }} agents={agentCatalog} onSaveAgents={async (agents) => { await state.call("settings.update", { agents }); await state.refreshSettings(); await state.refreshCatalog(); }} onDiscoverModels={(agentId, { refresh = false } = {}) => state.call("agent.models", { agentId, refresh })} onSave={async (model) => { await state.call("settings.update", { model }); rememberModelChoice(null, model); await state.refreshSettings(); }} onSetCredential={async (provider, value) => (await state.call("credential.set", { provider, value })).stored} onClose={() => setShowSettings(false)} /></Suspense>, hosts.settings)}
      {active && pendingPermission && <PermissionDialog key={pendingPermission.permissionId} request={pendingPermission} workspacePath={workspaces.find(item => item.id === pendingPermission.workspaceId)?.path ?? workspace?.path} onDecide={(decision) => state.resolvePermission(pendingPermission.permissionId, decision)} />}
      {active && taskDialog && !pendingPermission && <TaskDialog key={`${taskDialog.session.id}:${taskDialog.action}`} {...taskDialog} onSubmit={(value) => taskDialog.action === "remove-worktree" ? state.removeWorktree(taskDialog.workspace.id, value.force) : state.manageSession(sessions.find((item) => item.id === taskDialog.session.id) ?? taskDialog.session, taskDialog.action, value)} onClose={() => setTaskDialog(null)} />}
      {active && worktreeDialog && !pendingPermission && project && <WorktreeDialog projectName={basename(project.rootPath)} onSubmit={startWorktree} onClose={() => setWorktreeDialog(false)} />}
    </div>
    </FilePreviewContext.Provider>
  );
});
