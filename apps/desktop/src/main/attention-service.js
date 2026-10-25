// Attention signals owned by main: news of a task that needs the user or has finished, and a dock badge
// counting projects that need them. Everything is read from the engine's board; nothing here inspects
// transcripts or project files.
//
// There is one decision and it is made here: a window that is NOT focused gets an OS notification, and a
// window that IS gets the same words sent into the app, which shows them as a notice. The renderer decides
// only whether a notice is redundant, because it alone knows which task is on screen.
import { clip } from "@jolo/client/board";

const REFRESH_DEBOUNCE_MS = 250;
const BOARD_EVENTS = new Set(["run.state", "permission.requested", "permission.resolved", "dialog.requested", "dialog.resolved", "workspace.viewed", "session.updated", "session.deleted", "run.verification", "files.changed"]);

/**
 * What a notice says of a question Claude asks: its first question, the plan note, or the tool's name. An input too
 * long for its event arrives as `{ truncated: true, preview }`, which has no questions to read, so it names the tool.
 * @param {{ tool: string, input: any }} dialog
 */
const dialogBody = ({ tool, input }) => {
  if (tool === "ExitPlanMode") return "Plan ready for your review";
  const questions = input?.truncated !== true && Array.isArray(input?.questions) ? input.questions : [];
  return questions.find((item) => typeof item?.question === "string" && item.question)?.question ?? tool;
};

