import { engineCommand as resolveEngineCommand } from "@jolo/launcher/executable";
// Electron main process: windows, narrow IPC, engine client, bounded relay,
// browser host. Owns no provider calls, workspace mutation, shell execution, or database.
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, protocol, session, shell } from "electron";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePaths, connectOrStart } from "@jolo/launcher";
import { connectResumable } from "@jolo/client";
import { parseParams } from "@jolo/protocol";
import { createRelay } from "./relay.js";
import { installBrowserHost } from "./browser-host.js";
import { createBrowserAgent } from "./browser-agent.js";
import { createBrowserOpener } from './browser-opener.js';
import { createAttention } from "./attention.js";
import { newestSourceTime } from "./staleness.js";
import { createEngineUpdates } from "./engine-updates.js";
import { createReleaseUpdates } from "./release-updates.js";
import { createVisualizationStore, VISUALIZATION_SCHEME } from './visualization-host.js';
import { installReloadShortcuts } from './reload-shortcuts.js';
import { HostDialogs } from './host-dialogs.js';

protocol.registerSchemesAsPrivileged([{ scheme: VISUALIZATION_SCHEME, privileges: { standard: true, secure: true } }]);

const here = path.dirname(fileURLToPath(import.meta.url));
// Packaged layout: main.js sits at the app root next to dist/, preload/, and engine/. Development: src/main/.
const PACKAGED_LAYOUT = existsSync(path.join(here, "dist", "index.html")) && existsSync(path.join(here, "engine"));
const ROOT = PACKAGED_LAYOUT ? here : path.resolve(here, "..", "..");
const ENGINE_ENTRY = PACKAGED_LAYOUT ? path.join(ROOT, "engine", "engine.js") : path.resolve(ROOT, "..", "engine", "src", "main.js");
const PRELOAD = PACKAGED_LAYOUT ? path.join(ROOT, "preload", "index.cjs") : path.join(ROOT, "src", "preload", "index.cjs");
const APP_ICON = path.join(ROOT, "dist", "jolo-app.png");
const BUILD = process.env.JOLO_BUILD ?? "dev";
// What a source-run engine loads: its own modules and the shared packages. Read only to compare timestamps.
const REPO_ROOT = PACKAGED_LAYOUT ? ROOT : path.resolve(ROOT, "..", "..");
const STALENESS_ROOTS = [path.join(REPO_ROOT, "apps", "engine", "src"), path.join(REPO_ROOT, "packages"), path.join(REPO_ROOT, "apps", "engine", "migrations")];
const SMOKE = process.env.NODE_ENV !== "production" && process.env.JOLO_DESKTOP_SMOKE === "1";
// Smoke checks live outside the main process source and are loaded through a computed URL, so the
// bundler never pulls them into a release build. They exist only in a source checkout.
const SMOKE_DIR = new URL("../../smoke/", import.meta.url);

