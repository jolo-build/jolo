// Attention signals owned by main: news of a task that needs the user or has finished, and a dock badge
// counting projects that need them. Everything is read from the engine's board; nothing here inspects
// transcripts or project files.
//
// There is one decision and it is made here: a window that is NOT focused gets an OS notification, and a
// window that IS gets the same words sent into the app, which shows them as a notice. The renderer decides
// only whether a notice is redundant, because it alone knows which task is on screen.
import { checksLabel, clip } from "@jolo/client/board";

const REFRESH_DEBOUNCE_MS = 250;
const BOARD_EVENTS = new Set(["run.state", "permission.requested", "permission.resolved", "workspace.viewed", "session.updated", "session.deleted", "run.verification", "files.changed"]);

/**
 * @param {{ bridge: { rawCall: (method: string, params: any) => Promise<any> }, window: import("electron").BrowserWindow, log: any, smoke?: boolean }} options
 */
export function createAttentionService({ bridge, window, log, app, Notification, smoke = false }) {
  let timer = null, disposed = false;
  const approvals = new Set();
  const announcements = new Set();
  const visibleApprovals = new Map();
  let refused = false; // the system has told us once that it will not show these
  let rows = [];
  let badge = null;
  const notified = []; // smoke mode records what would have been shown

  const setBadge = (count) => {
    if (count === badge) return;
    badge = count;
    try {
      if (process.platform === "darwin") app.dock?.setBadge(count ? String(count) : "");
      else app.setBadgeCount(count);
    } catch (error) {
      log.warn("badge update failed", { error: String(error?.message ?? error) });
    }
  };

  const refresh = async () => {
    try {
      const board = await bridge.rawCall("board.list", {});
      rows = board.projects;
      setBadge(rows.filter((row) => row.attention === "needs_you").length);
    } catch (error) {
      log.warn("board refresh failed", { error: String(error?.message ?? error) });
    }
    return rows;
  };

  const schedule = () => {
    if (disposed || timer) return;
    timer = setTimeout(() => { timer = null; void refresh(); }, REFRESH_DEBOUNCE_MS);
  };

  const userIsLooking = () => !window.isDestroyed() && window.isFocused();

  const dismissApproval = (permissionId) => {
    const entry = visibleApprovals.get(permissionId);
    if (entry) { entry.closed = true; entry.notification?.close(); visibleApprovals.delete(permissionId); }
    if (!window.isDestroyed()) window.webContents.send("jolo:notice", { dismiss: true, permissionId });
  };

  const show = ({ kind, row, title, body, tone, sessionId = null, permissionId = null, runId = null }) => {
    if (disposed) return;
    if (kind === "approval" && permissionId) {
      if (approvals.has(permissionId)) return;
      approvals.add(permissionId);
      if (approvals.size > 100) approvals.delete(approvals.values().next().value);
    }
    const entry = { notification: null, closed: false, runId };
    if (kind === "approval" && permissionId) {
      visibleApprovals.set(permissionId, entry);
      if (visibleApprovals.size > 100) dismissApproval(visibleApprovals.keys().next().value);
    }
    const payload = { kind, projectId: row.projectId, rootPath: row.rootPath, sessionId: sessionId ?? row.session?.id ?? null, permissionId };
    const inApp = userIsLooking();
    if (smoke) notified.push({ ...payload, title, body, via: inApp ? "app" : "os" });
    if (inApp) {
      // The user is here: the app says it, rather than the system saying it over the app.
      if (!window.isDestroyed()) window.webContents.send("jolo:notice", { ...payload, title, body, tone, at: Date.now() });
      return;
    }
    if (smoke) return;
    const toApp = () => { if (!disposed && !entry.closed && !window.isDestroyed()) window.webContents.send("jolo:notice", { ...payload, title, body, tone, at: Date.now() }); };
    if (!Notification.isSupported()) { toApp(); return; }
    // Only an unanswered approval may make a sound. Routine task updates stay quiet.
    const notification = new Notification({ title, body, silent: kind !== "approval" });
    entry.notification = notification;
    notification.on("click", () => {
      if (entry.closed || window.isDestroyed()) return;
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      window.webContents.send("jolo:focus", payload);
    });
    // The system can refuse outright — on macOS, notifications not allowed for this application. Saying so
    // once beats a signal that silently goes nowhere, and the news still reaches the app itself.
    notification.on("failed", (_event, error) => {
      if (disposed || entry.closed) return;
      if (!refused) { refused = true; log.warn("the system refused a notification; allow notifications for this app to receive them", { error: String(error), app: app.getName() }); }
      toApp();
    });
    notification.show();
  };

  const announce = async (event, kind) => {
    const pending = { runId: event.runId, permissionId: event.payload.permissionId, cancelled: false };
    announcements.add(pending);
    try {
      const list = await refresh();
      if (disposed || pending.cancelled) return;
      let row = list.find((r) => r.run?.id === event.runId) ?? list.find((r) => r.session?.id === event.sessionId);
      let task = row?.session?.title ?? null;
      if (!row && event.sessionId) {
        // A board row speaks for one task per checkout, so a task finishing beside it matches nothing above.
        // Ask which checkout this one belongs to, and borrow that row for the project's name and its counts.
        try {
          const page = await bridge.rawCall("session.page", { sessionId: event.sessionId, limit: 1 });
          row = list.find((r) => r.workspaceId === page.session.workspaceId) ?? list.find((r) => r.projectId === page.session.projectId);
          task = page.session.title;
        } catch (error) {
          log.warn("could not place a finished task", { error: String(error?.message ?? error) });
        }
      }
      if (!row) return;
      if (kind === "approval") {
        // Event replay and slow board reads can describe a request already answered.
        // Read current pending requests, including ones not selected as the board row.
        if (!event.sessionId) return;
        const page = await bridge.rawCall("session.page", { sessionId: event.sessionId, limit: 1 });
        const request = page.pendingPermissions?.find(request => request.runId === event.runId && (!pending.permissionId || request.permissionId === pending.permissionId));
        if (!request || disposed || pending.cancelled) return;
        show({ kind, row, tone: "needs", title: `${row.name} needs your approval`, body: clip(request.summary ?? "A command is waiting for you", 120), permissionId: request.permissionId, sessionId: event.sessionId, runId: event.runId });
        return;
      }
      const state = event.payload.state;
      const where = task ? `${row.name} · ${clip(task, 40)}` : row.name;
      const title = state === "completed" ? `${where}: done` : state === "failed" ? `${where}: task failed` : state === "interrupted" ? `${where}: interrupted` : `${where}: paused`;
      const files = row.changedFiles ? ` · ${row.changedFiles} file${row.changedFiles === 1 ? "" : "s"}` : "";
      const body = state === "completed" ? `${clip(task ?? row.run?.prompt ?? "", 80)} · checks ${checksLabel(row)}${files}` : clip(task ? `${task}: ${row.summary}` : row.summary, 120);
      const tone = state === "completed" ? "good" : state === "failed" ? "needs" : "muted";
      show({ kind, row, tone, title, body, sessionId: event.sessionId ?? null, permissionId: row.pendingPermission?.permissionId ?? null });
    } catch (error) {
      if (!disposed) log.warn("could not prepare task notification", { error: String(error?.message ?? error) });
    } finally { announcements.delete(pending); }
  };

  return {
    notified,
    refresh,
    dispose() { disposed = true; clearTimeout(timer); approvals.clear(); for (const id of visibleApprovals.keys()) dismissApproval(id); },
    get rows() { return rows; },
    onEvent(event) {
      if (!BOARD_EVENTS.has(event.type)) return;
      if (event.type === "permission.resolved") {
        const id = event.payload.permissionId;
        for (const pending of announcements) if (pending.permissionId === id || (!pending.permissionId && pending.runId === event.runId)) pending.cancelled = true;
        dismissApproval(id);
      } else if (event.type === "run.state" && ["completed", "failed", "cancelled", "interrupted"].includes(event.payload.state)) {
        for (const pending of announcements) if (pending.runId === event.runId) pending.cancelled = true;
        for (const [id, entry] of visibleApprovals) if (entry.runId === event.runId) dismissApproval(id);
      }
      schedule();
      if (event.type === "permission.requested") void announce(event, "approval");
      else if (event.type === "run.state" && event.payload.state === "paused" && event.payload.pauseReason === "permission") void announce(event, "approval");
      else if (event.type === "run.state" && ["completed", "failed", "paused", "interrupted"].includes(event.payload.state)) void announce(event, "run");
    },
  };
}
