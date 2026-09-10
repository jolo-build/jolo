// Board wording shared by the desktop renderer and `jolo board`: labels, markers, times. Pure functions.
import { RUNNING } from "./run-state.js";
export { RUNNING };
export const clip = (text, max) => { const t = String(text ?? "").replace(/\s+/g, " ").trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };
export const pad = (text, width) => { const t = String(text ?? ""); return t.length >= width ? t : t + " ".repeat(width - t.length); };

export function stateLabel(row) {
  const run = row.run;
  if (!run) return "idle";
  switch (run.state) {
    case "awaiting_permission": return "needs approval";
    case "paused": return run.pauseReason === "permission" ? "needs approval" : run.pauseReason === "user" ? "declined · paused" : run.pauseReason === "budget" ? "paused · budget" : "paused";
    case "failed": return "failed";
    case "interrupted": return "interrupted";
    case "completed": return "done";
    case "cancelled": return "stopped";
    case "queued": return "queued";
    case "preparing": return "starting";
    case "model": return "thinking";
    case "tools": { const last = row.actions.at(-1); return last ? `running ${last.name}` : "running tools"; }
    case "cancelling": return "stopping";
    default: return run.state;
  }
}

export function marker(row) {
  if (row.attention === "needs_you") return row.reason === "failed" || row.reason === "interrupted" ? "✗" : "▲";
  if (row.attention === "done") return row.reason === "cancelled" ? "■" : "✓";
  if (row.attention === "running") return "●";
  return "○";
}

export function checksLabel(row) {
  const status = row.run?.verification?.status;
  if (!status || status === "not_run") return "not run";
  if (status === "passed") { const n = (row.run.verification.checks ?? []).filter((c) => c.exitCode === 0).length; return n > 1 ? `passed ${n}/${n}` : "passed"; }
  return status;
}

export function elapsedLabel(row, now = Date.now()) {
  const run = row.run;
  if (!run) return "—";
  const start = Date.parse(run.createdAt);
  const end = RUNNING.has(run.state) || run.state === "awaiting_permission" ? now : Date.parse(run.updatedAt);
  return formatDuration(Math.max(0, end - start));
}

export function formatDuration(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function relativeTime(iso, now = Date.now()) {
  if (!iso) return "—";
  const delta = now - Date.parse(iso);
  if (delta < 45_000) return "just now";
  const minutes = Math.round(delta / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(delta / 3_600_000);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(delta / 86_400_000);
  if (days === 1) return "yesterday";
  if (days < 14) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function branchLabel(row) {
  if (!row.git.branch) return "—";
  return row.git.dirty ? `${row.git.branch} +${row.git.dirty}` : row.git.branch;
}

/** Row label: the project name, plus `@branch` for a worktree row so parallel checkouts stay apart. */
export function rowLabel(row) {
  return row.workspace?.mode === "worktree" ? `${row.name}@${row.workspace.branch ?? "worktree"}` : row.name;
}

/** Match `name`, `name@branch`, a project id, a workspace id, or a root path; a bare name prefers the main checkout. */
export function findProject(rows, selector) {
  const wanted = String(selector);
  const [name, branch] = wanted.includes("@") ? wanted.split("@", 2) : [wanted, null];
  const byName = rows.filter((row) => row.name === name || row.rootPath === name || row.projectId === name || row.workspaceId === name);
  if (branch !== null) return byName.find((row) => row.workspace?.branch === branch || row.git.branch === branch) ?? null;
  if (byName.length) return byName.find((row) => row.workspace?.mode === "direct") ?? byName[0];
  const matches = rows.filter((row) => row.name.toLowerCase().startsWith(wanted.toLowerCase()));
  return matches.length === 1 ? matches[0] : null;
}

export function summaryLine(rows) {
  const count = (attention) => rows.filter((row) => row.attention === attention).length;
  const parts = [];
  const needs = count("needs_you");
  if (needs) parts.push(`${needs} need${needs === 1 ? "s" : ""} you`);
  const running = count("running");
  if (running) parts.push(`${running} running`);
  const done = count("done");
  if (done) parts.push(`${done} done since you last looked`);
  return parts.length ? parts.join(" · ") : rows.length ? "nothing needs you" : "no projects yet; open one with `jolo <dir>` or `jolo run`";
}