/**
 * The badge and the notifications come in as arguments rather than as imports, so that this file holds
 * the decisions and `attention.js` is the only place that reaches for Electron.
 * @param {{ bridge: { rawCall: (method: string, params: any) => Promise<any> }, window: import("electron").BrowserWindow, log: any, app: typeof import("electron").app, Notification: typeof import("electron").Notification, smoke?: boolean }} options
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

  // A question Claude asks is told as an approval is; each is known by its own id, `{ permissionId }` or `{ dialogId }`.
  const keyOf = (ref) => ref.dialogId ? `dialog:${ref.dialogId}` : `permission:${ref.permissionId}`;
  const dismissApproval = (ref) => {
    const key = keyOf(ref), entry = visibleApprovals.get(key);
    if (entry) { entry.closed = true; entry.notification?.close(); visibleApprovals.delete(key); }
    if (!window.isDestroyed()) window.webContents.send("jolo:notice", { dismiss: true, ...ref });
  };

  const show = ({ kind, row, title, body, tone, sessionId = null, permissionId = null, dialogId = null, runId = null }) => {
    if (disposed) return;
    const ref = kind !== "approval" ? null : dialogId ? { dialogId } : permissionId ? { permissionId } : null;
    const key = ref && keyOf(ref);
    if (key) {
      if (approvals.has(key)) return;
      approvals.add(key);
      if (approvals.size > 100) approvals.delete(approvals.values().next().value);
    }
    const entry = { notification: null, closed: false, runId, ref };
    if (key) {
      visibleApprovals.set(key, entry);
      if (visibleApprovals.size > 100) dismissApproval(visibleApprovals.values().next().value.ref);
    }
    const payload = { kind, projectId: row.projectId, rootPath: row.rootPath, sessionId: sessionId ?? row.session?.id ?? null, permissionId, ...(dialogId ? { dialogId } : {}) };
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
    const notification = new Notification({ title, body: body || undefined, silent: kind !== "approval" });
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

  /**
   * Whether the conversation's process still runs background work after its run answered: Claude carries on, and reports
   * it in a run of its own. An engine that cannot say (an older one, a failed read) is taken to have none.
   * @param {string} sessionId
   */
  const backgroundRunning = async (sessionId) => {
    try { return (await bridge.rawCall("session.activity", { sessionId }))?.activity?.state === "background"; } catch { return false; }
  };

  const announce = async (event, kind) => {
    const pending = { runId: event.runId, permissionId: event.payload.permissionId, dialogId: event.payload.dialogId ?? null, cancelled: false };
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
      if (kind === "approval" || kind === "dialog") {
        // Event replay and slow board reads can describe a request already answered.
        // Read current pending requests, including ones not selected as the board row.
        if (!event.sessionId) return;
        const page = await bridge.rawCall("session.page", { sessionId: event.sessionId, limit: 1 });
        if (kind === "dialog") {
          const dialog = page.pendingDialogs?.find(dialog => dialog.runId === event.runId && dialog.dialogId === pending.dialogId);
          if (!dialog || disposed || pending.cancelled) return;
          show({ kind: "approval", row, tone: "needs", title: `${row.name} needs your answer`, body: clip(dialogBody(dialog), 120), dialogId: dialog.dialogId, sessionId: event.sessionId, runId: event.runId });
          return;
        }
        const request = page.pendingPermissions?.find(request => request.runId === event.runId && (!pending.permissionId || request.permissionId === pending.permissionId));
        if (!request || disposed || pending.cancelled) return;
        show({ kind, row, tone: "needs", title: `${row.name} needs your approval`, body: clip(request.summary ?? "A command is waiting for you", 120), permissionId: request.permissionId, sessionId: event.sessionId, runId: event.runId });
        return;
      }
      const state = event.payload.state;
      // A run that answered while its process still works in the background has not finished the conversation's work.
      const carriesOn = state === "completed" && event.sessionId ? await backgroundRunning(event.sessionId) : false;
      if (disposed || pending.cancelled) return;
      const where = task ? `${row.name} · ${clip(task, 40)}` : row.name;
      const title = carriesOn ? `${where}: answered · background work running` : state === "completed" ? `${where}: done` : state === "failed" ? `${where}: task failed` : state === "interrupted" ? `${where}: interrupted` : `${where}: paused`;
      // The title already names the task; the body only adds what the title cannot say.
      const files = row.changedFiles, checks = row.run?.verification?.status;
      const body = state === "completed" ? [!task && clip(row.run?.prompt ?? "", 80), files && `${files} file${files === 1 ? "" : "s"} changed`, checks === "failed" ? "checks failed" : checks === "stale" ? "checks out of date" : null].filter(Boolean).join(" · ") : clip(row.summary ?? "", 120);
      const tone = carriesOn ? "muted" : state === "completed" ? "good" : state === "failed" ? "needs" : "muted";
      show({ kind, row, tone, title, body, sessionId: event.sessionId ?? null, permissionId: row.pendingPermission?.permissionId ?? null });
    } catch (error) {
      if (!disposed) log.warn("could not prepare task notification", { error: String(error?.message ?? error) });
    } finally { announcements.delete(pending); }
  };

  return {
    notified,
    refresh,
    dispose() { disposed = true; clearTimeout(timer); approvals.clear(); for (const entry of visibleApprovals.values()) dismissApproval(entry.ref); },
    get rows() { return rows; },
    onEvent(event) {
      if (!BOARD_EVENTS.has(event.type)) return;
      if (event.type === "permission.resolved") {
        const id = event.payload.permissionId;
        // A question of the same run is not answered by it: only its own dialog.resolved is.
        for (const pending of announcements) if (pending.permissionId === id || (!pending.permissionId && !pending.dialogId && pending.runId === event.runId)) pending.cancelled = true;
        dismissApproval({ permissionId: id });
      } else if (event.type === "dialog.resolved") {
        const id = event.payload.dialogId;
        for (const pending of announcements) if (pending.dialogId === id) pending.cancelled = true;
        dismissApproval({ dialogId: id });
      } else if (event.type === "run.state" && ["completed", "failed", "cancelled", "interrupted"].includes(event.payload.state)) {
        for (const pending of announcements) if (pending.runId === event.runId) pending.cancelled = true;
        for (const entry of visibleApprovals.values()) if (entry.runId === event.runId) dismissApproval(entry.ref);
      }
      schedule();
      if (event.type === "permission.requested") void announce(event, "approval");
      else if (event.type === "dialog.requested") void announce(event, "dialog");
      else if (event.type === "run.state" && event.payload.state === "paused" && event.payload.pauseReason === "permission") void announce(event, "approval");
      else if (event.type === "run.state" && event.payload.quiet) return; // it showed nothing: nothing to announce
      else if (event.type === "run.state" && ["completed", "failed", "paused", "interrupted"].includes(event.payload.state)) void announce(event, "run");
    },
  };
}
