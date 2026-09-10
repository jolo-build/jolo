import { requestId as createRequestId, TERMINAL } from "@jolo/client/run-state";
// Interactive terminal client: Ink + React, imported only in interactive mode.
// Bounded projection, capped redraws, one restoration path for every exit.
import React, { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { render, Box, Text, useApp, useInput, useWindowSize } from "ink";
import { SessionProjection } from "@jolo/client/projection";
import { clean } from "./markdown.js";
import { createPromptState, promptReducer } from "./prompt-history.js";
import { supportsKittyKeyboard } from "./keyboard.js";
import { terminalLayout } from "./layout.js";
import { Progress } from "./progress.jsx";
import { NativeTranscript, TranscriptLines, useNativeTranscript } from "./native-transcript.jsx";
import { ModelConfig } from "./model-config.jsx";
import { currentModelLabel, parseModelCommand } from "./model-config.js";
import { SessionMenu } from "./sessions.jsx";
import { parseSessionCommand } from "../sessions.js";
import { sessionLoader } from "./session-loader.js";
import { Prompt } from "./prompt.jsx";


function useTick(intervalMs) {
  const [revision, bump] = useReducer((x) => x + 1, 0);
  const pending = useRef(false);
  const redraw = () => { if (pending.current) return; pending.current = true; setTimeout(() => { pending.current = false; bump(); }, intervalMs); };
  return { revision, redraw };
}

function App({ client, project, initialSession, cursor, onExit, restored = false, onRestore, draftAgentId = null, initialStatus = "connected", onChooseAgent }) {
  const { exit } = useApp();
  const size = useWindowSize();
  const { revision, redraw } = useTick(50); // batch incoming model updates; direct input stays responsive
  const projection = useMemo(() => new SessionProjection({ readArtifact: (artifactId, offset, length) => client.call("artifact.read", { artifactId, offset, length }), maxTextBytes: 512 * 1024, onChange: redraw }), [client]);
  const [session, setSession] = useState(initialSession);
  const [draftAgent, setDraftAgent] = useState(draftAgentId);
  const [loadingSession, setLoadingSession] = useState(Boolean(initialSession));
  const sessionRef = useRef(initialSession);
  const [promptState, dispatchPrompt] = useReducer(promptReducer, undefined, createPromptState);
  const input = promptState.value;
  const [permission, setPermission] = useState(null);
  const [status, setStatus] = useState(initialStatus);
  const [showTools, setShowTools] = useState(false);
  const [changes, setChanges] = useState([]);
  const [welcomeOpen, setWelcomeOpen] = useState(!restored);
  const [modelConfig, setModelConfig] = useState(null);
  const [sessionMenu, setSessionMenu] = useState(null);
  const [settings, setSettings] = useState(null);
  const ctrlC = useRef(0);
  const layout = terminalLayout({ ...size, permission: Boolean(permission), changes: changes.length > 0 });
  const { columns, rows } = layout;
  const agentId = session ? session.agentId ?? null : draftAgent;

  const refreshSettings = () => client.call("settings.get", {}).then(({ settings }) => setSettings(settings)).catch((error) => setStatus(error.message));
  useEffect(() => { void refreshSettings(); }, [client]);

  useEffect(() => {
    let disposed = false;
    let permissionChanges = 0;
    const loader = initialSession ? sessionLoader({
      client, sessionId: initialSession.id, projection,
      onPage(page) {
        dispatchPrompt({ type: "seed", prompts: page.runs.map((run) => run.prompt) });
        setLoadingSession(false);
        if (page.hasOlder) setStatus("Showing the most recent messages in this session.");
        for (const m of page.messages) if (m.committedBytes > 0) void projection.fill(m.id);
        if ([...projection.runs.values()].some((run) => run.state === "awaiting_permission")) {
          const before = permissionChanges;
          void client.call("board.list", {}).then(({ projects }) => {
            if (disposed || permissionChanges !== before) return;
            const pending = projects.find((row) => row.run?.sessionId === initialSession.id)?.pendingPermission;
            if (pending) { setPermission(pending); setWelcomeOpen(false); }
          }).catch((error) => { if (!disposed) setStatus(error.message); });
        }
      },
      onError(error) { setStatus(error.message); },
    }) : null;
    const offEvent = client.onEvent((event) => {
      if (!sessionRef.current || event.sessionId !== sessionRef.current.id) return;
      if (event.type === "session.updated") {
        sessionRef.current = event.payload.session;
        setSession(event.payload.session);
        onChooseAgent(event.payload.session.agentId ?? null);
      }
      if (loader) loader.event(event); else projection.applyEvent(event);
      if (event.type === "permission.requested") { permissionChanges++; setPermission(event.payload); setWelcomeOpen(false); }
      if (event.type === "permission.resolved") { permissionChanges++; setPermission((p) => (p && p.permissionId === event.payload.permissionId ? null : p)); }
      if (event.type === "files.changed") setChanges((list) => [...list, ...event.payload.changes].slice(-50));
      if (event.type === "run.verification") setStatus(`verification: ${event.payload.status}`);
    });
    const offPreview = client.onPreview((preview) => {
      if (!sessionRef.current || preview.sessionId !== sessionRef.current.id) return;
      if (loader) loader.preview(preview); else projection.applyPreview(preview);
    });
    const offClose = client.onClose(() => { setStatus("engine connection lost"); });
    const offReconnect = client.onReconnect?.(async () => {
      try {
        if (initialSession) {
          const page = await client.call("session.page", { sessionId: initialSession.id });
          projection.seed(page);
          for (const message of page.messages) if (message.committedBytes > 0) await projection.fill(message.id);
        }
        setStatus("connected");
      } catch (error) { setStatus(error.message); }
    });
    if (loader) void loader.load();
    return () => { disposed = true; loader?.dispose(); offEvent(); offPreview(); offClose(); offReconnect?.(); };
  }, [client, projection, initialSession]);

  const activeRun = () => [...projection.runs.values()].find((run) => run.state && !TERMINAL.has(run.state) && run.state !== "paused") ?? null;
  const lastRun = () => [...projection.runs.values()].at(-1) ?? null;

  const send = async (prompt) => {
    let current = sessionRef.current;
    if (!current) {
      const created = await client.call("session.create", { projectId: project.projectId, workspaceId: project.workspaceId, title: prompt.slice(0, 80), ...(agentId ? { agentId } : {}) });
      current = created.session;
      sessionRef.current = current;
      setSession(current);
    }
    const requestId = createRequestId();
    await client.call("run.start", { sessionId: current.id, requestId, prompt });
  };

  const leave = () => {
    exit(); // Ink resolves waitUntilExit and restores the terminal; never unmount from inside an input handler
    setTimeout(() => { onExit?.(); process.exit(0); }, 2_000).unref?.(); // watchdog: a stuck exit must not trap the terminal
  };

  const submit = (text) => {
    const prompt = text.trim();
    const command = parseModelCommand(prompt);
    if (command) {
      dispatchPrompt({ type: "clear" });
      setModelConfig(command); setStatus("connected");
      return;
    }
    const sessionCommand = parseSessionCommand(prompt);
    if (sessionCommand) {
      dispatchPrompt({ type: "clear" });
      if (sessionCommand.error) setStatus(sessionCommand.error);
      else { setSessionMenu(sessionCommand); setStatus("connected"); }
      return;
    }
    if (loadingSession) { setStatus("Loading session…"); return; }
    if (!prompt && welcomeOpen) { if (projection.messages.size || lastRun()) setWelcomeOpen(false); return; }
    if (!prompt) { const run = lastRun(); if (run?.state === "paused" && run.pauseReason !== "permission") client.call("run.resume", { runId: run.id }).catch((error) => setStatus(error.message)); return; }
    setWelcomeOpen(false);
    dispatchPrompt({ type: "submit", prompt });
    setStatus("connected");
    if (activeRun()) setStatus("queued behind the active run");
    send(prompt).catch((error) => setStatus(error.message));
  };

  useInput((chunk, key) => {
    if (key.eventType === "release") return;
    if (key.ctrl && chunk === "c") {
      const run = activeRun();
      if (run && ctrlC.current === 0) { ctrlC.current = 1; setStatus("cancelling…"); client.call("run.cancel", { runId: run.id }).catch(() => {}); setTimeout(() => { ctrlC.current = 0; }, 3000); return; }
      leave();
      return;
    }
    if (key.pageUp || key.pageDown || key.home || key.end) return;
    // A late keyboard capability reply is terminal metadata, never draft text.
    if (/^\[\?\d+u$/.test(chunk)) return;
    if (permission) {
      const decision = { 1: "deny", 2: "allow_once", 3: "allow_run", 4: "allow_project" }[chunk];
      if (decision) client.call("permission.resolve", { permissionId: permission.permissionId, decision }).then(() => setPermission(null)).catch((error) => setStatus(error.message));
      return;
    }
    if (key.upArrow || key.downArrow) { dispatchPrompt({ type: key.upArrow ? "previous" : "next" }); return; }
    if (key.escape) { const run = activeRun(); if (run) { setStatus("cancelling…"); client.call("run.cancel", { runId: run.id }).catch(() => {}); } return; }
    if (key.return) { submit(input); return; }
    if (chunk && /[\r\n]/.test(chunk)) { // pasted or bulk input: text before the first newline is submitted
      const [head] = chunk.split(/[\r\n]/);
      submit(input + head);
      return;
    }
    if (key.tab || chunk === "\t") { setShowTools((v) => !v); return; }
    dispatchPrompt({ type: "edit", chunk, key });
  }, { isActive: (modelConfig === null && sessionMenu === null) || Boolean(permission) });

  const width = Math.max(8, columns - 2);
  const run = activeRun() ?? lastRun();
  const { batch, live } = useNativeTranscript({ projection, revision, opened: !welcomeOpen, width, showTools, permission });
  const previewRows = Math.min(4, Math.max(0, rows - 8 - layout.changesRows));
  const visible = previewRows > 0 ? live.slice(-previewRows) : [];
  const modelSelected = async (message, target) => {
    const wanted = (target?.id === "jolo" || target?.preset) ? null : target?.id;
    if (target && wanted !== agentId) {
      const current = sessionRef.current;
      if (current) {
        const page = await client.call("session.page", { sessionId: current.id, limit: 1 });
        const { session: updated } = await client.call("session.setAgent", { sessionId: current.id, agentId: wanted, expectedRevision: page.session.revision });
        sessionRef.current = updated;
        setSession(updated);
      } else setDraftAgent(wanted);
      onChooseAgent(wanted);
    }
    if (target && wanted === null && sessionRef.current) {
      const current = (await client.call('session.page', { sessionId: sessionRef.current.id, limit: 1 })).session;
      const { session: updated } = await client.call('session.setModel', { sessionId: current.id, expectedRevision: current.revision, model: target.modelRef ?? null });
      sessionRef.current = updated; setSession(updated);
    }
    setModelConfig(null);
    if (message) setStatus(message);
    void refreshSettings();
  };

  return (
    <>
      <NativeTranscript batch={batch} project={project.rootPath} columns={columns} restored={restored} sessionTitle={initialSession?.title} />
      {sessionMenu ? <SessionMenu client={client} project={project} currentId={session?.id} command={sessionMenu} rows={rows} columns={columns} paused={Boolean(permission)} onRestore={onRestore} onDelete={() => onRestore(null)} onClose={() => setSessionMenu(null)} /> : modelConfig ? <ModelConfig client={client} initialTarget={modelConfig.target} currentAgentId={agentId} rows={rows} columns={columns} paused={Boolean(permission)} onClose={modelSelected} /> : layout.tooSmall ? <Text wrap="truncate-end">Enlarge terminal · Ctrl+C exits</Text> : <Box flexDirection="column" width="100%">
      {previewRows > 0 && <Box flexDirection="column"><TranscriptLines lines={visible} /></Box>}
      {layout.changesRows > 0 && <Text dimColor wrap="truncate-end">changes: {[...new Set(changes.map((c) => c.newPath ?? c.path))].join(", ").slice(0, width)}</Text>}
      <Box width={Math.min(columns, 48)} height={1}><Progress compact run={run} tools={run ? projection.toolsFor(run.id) : []} message={run ? projection.messagesFor(run.id).at(-1) : null} /></Box>
      <Prompt value={input} model={currentModelLabel(settings, { ...session, agentId })} columns={columns} />
      {status !== "connected" && !status.startsWith("verification:") && <Text dimColor wrap="truncate-end">{clean(status)}</Text>}
      {welcomeOpen && promptState.history.length > 0 && <Text dimColor wrap="truncate-end">Enter view chat · ↑/↓ prompts</Text>}
      </Box>}
    </>
  );
}

function SessionWorkspace({ session, restored, project, ...props }) {
  const [selected, setSelected] = useState({ session, revision: 0, restored, agentId: session?.agentId ?? null, workspaceId: session?.workspaceId ?? project.workspaceId });
  return <App key={selected.revision} {...props} project={{ ...project, workspaceId: selected.workspaceId }} initialSession={selected.session} draftAgentId={selected.agentId} initialStatus={selected.status} restored={selected.restored}
    onRestore={(session) => setSelected((previous) => ({ session, revision: previous.revision + 1, restored: true, agentId: session ? session.agentId ?? null : previous.agentId, workspaceId: session?.workspaceId ?? previous.workspaceId }))}
    onChooseAgent={(agentId) => setSelected((previous) => ({ ...previous, agentId }))} />;
}

export async function startTui({ client, project, session, cursor, restored = false }) {
  let terminalRestored = false;
  let instance = null;
  const wasRaw = Boolean(process.stdin.isRaw);
  const restore = () => {
    if (terminalRestored) return;
    terminalRestored = true;
    try { instance?.unmount(); } catch { /* ignore */ }
    try { if (process.stdin.isTTY && Boolean(process.stdin.isRaw) !== wasRaw) process.stdin.setRawMode(wasRaw); } catch { /* terminal may have closed */ }
    // Run after Ink's final paint and keyboard cleanup. Clear the visible screen,
    // reset the prompt's colors, and leave the cursor ready for the shell.
    if (process.stdout.isTTY && !process.stdout.destroyed) {
      try { process.stdout.write("\x1b[?2026l\x1b[0m\x1b[?25h\x1b[2J\x1b[H"); } catch { /* terminal may have closed */ }
    }
  };
  const onFatal = (error) => { restore(); process.stderr.write(`\n${error?.stack ?? error}\n`); process.exit(1); };
  const onTerminate = () => { restore(); process.exit(143); };
  const onInterrupt = () => { restore(); process.exit(130); };
  process.on("SIGTERM", onTerminate);
  process.on("SIGINT", onInterrupt);
  process.on("uncaughtException", onFatal);
  process.on("unhandledRejection", onFatal);
  try {
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    const kitty = await supportsKittyKeyboard();
    instance = render(<SessionWorkspace client={client} project={project} session={session} restored={restored} cursor={cursor} onExit={restore} />, { exitOnCtrlC: false, alternateScreen: false, nativeScrollback: true, maxFps: 60, incrementalRendering: true, kittyKeyboard: { mode: kitty ? "enabled" : "disabled" } });
    await instance.waitUntilExit();
  } finally {
    restore();
    process.off("SIGTERM", onTerminate);
    process.off("SIGINT", onInterrupt);
    process.off("uncaughtException", onFatal);
    process.off("unhandledRejection", onFatal);
  }
  return 0;
}