const log = {
  info: (message, fields) => process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), level: "info", message, ...fields })}\n`),
  warn: (message, fields) => process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), level: "warn", message, ...fields })}\n`),
  error: (message, fields) => process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), level: "error", message, ...fields })}\n`),
};

/** Methods the renderer may invoke through the bridge; everything else fails closed. */
const RENDERER_METHODS = new Set([
  "engine.status", "project.open", "chat.create", "session.create", "session.list", "session.page",
  "session.rename", "session.archive", "session.delete", "session.setAgent", "session.setModel",
  "run.start", "run.cancel", "run.sendNow", "run.snapshot", "artifact.read", "attachment.create", "attachment.write",
  "settings.get", "settings.update", "credential.set", "credential.status", "provider.presets", "provider.models",
  'account.status', 'account.login', 'account.cancel', 'account.logout',
  'task.list', 'task.get',
  "permission.resolve", "run.resume", "workspace.diff", "patch.revert", "board.list", "board.tasks", "board.viewed",
  "workspace.create", "workspace.list", "workspace.remove", "workspace.readFile", "workspace.changes",
  "agent.catalog", "agent.models", "agent.start", "agent.list", "agent.stop",
  "plan.create", "plan.list", "plan.get", "plan.start", "plan.pause", "plan.cancel",
  "plan.task.add", "plan.task.update", "plan.task.remove", "plan.task.retry", "plan.task.skip",
  "terminal.open", "terminal.attach", "terminal.input", "terminal.resize", "terminal.lease", "terminal.close", "terminal.list",
]);

class EngineBridge {
  constructor({ window }) {
    this.window = window;
    this.agent = null; // browser agent, attached after construction
    this.browserOpener = null;
    this.attention = null; // notifications and the dock badge, attached after construction
    this.hostDialogs = new HostDialogs();
    this.paths = resolvePaths({ home: process.env.JOLO_HOME, profile: process.env.JOLO_PROFILE });
    this.client = null;
    this.connecting = null;
    this.lastSeq = "0";
    this.relay = createRelay({ send: (batch) => { if (!this.window.isDestroyed()) this.window.webContents.send("jolo:events", batch); }, log });
  }

  async connect() {
    if (this.client && !this.client.closed) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const engineCommand = resolveEngineCommand({ engineDir: path.join(ROOT, "engine"), sourceEntry: ENGINE_ENTRY, extraArgs: ["--profile", this.paths.profile] });
      let started = false;
      const client = await connectResumable({
        open: async () => {
          const result = await connectOrStart({ paths: this.paths, engineCommand, clientKind: "desktop", build: BUILD, env: { JOLO_HOME: process.env.JOLO_HOME ?? "" } });
          started = result.started;
          return result.client;
        },
        onResync: () => { this.lastSeq = "0"; this.relay.reset(); this.relay.resync(); this.notify({ connected: true, resyncRequired: true }); },
      });
      this.client = client;
      client.onClose(() => {
        // The renderer and its credits survive a socket reconnect. Dropping its
        // pending batches here loses events already counted by the socket cursor,
        // so reconnect replay cannot recover them (often the final reply).
        this.agent?.onDisconnected();
        this.browserOpener?.onDisconnected();
        this.notify({ connected: false });
      });
      client.onReconnect(async () => {
        this.notify({ connected: true });
        void this.attention?.refresh();
        await this.agent?.onConnected();
        await this.browserOpener?.onConnected();
      });
      client.onNotification("terminal.output", (params) => this.relay.push("terminal", params));
      client.onNotification("terminal.state", (params) => this.relay.push("event", { engineBootId: "local", eventSeq: "0", sessionId: null, runId: null, type: "terminal.state", payload: params, at: new Date().toISOString() }));
      client.onNotification("browser.execute", (params) => void this.agent?.handleExecute(params));
      client.onNotification('browser.open', params => this.browserOpener?.handleOpen(params));
      client.onNotification("browser.cancel", (params) => { this.agent?.handleCancel(params); this.browserOpener?.handleCancel(params); });
      const status = await client.call("engine.status", {});
      const after = this.lastSeq === "0" ? status.cursor : this.lastSeq; // first attach: live only; reconnect: replay from the last seen cursor
      await client.subscribe({ after }, {
        onEvent: (event) => { this.lastSeq = event.eventSeq; this.relay.push("event", event); this.attention?.onEvent(event); },
        onPreview: (preview) => this.relay.push("preview", preview),
      });
      this.notify({ connected: true, started, status });
      void this.attention?.refresh();
      await this.agent?.onConnected();
      await this.browserOpener?.onConnected();
      return client;
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  notify(state) {
    if (!this.window.isDestroyed()) this.window.webContents.send("jolo:engine", state);
  }

  /** Host-only calls (browser registration and results); never reachable from the renderer. */
  async rawCall(method, params) {
    const client = await this.connect();
    return client.call(method, params);
  }

  async call(method, params) {
    if (!RENDERER_METHODS.has(method)) return { ok: false, error: { code: "permission_denied", message: `method ${method} is not exposed to the renderer` } };
    const checked = parseParams(method, params);
    if (!checked.ok) return { ok: false, error: { code: checked.error.code, message: checked.error.message } };
    try {
      const client = await this.connect();
      if (method === 'run.start' || method === 'run.resume') await this.browserOpener?.beforeRun();
      const result = await client.call(method, checked.value);
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error: { code: error?.code ?? "unavailable", message: String(error?.message ?? error) } };
    }
  }

  async close() {
    this.attention?.dispose();
    if (this.client) await this.client.close();
  }
}

function createWindow() {
  // Match the renderer's --bg so newly exposed window areas stay in theme during live resize.
  const backgroundColor = () => nativeTheme.shouldUseDarkColors ? "#191a1c" : "#fcfcfb";
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    backgroundColor: backgroundColor(),
    title: "Jolo",
    icon: APP_ICON,
    ...(process.platform === "darwin" ? {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 14, y: 17 },
    } : {}),
    webPreferences: {
      // Preloads can reload from disk while a source-run main process remains old.
      additionalArguments: ['--jolo-desktop-api=1'],
      preload: PRELOAD,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true, // trusted application renderer only (§5.2)
      // Screenshot checks still need animation frames when another app covers the test window.
      ...(SMOKE ? { backgroundThrottling: false } : {}),
    },
  });
  // Paint the HTML loading screen while the renderer and its initial data start up.
  window.once('ready-to-show', () => {
    if (!(SMOKE && (process.env.JOLO_LIVE_RESULTS_SMOKE === '1' || process.env.JOLO_LOADING_SMOKE === '1'))) window.show();
  });
  const updateBackground = () => {
    if (!window.isDestroyed()) window.setBackgroundColor(backgroundColor());
  };
  nativeTheme.on("updated", updateBackground);
  window.once("closed", () => nativeTheme.removeListener("updated", updateBackground));
  installReloadShortcuts(window.webContents);
  window.webContents.setWindowOpenHandler(({ url }) => {
    try { if (["http:", "https:"].includes(new URL(url).protocol)) shell.openExternal(url); } catch { /* ignore */ }
    return { action: "deny" };
  });
  window.webContents.on('will-navigate', (event, url) => {
    // The startup retry button may reload this exact application document.
    // All other renderer navigation stays blocked (§5.2).
    if (url !== window.webContents.getURL()) event.preventDefault();
  });
  return window;
}

function registerIpc(window, bridge, visualizations, releases) {
  // A closing renderer can still deliver IPC after the window is gone; never dereference a destroyed window.
  const trusted = (event) => !window.isDestroyed() && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame;
  ipcMain.handle('jolo:visualization:prepare', async (event, params) => {
    if (!trusted(event)) throw new Error('untrusted sender');
    try { return { ok: true, result: await visualizations.prepare(params ?? {}) }; }
    catch (error) { return { ok: false, error: String(error?.message ?? 'Couldn’t load this visualization.') }; }
  });
  ipcMain.on('jolo:visualization:release', (event, url) => { if (trusted(event)) visualizations.release(url); });
  ipcMain.on('jolo:browserWorkspaces', (event, params) => { if (trusted(event)) bridge.browserOpener?.setWorkspaces(params); });
  ipcMain.on('jolo:browserOpened', (event, params) => { if (trusted(event)) bridge.browserOpener?.acknowledge(params); });
  ipcMain.handle("jolo:taskMenu", (event, options) => {
    const opts = typeof options === "boolean" ? { archived: options } : options;
    if (!trusted(event) || !opts || typeof opts.archived !== "boolean") throw new Error("untrusted task menu request");
    return new Promise((resolve) => {
      let action = null;
      // An array literal widens "separator" to string, which Electron's item kinds do not accept, so the
      // template says what it is rather than every separator carrying its own annotation.
      Menu.buildFromTemplate(/** @type {import("electron").MenuItemConstructorOptions[]} */ ([
        { label: "Rename…", click: () => { action = "rename"; } },
        { label: opts.archived ? "Restore task" : "Archive task", click: () => { action = "archive"; } },
        ...(opts.worktree === true ? [{ type: "separator" }, { label: "Remove worktree…", click: () => { action = "remove-worktree"; } }] : []),
        { type: "separator" },
        { label: "Delete…", click: () => { action = "delete"; } },
      ])).popup({ window, callback: () => resolve(action) });
    });
  });
  // The composer's "who answers" picker: Jolo with its model, or a hosted agent that speaks a structured protocol.
  ipcMain.handle("jolo:answererMenu", (event, options) => {
    if (!trusted(event) || !options || !Array.isArray(options.items) || options.items.length > 16) throw new Error("untrusted answerer menu request");
    const items = options.items.filter((item) => item && typeof item.id === "string" && typeof item.label === "string");
    return new Promise((resolve) => {
      let choice = null;
      Menu.buildFromTemplate(/** @type {import("electron").MenuItemConstructorOptions[]} */ ([
        ...items.map((item) => ({ label: item.label.slice(0, 80), type: "radio", checked: Boolean(item.checked), enabled: item.enabled !== false, click: () => { choice = item.id; } })),
        { type: "separator" },
        { label: "Model settings…", click: () => { choice = "settings"; } },
      ])).popup({ window, callback: () => resolve(choice) });
    });
  });
  ipcMain.handle("jolo:call", (event, request) => {
    if (window.isDestroyed()) return { ok: false, error: { code: "unavailable", message: "window closed" } }; // a late call during shutdown is not an attack
    if (!trusted(event)) throw new Error("untrusted sender");
    if (!request || typeof request.method !== "string") return { ok: false, error: { code: "invalid_params", message: "method required" } };
    return bridge.call(request.method, request.params ?? {});
  });
  ipcMain.on("jolo:ack", (event, id) => { if (trusted(event)) bridge.relay.ack(id); });
  ipcMain.handle("jolo:dialog:openFolder", async (event) => {
    if (!trusted(event)) throw new Error("untrusted sender");
    const result = await dialog.showOpenDialog(window, { properties: ["openDirectory"] });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle("jolo:homeDirectory", (event) => {
    if (!trusted(event)) throw new Error("untrusted sender");
    return os.homedir();
  });
  ipcMain.handle("jolo:openExternal", (event, url) => {
    if (!trusted(event)) throw new Error("untrusted sender");
    try { if (["http:", "https:"].includes(new URL(url).protocol)) return shell.openExternal(url); } catch { /* ignore */ }
    return false;
  });
  ipcMain.on("jolo:overlay", (event, active) => { if (trusted(event)) bridge.hostDialogs.set(active); });
  ipcMain.handle("jolo:resync", (event) => {
    if (!trusted(event)) throw new Error("untrusted sender");
    bridge.relay.reset();
    return { cursor: bridge.lastSeq };
  });
  // Reports what is published; downloading stays the user's own action through openExternal.
  ipcMain.handle("jolo:update:check", async (event, options) => {
    if (!trusted(event)) throw new Error("untrusted sender");
    if (!releases) return { current: app.getVersion(), managed: false };
    return { ...await releases.check({ force: options?.force === true }), managed: true };
  });
}


if (SMOKE && process.env.JOLO_HOME) app.setPath("userData", path.join(process.env.JOLO_HOME, "electron-userdata")); // never share local storage with normal launches

app.setName("Jolo"); // what the system calls this application, including in its notification settings
app.whenReady().then(async () => {
  const window = createWindow();
  const lightIcon = nativeImage.createFromPath(APP_ICON);
  const darkIcon = nativeImage.createFromPath(path.join(ROOT, "dist", "jolo-app-dark.png"));
  const updateIcon = () => {
    if (window.isDestroyed()) return;
    const icon = nativeTheme.shouldUseDarkColors ? darkIcon : lightIcon;
    if (process.platform === "darwin") app.dock.setIcon(icon);
    else window.setIcon(icon);
  };
  updateIcon();
  nativeTheme.on("updated", updateIcon);
  window.once("closed", () => nativeTheme.removeListener("updated", updateIcon));
  const bridge = new EngineBridge({ window });
  const visualizations = createVisualizationStore((method, params) => bridge.rawCall(method, params));
  protocol.handle(VISUALIZATION_SCHEME, request => visualizations.response(request));
  // A preview can interact inside its own sandbox, but cannot navigate another surface.
  window.webContents.on('will-frame-navigate', event => {
    if (event.isMainFrame) {
      if (event.initiator && event.initiator !== window.webContents.mainFrame) event.preventDefault();
    } else if (!visualizations.has(event.url) || event.frame?.parent !== window.webContents.mainFrame || event.initiator && event.initiator !== window.webContents.mainFrame) event.preventDefault();
  });
  window.webContents.on('did-start-navigation', event => { if (event.isMainFrame && !event.isSameDocument) visualizations.clear(); });
  window.once('closed', () => { visualizations.clear(); protocol.unhandle(VISUALIZATION_SCHEME); });
  // Released builds watch for a newer one; a source run has nothing published to compare against.
  const releases = PACKAGED_LAYOUT && !SMOKE ? createReleaseUpdates({
    currentVersion: app.getVersion(),
    cacheFile: path.join(app.getPath("userData"), "updates.json"),
    baseUrl: process.env.JOLO_UPDATE_BASE_URL || undefined,
    log,
    notice: ({ latest }) => {
      if (!window.isDestroyed()) window.webContents.send("jolo:notice", { kind: "update", tone: "muted", title: `Jolo ${latest} is available`, body: "Open Settings to download it.", at: Date.now() });
    },
  }) : null;
  releases?.start();
  window.once("closed", () => releases?.stop());
  registerIpc(window, bridge, visualizations, releases);
  const isOverlayActive = () => bridge.hostDialogs.active;
  const waitForOverlay = signal => bridge.hostDialogs.wait(signal);
  const agent = createBrowserAgent({ bridge, log, nativeImage, isOverlayActive, waitForOverlay });
  bridge.agent = agent;
  bridge.browserOpener = createBrowserOpener({ bridge, agent, log, isOverlayActive, waitForOverlay,
    send: (channel, params) => { if (!window.isDestroyed()) window.webContents.send(channel, params); },
  });
  bridge.attention = createAttention({ bridge, window, log, smoke: SMOKE });
  if (!PACKAGED_LAYOUT && !SMOKE) {
    const updates = createEngineUpdates({ roots: STALENESS_ROOTS, newestSourceTime, client: () => bridge.client, log,
      notice: body => { if (!window.isDestroyed()) window.webContents.send("jolo:notice", { kind: "engine", tone: "needs", title: "Engine update available", body, at: Date.now() }); },
    });
    const timer = setInterval(() => void updates.check(), 5000);
    timer.unref();
    window.once("closed", () => { clearInterval(timer); updates.stop(); });
  }
  const browserHost = installBrowserHost(window, { log, sessionForPartition: partition => session.fromPartition(partition), onGuest: (guest, workspaceId) => { if (workspaceId) agent.attach(guest, workspaceId); } });
  const loadingSmoke = SMOKE && process.env.JOLO_LOADING_SMOKE === '1'
    ? (await import(new URL('loading-smoke.js', SMOKE_DIR).href)).prepareLoadingSmoke({ window, bridge, root: ROOT }) : null;
  await window.loadFile(path.join(ROOT, "dist", "index.html"));
  if (SMOKE && process.env.JOLO_LIVE_RESULTS_SMOKE !== "1" && process.env.JOLO_LOADING_SMOKE !== "1") { window.moveTop(); window.focus(); app.focus({ steal: true }); }
  bridge.connect().catch((error) => { log.error("engine attach failed", { error: String(error?.message ?? error) }); bridge.notify({ connected: false, error: String(error?.message ?? error) }); });
  if (SMOKE) {
    try {
      if (loadingSmoke) await loadingSmoke();
      else {
        const { runSmoke } = await import(new URL("smoke.js", SMOKE_DIR).href);
        await runSmoke(window, bridge, browserHost, { ROOT, BUILD, log });
      }
      await bridge.close();
      app.exit(0);
    } catch (error) {
      log.error("smoke failed", { error: String(error?.stack ?? error) });
      await bridge.close().catch(() => {});
      app.exit(1);
    }
  }
  app.on("window-all-closed", async () => { await bridge.close().catch(() => {}); app.quit(); }); // the engine keeps running (§14.2)
});
