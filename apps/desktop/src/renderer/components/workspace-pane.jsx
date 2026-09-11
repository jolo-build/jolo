import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useEngine } from "../use-engine.js";
import { Sidebar } from "./sidebar.jsx";
import { Conversation } from "./conversation.jsx";
import { Composer } from "./composer.jsx";
import { BrowserPane } from "./browser-pane.jsx";
import { SettingsPage } from "./settings.jsx";
import { PermissionDialog } from "./permission-dialog.jsx";
import { PermissionNotice } from "./permission-notice.jsx";
import { ChangesPanel } from "./changes-panel.jsx";
import { TerminalPane } from "./terminal-pane.jsx";
import { Icon } from "./icon.jsx";
import { ChecksPanel } from "./checks-panel.jsx";
import { PlanPane } from "./plan-pane.jsx";
import { JoloLogo } from "./brand.jsx";
import { TaskDialog } from "./task-dialog.jsx";
import { TaskHeader } from "./task-header.jsx";
import { Board } from "./board.jsx";
import { BoardHeader } from "./board-header.jsx";
import { WorktreeDialog } from "./worktree-dialog.jsx";
import { AgentPane } from "./agent-pane.jsx";
import { basename, runLabel, pauseDescription, uniqueChanges, verificationLabel } from "../presentation.js";

import { createPortal } from "react-dom";
import { useEngineConnection } from "../engine-context.jsx";
import { PanePicker } from "./pane-picker.jsx";
import { finishStartup } from "../startup.js";

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
 *   onActivate: () => void,
 *   onSplit: (source: string, axis: string, options?: { task?: any, before?: boolean }) => void,
 *   onClose: (paneId: string) => void,
 *   onZoom: (paneId: string) => void,
 *   register: (paneId: string, controller: any) => void,
 *   onBrowserOpen: (paneId: string) => void,
 * }} WorkspacePaneProps
 */
