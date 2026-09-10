// Plain-text rendering of the work board for `jolo board`; wording comes from @jolo/client/board.
import path from "node:path";
import { RUNNING, branchLabel, checksLabel, elapsedLabel, marker, relativeTime, rowLabel, stateLabel, summaryLine, clip, pad, findProject as findByName } from "@jolo/client/board";

/** Match a project by name, id, or path (relative paths resolve against the current directory). */
export const findProject = (rows, selector) => findByName(rows, selector) ?? findByName(rows, path.resolve(String(selector)));

/** @param {any[]} rows @param {{ now?: number }} [options] */
export function renderBoardTable(rows, { now = Date.now() } = {}) {
  const columns = [
    { title: "PROJECT", max: 32, value: (row) => `${marker(row)} ${rowLabel(row)}` },
    { title: "STATE", max: 22, value: (row) => stateLabel(row) },
    { title: "TASK", max: 44, value: (row) => row.run ? row.run.prompt : "—" },
    { title: "ELAPSED", max: 8, value: (row) => elapsedLabel(row, now) },
    { title: "CHECKS", max: 11, value: (row) => checksLabel(row) },
    { title: "FILES", max: 5, value: (row) => String(row.changedFiles) },
    { title: "BRANCH", max: 24, value: (row) => branchLabel(row) },
    { title: "LAST", max: 12, value: (row) => relativeTime(row.lastActivityAt, now) },
  ];
  const cells = rows.map((row) => columns.map((column) => clip(column.value(row), column.max)));
  const widths = columns.map((column, i) => Math.max(column.title.length, ...cells.map((line) => line[i].length)));
  const lines = [columns.map((column, i) => pad(column.title, widths[i])).join("  ").trimEnd()];
  for (const line of cells) lines.push(line.map((cell, i) => pad(cell, widths[i])).join("  ").trimEnd());
  lines.push("", summaryLine(rows));
  return lines.join("\n");
}

const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function renderBoardDetail(row, { now = Date.now() } = {}) {
  const label = (name, text) => `${pad(name, 20)}${text}`;
  const head = [rowLabel(row), row.workspace?.mode === "worktree" ? `worktree at ${row.workspace.path}` : row.git.branch ?? "no git", ...(row.git.dirty ? [`${row.git.dirty} uncommitted`] : []), ...(row.session ? [`task "${row.session.title || "untitled"}"`] : []), ...(row.run ? [`run ${row.run.id}`] : [])].join(" · ");
  const lines = [head];
  if (!row.run) { lines.push(label("state", "idle; no task has run here yet"), "", `  jolo run "<task>" --path ${row.rootPath}`); return lines.join("\n"); }
  lines.push(label("state", `${stateLabel(row)} (${elapsedLabel(row, now)}, last activity ${relativeTime(row.lastActivityAt, now)})`));
  lines.push(label("task", clip(row.run.prompt, 200)));
  lines.push(label("where you left off", row.summary));
  if (row.actions.length) {
    row.actions.forEach((action, index) => {
      const preview = clip(action.preview.startsWith(action.name) ? action.preview.slice(action.name.length) : action.preview, 90);
      lines.push(label(index === 0 ? "last actions" : "", `${time(action.at)} ${pad(action.name, 14)} ${preview}${action.status === "running" ? "  (running)" : action.status !== "ok" ? `  (${action.status})` : ""}`));
    });
  }
  lines.push(label("changed files", String(row.changedFiles)));
  lines.push(label("checks", checksLabel(row)));
  if (row.pendingPermission) lines.push(label("pending question", `run ${row.pendingPermission.argv ? row.pendingPermission.argv.join(" ") : row.pendingPermission.script ?? row.pendingPermission.summary} in ${row.pendingPermission.cwd}?`));
  if (row.nextStep) lines.push(label("next", row.nextStep));
  const hints = [];
  if (row.pendingPermission) hints.push(`jolo permission allow ${row.pendingPermission.permissionId}`, `jolo permission deny ${row.pendingPermission.permissionId}`);
  if (row.run.state === "paused" && row.run.pauseReason !== "permission") hints.push(`jolo resume ${row.run.id}`);
  if (row.run.state === "interrupted") hints.push(`jolo resume ${row.run.id}`);
  if (RUNNING.has(row.run.state) || row.run.state === "awaiting_permission") hints.push(`jolo attach ${row.run.id}`);
  if (row.attention === "done") hints.push(`jolo board ${rowLabel(row)} --seen`);
  if (hints.length) lines.push("", `  ${hints.join("    ")}`);
  return lines.join("\n");
}
