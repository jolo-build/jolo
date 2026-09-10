// Inline browser host: trusted webview attachment, guest policy, white canvas.
// Agent control is attached by browser-agent.mjs; this host enforces guest policy.

const PARTITION_PATTERN = /^jolo-browser-[A-Za-z0-9_-]{1,64}$/;
const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

export function installBrowserHost(window, { log, onGuest, sessionForPartition }) {
  const guests = new Map(); // webContents id -> { guest, partition }
  const workspaceBySession = new Map();

  window.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    let url;
    try { url = new URL(params.src ?? "about:blank"); } catch { url = null; }
    const partitionOk = PARTITION_PATTERN.test(params.partition ?? "");
    const urlOk = url && (url.href === "about:blank" || ALLOWED_SCHEMES.has(url.protocol));
    if (!partitionOk || !urlOk) {
      log.warn("rejected webview attachment", { partition: params.partition, src: String(params.src).slice(0, 100) });
      event.preventDefault();
      return;
    }
    workspaceBySession.set(sessionForPartition(params.partition), params.partition.slice("jolo-browser-".length));
    delete webPreferences.preload;
    delete webPreferences.preloadURL;
    Object.assign(webPreferences, {
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
      enableBlinkFeatures: "",
    });
  });

  window.webContents.on("did-attach-webview", (_event, guest) => {
    const id = guest.id;
    guests.set(id, { guest });
    guest.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    guest.session.setPermissionCheckHandler(() => false);
    guest.setWindowOpenHandler(() => ({ action: "deny" }));
    guest.session.on("will-download", (event) => event.preventDefault());
    guest.on("will-navigate", (event, url) => {
      let parsed;
      try { parsed = new URL(url); } catch { event.preventDefault(); return; }
      if (!ALLOWED_SCHEMES.has(parsed.protocol)) event.preventDefault();
    });
    guest.on("will-redirect", (event, url) => {
      let parsed;
      try { parsed = new URL(url); } catch { event.preventDefault(); return; }
      if (!ALLOWED_SCHEMES.has(parsed.protocol)) event.preventDefault();
    });
    // Pages without a background stay readable: explicit white default canvas (probe-verified path).
    try {
      guest.debugger.attach("1.3");
      guest.debugger.sendCommand("Emulation.setDefaultBackgroundColorOverride", { color: { r: 255, g: 255, b: 255, a: 1 } }).catch(() => {});
    } catch (error) {
      log.warn("could not set guest background", { error: String(error?.message ?? error) });
    }
    guest.on("destroyed", () => guests.delete(id));
    log.info("webview attached", { id });
    onGuest?.(guest, workspaceBySession.get(guest.session) ?? null);
  });

  return {
    get guests() { return guests; },
  };
}