export const WorkspacePane = memo(function WorkspacePane(/** @type {WorkspacePaneProps} */ { pane, active, visible, multi, zoomed, canSplit, hosts, settingsOpen, onSettingsChange, onViewChange, onActivate, onSplit, onClose, onZoom, register, onBrowserOpen }) {
  const root = useRef(null);
  const [view, setView] = useState(pane.id === "pane-1" ? "board" : "task");
  useLayoutEffect(() => { onViewChange(pane.id, view); }, [onViewChange, pane.id, view]);
  const [context, setContext] = useState(null);
  const state = useEngine({ restoreLastProject: pane.id === "pane-1", initialProject: pane.path, initialTask: pane.task, initialNewChat: pane.newChat, visible: visible && view === "task", watchChanges: context === 'changes' || context === 'files' });
  const connection = useEngineConnection();
  const { setOverlay } = connection;
  const [pickerOpen, setPickerOpen] = useState(false);
  const showSettings = settingsOpen;
  const [settingsSection, setSettingsSection] = useState('agents');
  const [taskDialog, setTaskDialog] = useState(null);
  const setShowSettings = (open) => {
    if (open) setSettingsSection(typeof open === 'string' ? open : 'agents');
    onSettingsChange(open ? pane.id : null);
  };
  const [browser, setBrowser] = useState(null); // { url } while the pane is open (one live page by default, §5.4)
  const [browserTitle, setBrowserTitle] = useState("");
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [toolsPanel, setToolsPanel] = useState(null);
  const [worktreeDialog, setWorktreeDialog] = useState(false);
  const [agentTerminalId, setAgentTerminalId] = useState(null);
  const [answerer, setAnswerer] = useState(null); // null follows the current task; otherwise the agent id, or "jolo"
  const { engine, project, sessions, sessionId, settings, error, relayNote, projection, activeRun, usage, pendingPermission, changes, workspaces, workspaceId, workspace, agents, agentCatalog } = state;
  useLayoutEffect(() => {
    if (pane.id === 'pane-1' && hosts.header && hosts.sidebar && hosts.footer && !connection.initializing && (!state.restoringProject || engine.error)) return finishStartup();
  }, [pane.id, hosts.header, hosts.sidebar, hosts.footer, connection.initializing, state.restoringProject, engine.error]);
  const agentsNeedingYou = agents.filter((agent) => agent.status === "needs_input").length;
  const hostedAgents = agentCatalog.filter((entry) => entry.transport !== "pty"); // every structured transport answers as a task
  const livePlans = state.plans.filter((plan) => !["done", "cancelled"].includes(plan.state));
  const planCount = livePlans.length;
  const plansNeedingYou = livePlans.some((plan) => (plan.tasks ?? []).some((task) => task.state === "blocked"));
  const agentName = (id) => agentCatalog.find((entry) => entry.id === id)?.displayName ?? id;
  const lastRun = projection ? [...projection.runs.values()].at(-1) : null;
  const session = sessions.find((item) => item.id === sessionId);
  const projectLabel = project?.standalone ? 'Chat' : project ? basename(project.rootPath) : 'Workspace';
  const newChat = () => reportError(async () => { await state.newChat(); setAnswerer(null); showTask(); });
  const changedFiles = uniqueChanges(changes);
  const verification = lastRun?.verification;
  const openBrowser = (url = browser?.url ?? "") => { onBrowserOpen(pane.id); setBrowser({ url }); setContext("browser"); };
  const openTerminal = () => { setTerminalOpen(true); setToolsPanel("terminal"); };
  const closeContext = () => { setContext(null); setBrowser(null); };
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
  useEffect(() => { setContext(null); setBrowser(null); setTerminalOpen(false); setToolsPanel(null); setAgentTerminalId(null); void state.refreshAgents(); }, [workspaceId]); // panes belong to one checkout
  // Coming back to a task's window means its latest outcome was seen; a notification click lands on its task.
  useEffect(() => {
    const onFocus = () => { if (visible && view === "task" && workspaceId) void state.markViewed(workspaceId); };
    window.addEventListener("focus", onFocus);
    const open = (payload) => reportError(async () => {
      if (!active) return;
      const row = state.board?.projects.find((r) => r.projectId === payload.projectId) ?? (await state.refreshBoard())?.projects.find((r) => r.projectId === payload.projectId);
      if (row) { await state.openFromBoard(row); setView("task"); }
    });
    const offFocus = window.jolo.onFocusRequest(open); // a clicked OS notification
    const offNotice = connection.onFocusRequest(open); // a clicked in-app notice, by the same path
    // While this pane is showing a task, that task finishing needs no notice: the user can see it happen.
    const offWatch = visible && view === "task" ? connection.watchSession(sessionId) : null;
    return () => { window.removeEventListener("focus", onFocus); offFocus(); offNotice(); offWatch?.(); };
  }, [active, visible, view, workspaceId, sessionId, state.board, connection]);

  const reportError = (operation) => Promise.resolve().then(operation).catch((e) => state.setError(e.message));
  const openFolder = async () => {
    const path = await window.jolo.openFolder();
    if (path) await state.openProject(path).catch((e) => state.setError(e.message));
  };

  useLayoutEffect(() => {
    register(pane.id, {
      project: state.project,
      workspaceId,
      hasBrowser: context === 'browser' && Boolean(browser),
      selectSession: state.selectSession,
      openTarget: (path, sessionId) => state.openProject(path, { sessionId }).then(() => setView("task")),
      closeBrowser: () => { if (browser) closeContext(); },
      pickProject: () => setPickerOpen(true),
      openProject: (path) => state.openProject(path).then(() => setView("task")).catch((e) => state.setError(e.message)),
      showBoard: async () => { await state.refreshBoard(); setView("board"); },
      showTask: () => setView("task"),
      newTask: () => (project?.standalone ? state.newChat() : state.newSession("")).then(() => setView("task")),
      newChat: () => state.newChat().then(() => setView('task')),
      board: () => state.board,
      closeTerminal: () => { setTerminalOpen(false); setToolsPanel(null); },
      showAgents: () => setToolsPanel("agents"),
      showPlans: () => setToolsPanel("plans"),
      plans: () => state.plans,
      startAgent: async (agentId) => { const agent = await state.startAgent(agentId); setToolsPanel("agents"); setAgentTerminalId(agent.terminalId); return agent; },
      stopAgent: (terminalId) => state.stopAgent(terminalId).then(() => setAgentTerminalId(null)),
      agents: () => state.agents,
      pickAnswerer: (agentId) => setAnswerer(agentId ?? "jolo"),
      hostedAgents: () => hostedAgents,
      showSettings: () => setShowSettings(true),
      closeSettings: () => setShowSettings(false),
      showChanges: () => setContext("changes"),
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
          terminalText: (window.__joloTerminals?.get(pane.id) ?? window.__joloTerminal)?.text() ?? "",
          changes: changes.length,
          browserTitle,
          error,
        };
      },
    });
  });
  useEffect(() => () => register(pane.id, null), [pane.id, register]);

  const selectedModel = session?.model ?? settings?.model;
  const providerLabel = (selectedModel?.preset === "fake" ? "Demo provider" : selectedModel?.model) ?? (settings?.demoProviderEnabled ? "Demo provider" : "Configure provider");
  const sessionAgentId = session?.agentId ?? null;
  const chosenAgentId = answerer === null ? sessionAgentId : answerer === "jolo" ? null : answerer;
  const answererLabel = chosenAgentId ? agentName(chosenAgentId) : `Jolo · ${providerLabel}`;
  const pickAnswerer = () => reportError(async () => {
    const choice = await window.jolo.answererMenu({ items: [
      { id: "jolo", label: "Jolo", checked: !chosenAgentId },
      ...hostedAgents.map((entry) => ({ id: `agent:${entry.id}`, label: entry.available ? entry.displayName : `${entry.displayName} (not installed)`, checked: chosenAgentId === entry.id, enabled: entry.available })),
    ] });
    if (choice === "settings") setShowSettings(chosenAgentId ? "agents" : "provider");
    else if (choice === "jolo") setAnswerer("jolo");
    else if (choice?.startsWith("agent:")) setAnswerer(choice.slice(6));
  });
  const taskMenu = (session) => reportError(async () => {
    const sessionWorkspace = workspaces.find((item) => item.id === session.workspaceId);
    const action = await window.jolo.taskMenu({ archived: session.state === "archived", worktree: Boolean(sessionWorkspace && sessionWorkspace.mode === "worktree" && sessionWorkspace.owned) });
    if (action === "archive") await state.manageSession(session, action);
    else if (action === "rename" || action === "delete") setTaskDialog({ session, action });
    else if (action === "remove-worktree") setTaskDialog({ session, action, workspace: sessionWorkspace });
  });
  const startWorktree = async ({ branch, base }) => { await state.newSession("", { worktree: { branch, base } }); showTask(); };
  const boardHeader = view === 'board' && !multi && !showSettings;
  return (
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
            <button className={context === "changes" ? "active" : ""} onClick={() => setContext(context === "changes" ? null : "changes")} aria-label="Changes" title="Changes" disabled={!project}><Icon name="changes" /><span className="header-action-label">Changes</span>{changedFiles.length > 0 && <span className="count">{changedFiles.length}</span>}</button>
            <button className={context === "browser" ? "active" : ""} onClick={() => context === "browser" ? closeContext() : openBrowser()} aria-label="Browser" title="Browser" disabled={!project}><Icon name="browser" /><span className="header-action-label">Browser</span></button>
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
      <div className="pane-body">
        <main className={`main${view === "board" ? " board-main" : ""}`} aria-label={view === "board" ? "Work board" : "Conversation"}>
          {error && <div className="error" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => state.setError(null)}><Icon name="close" size={14} /></button></div>}
          {view === "board" ? <Board board={state.board} connected={engine.connected} onOpen={openRow} onNewChat={newChat} onChatMenu={task => reportError(async () => taskMenu((await state.call('session.page', { sessionId: task.sessionId })).session))} onNewTask={row => reportError(async () => { await state.newFromBoard(row); showTask(); })} onOpenFolder={openFolder} call={state.call} /> : <>
          {(!project?.standalone || activeRun || pendingPermission) && <TaskHeader status={runLabel(activeRun ?? lastRun)} working={Boolean(activeRun)} branch={session && session.workspaceId !== project?.workspaceId ? workspace ? workspace.branch || "worktree" : "worktree removed" : null} branchPath={workspace?.path} agent={sessionAgentId ? agentName(sessionAgentId) : null} />}
          <Conversation key={`conversation:${sessionId ?? project?.workspaceId ?? "empty"}`} agents={hostedAgents} projection={projection} sessionId={sessionId} history={state.history} standalone={Boolean(project?.standalone)} hasProject={Boolean(project)} changesCount={changedFiles.length} verification={verification} onReview={() => setContext("changes")} onOpenFolder={openFolder} assistantName={sessionAgentId ? agentName(sessionAgentId) : "Jolo"} assistantAgentId={sessionAgentId} providerModel={selectedModel?.model} />
          <PermissionNotice request={pendingPermission} active={active} onReview={onActivate} />
          {lastRun?.state === "paused" && lastRun.pauseReason !== "permission" && <div className="resume-note"><span>{pauseDescription(lastRun)}</span><button onClick={() => reportError(() => state.resumeRun(lastRun.id))}>Resume task<Icon name="right" size={14} /></button></div>}
          {session?.state === "archived" ? <div className="resume-note"><span>This task is archived.</span><button onClick={() => reportError(() => state.manageSession(session, "archive"))}>Restore task</button></div> : <Composer key={`composer:${sessionId ?? project?.workspaceId ?? "draft"}`} agents={hostedAgents} disabled={!project || !engine.connected} autoFocusOnType={active && visible && !showSettings && !pendingPermission && !taskDialog && !worktreeDialog && !pickerOpen} running={Boolean(activeRun)} model={providerLabel} projectName={project?.standalone ? "Chat" : project ? basename(project.rootPath) : null} standalone={Boolean(project?.standalone)} changesCount={changedFiles.length} onReview={() => setContext("changes")} onSettings={() => setShowSettings(true)} answerer={answererLabel} answererId={chosenAgentId ?? "jolo"} answererName={chosenAgentId ? agentName(chosenAgentId) : "Jolo"} usage={usage} onPickAnswerer={pickAnswerer} queuedRuns={state.queuedRuns} onSendNow={id => reportError(() => state.sendNow(id))} onRemoveQueued={id => reportError(() => state.removeQueued(id))} onSend={async (prompt, options) => { try { const run = await state.send(prompt, { ...options, agentId: chosenAgentId }); setAnswerer(null); return run; } catch (e) { state.setError(e.message); throw e; } }} onStop={() => reportError(() => state.cancel())} />}
          </>}
        </main>
        <aside className="inspector" aria-label="Task context" hidden={!context || view === "board"}>
          <div className="context-tabs" role="tablist" aria-label="Workspace view" onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            const tabs = /** @type {HTMLElement[]} */ ([...event.currentTarget.querySelectorAll('[role="tab"]')]);
            const index = tabs.indexOf(/** @type {HTMLElement} */ (document.activeElement));
            if (index < 0) return;
            event.preventDefault();
            const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
            tabs[next].focus(); tabs[next].click();
          }}>
            {[['changes', 'Changes'], ['browser', 'Browser'], ['files', 'Files']].map(([id, label]) => <button key={id} id={`${pane.id}-${id}-tab`} role="tab" aria-selected={context === id} tabIndex={context === id ? 0 : -1} aria-controls={`${pane.id}-context-content`} onClick={() => id === "browser" ? openBrowser() : setContext(id)}>{label}{id === "changes" && changedFiles.length > 0 && <span className="count">{changedFiles.length}</span>}</button>)}
            <span className="grow" /><button onClick={closeContext} aria-label="Close context panel"><Icon name="close" size={15} /></button>
          </div>
          <div id={`${pane.id}-context-content`} className="context-content" role="tabpanel" aria-labelledby={`${pane.id}-${context ?? "changes"}-tab`}>
            <div className="changes-host" hidden={context === "browser"}>
              <ChangesPanel key={sessionId ?? "empty"} changes={changes} status={state.changesStatus} onRefresh={state.refreshChanges} view={context} onSelectFile={() => setContext("changes")} onLoadDiff={state.loadDiff} onLoadFile={state.loadFile} onRevert={state.revertChange} />
            </div>
            {context === "browser" && browser && workspaceId && <BrowserPane key={workspaceId} workspaceId={workspaceId} initialUrl={browser.url} onTitle={setBrowserTitle} onNavigate={(url) => setBrowser({ url })} />}
          </div>
        </aside>
        <section className="task-tools" aria-label="Task tools" hidden={view === "board" || project?.standalone}>
          <div className="tools-bar">
            <button aria-expanded={toolsPanel === "checks"} aria-controls={`${pane.id}-checks-panel`} onClick={() => setToolsPanel(toolsPanel === "checks" ? null : "checks")}><Icon name="circleCheck" />Checks<span className={verification?.status === "passed" ? "good" : "muted"}>{verificationLabel(verification)}</span></button>
            <button aria-expanded={toolsPanel === "terminal"} aria-controls={`${pane.id}-terminal-panel`} onClick={() => toolsPanel === "terminal" ? setToolsPanel(null) : openTerminal()} disabled={!project}><Icon name="terminal" />Terminal</button>
            <button aria-expanded={toolsPanel === "plans"} aria-controls={`${pane.id}-plans-panel`} onClick={() => setToolsPanel(toolsPanel === "plans" ? null : "plans")} disabled={!project} title="Split work into tasks across agents"><Icon name="plan" />Plans{planCount > 0 && <span className={plansNeedingYou ? "count needs" : "count"}>{planCount}</span>}</button>
            <button aria-expanded={toolsPanel === "agents"} aria-controls={`${pane.id}-agents-panel`} onClick={() => setToolsPanel(toolsPanel === "agents" ? null : "agents")} disabled={!workspaceId} title="Run another coding agent in this project"><Icon name="agents" />Agents{agents.length > 0 && <span className={agentsNeedingYou ? "count needs" : "count"}>{agents.length}</span>}</button>
            <span className="grow" />
            {terminalOpen && <button onClick={() => { setTerminalOpen(false); if (toolsPanel === "terminal") setToolsPanel(null); }} title="Close terminal and its shell" aria-label="Close terminal"><Icon name="close" size={14} /></button>}
            <button aria-label={toolsPanel ? "Collapse tools" : "Expand tools"} onClick={() => setToolsPanel(toolsPanel ? null : "checks")}><Icon name="down" className={toolsPanel ? "" : "flipped"} size={14} /></button>
          </div>
          <div className="tool-panel" id={`${pane.id}-checks-panel`} hidden={toolsPanel !== "checks"}><ChecksPanel verification={verification} /></div>
          <div className="tool-panel" id={`${pane.id}-terminal-panel`} hidden={toolsPanel !== "terminal"}>{terminalOpen && workspaceId && <TerminalPane key={workspaceId} workspaceId={workspaceId} paneId={pane.id} />}</div>
          <div className="tool-panel" id={`${pane.id}-plans-panel`} hidden={toolsPanel !== "plans"}>{toolsPanel === "plans" && project && <PlanPane projectId={project.projectId} plans={state.plans} catalog={hostedAgents} call={state.call} refresh={state.refreshPlans} onOpenSession={(sessionId) => { state.selectSession(sessionId); setToolsPanel(null); showTask(); }} />}</div>
          <div className="tool-panel" id={`${pane.id}-agents-panel`} hidden={toolsPanel !== "agents"}>{toolsPanel === "agents" && workspaceId && <AgentPane workspaceId={workspaceId} paneId={pane.id} catalog={agentCatalog} agents={agents} selectedId={agentTerminalId} onSelect={setAgentTerminalId} onStart={state.startAgent} onStop={async (terminalId) => { await state.stopAgent(terminalId); setAgentTerminalId(null); }} onStartSession={async (agentId) => { await state.newSession("", { agentId }); setAnswerer(null); setToolsPanel(null); showTask(); }} />}</div>
        </section>
      </div>
      {active && hosts.footer && createPortal(<footer className={`status${boardHeader && !engine.error && !relayNote ? ' board-status' : ''}`} hidden={boardHeader && !engine.error && !relayNote}><span><Icon name={project?.standalone ? "chat" : "folder"} size={12} />{project ? projectLabel : "No project"}</span><span title={engine.connected ? `Engine process ${engine.status?.pid ?? ""}` : engine.error}><span className={`state-dot ${engine.connected ? "" : "offline"}`} />{engine.connected ? "Local engine" : "Connecting…"}</span><span className="grow" /><span className={engine.error ? "warn" : ""}>{engine.error || relayNote || (activeRun ? runLabel(activeRun) : runLabel(lastRun))}</span></footer>, hosts.footer)}
      {active && pickerOpen && !pendingPermission && <PanePicker project={project} sessionId={sessionId} board={state.board} onOpen={async (path, sessionId) => { await state.openProject(path, { sessionId }); showTask(); }} onClose={() => setPickerOpen(false)} />}
      {active && showSettings && hosts.settings && createPortal(<SettingsPage settings={settings} initialSection={settingsSection} session={session} onPresets={() => state.call("provider.presets", {})} onDiscoverProviderModels={(preset, options) => state.call("provider.models", { preset, ...options })} onSaveConnection={async (providers) => { await state.call("settings.update", { providers }); await state.refreshSettings(); }} onUseModel={async (model) => { let current = (await state.call("session.page", { sessionId: session.id })).session; if (current.agentId) current = (await state.call("session.setAgent", { sessionId: current.id, agentId: null, expectedRevision: current.revision })).session; await state.call("session.setModel", { sessionId: current.id, model, expectedRevision: current.revision }); setAnswerer("jolo"); }} agents={agentCatalog} onSaveAgents={async (agents) => { await state.call("settings.update", { agents }); await state.refreshSettings(); await state.refreshCatalog(); }} onDiscoverModels={(agentId, { refresh = false } = {}) => state.call("agent.models", { agentId, refresh })} onSave={async (model) => { await state.call("settings.update", { model }); await state.refreshSettings(); }} onSetCredential={async (provider, value) => (await state.call("credential.set", { provider, value })).stored} onClose={() => setShowSettings(false)} />, hosts.settings)}
      {active && pendingPermission && <PermissionDialog key={pendingPermission.permissionId} request={pendingPermission} onDecide={(decision) => state.resolvePermission(pendingPermission.permissionId, decision)} />}
      {active && taskDialog && !pendingPermission && <TaskDialog key={`${taskDialog.session.id}:${taskDialog.action}`} {...taskDialog} onSubmit={(value) => taskDialog.action === "remove-worktree" ? state.removeWorktree(taskDialog.workspace.id, value.force) : state.manageSession(sessions.find((item) => item.id === taskDialog.session.id) ?? taskDialog.session, taskDialog.action, value)} onClose={() => setTaskDialog(null)} />}
      {active && worktreeDialog && !pendingPermission && project && <WorktreeDialog projectName={basename(project.rootPath)} onSubmit={startWorktree} onClose={() => setWorktreeDialog(false)} />}
    </div>
  );
});
