// Work board: one row per workspace folder, with chats listed separately on expansion.
// Every number comes from durable records; nothing here runs a model or reads project files
// beyond one bounded `git status` per workspace, cached briefly.
import { capture } from "../processes/capture.js";
import path from "node:path";
import { TERMINAL_RUN_STATES, WORKING_RUN_STATES, BOARD_ATTENTION } from "@jolo/protocol";

const GIT_CACHE_MS = 5_000;
const GIT_TIMEOUT_MS = 2_000;
const ATTENTION_ORDER = Object.fromEntries(BOARD_ATTENTION.map((name, index) => [name, index]));
const RUNNING = new Set(WORKING_RUN_STATES);

const clip = (text, max) => { const t = String(text ?? "").replace(/\s+/g, " ").trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };

/** Live wording for a run that has not stopped yet; stopped runs carry their note instead. */
function liveSummary(run, actions, pending) {
  const last = actions.at(-1);
  switch (run.state) {
    case "awaiting_permission": return `Waiting for your approval: ${pending?.summary ?? "a command"}`;
    case "queued": return "Queued behind another task.";
    case "preparing": return "Starting up.";
    case "model": return last ? `Thinking after ${last.name}.` : "Thinking about the request.";
    case "tools": return last ? `Running ${last.name}: ${clip(last.preview.slice(last.name.length), 120)}` : "Running tools.";
    case "cancelling": return "Stopping.";
    default: return run.failure ? `${run.state}: ${run.failure}` : run.state;
  }
}

function liveNextStep(run, pending) {
  if (run.state === "awaiting_permission") return pending ? "Approve or deny the request. The task continues on its own after an approval." : "Open the task to answer its request.";
  return null;
}

function attentionFor(run, workspace) {
  if (!run) return { attention: "idle", reason: null };
  if (run.state === "awaiting_permission") return { attention: "needs_you", reason: "awaiting_permission" };
  if (run.state === "paused") return { attention: "needs_you", reason: `paused_${run.pauseReason ?? "user"}` };
  if (run.state === "failed" || run.state === "interrupted") return { attention: "needs_you", reason: run.state };
  if (RUNNING.has(run.state)) return { attention: "running", reason: run.state };
  const seen = workspace.lastViewedAt && workspace.lastViewedAt >= run.updatedAt;
  return { attention: seen ? "idle" : "done", reason: run.state };
}

/**
 * @param {{ storage: any, env: { git: string | null, path: string }, log: any }} deps
 */
export function createBoard({ storage, env, log }) {
  const gitCache = new Map(); // workspace path -> { at, value }
  storage.events.on("event", event => {
    const invalidate = event.type === "files.changed" || event.type === "workspace.removed" ||
      (event.type === "run.state" && (TERMINAL_RUN_STATES.includes(event.payload.state) || event.payload.state === "awaiting_permission"));
    if (!invalidate) return;
    const session = event.sessionId && storage.getSession(event.sessionId);
    const workspace = storage.getWorkspace(event.payload.workspaceId ?? session?.workspaceId);
    if (workspace) gitCache.delete(workspace.path);
  });

  const gitInfo = async (dir) => {
    const cached = gitCache.get(dir);
    if (cached && Date.now() - cached.at < GIT_CACHE_MS) return cached.value;
    let value = { branch: null, dirty: null };
    if (env.git) {
      try {
        const result = await capture([env.git, "status", "--porcelain=v2", "--branch", "--untracked-files=normal"], { cwd: dir, env: { PATH: env.path, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" }, timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
        if (result.exitCode === 0) {
          let branch = null;
          let dirty = 0;
          for (const line of result.stdout.toString("utf8").split("\n")) {
            if (line.startsWith("# branch.head ")) branch = line.slice(14).trim();
            else if (/^[12u?] /.test(line)) dirty += 1;
          }
          value = { branch: branch === "(detached)" ? "detached" : branch, dirty };
        }
      } catch (error) {
        log?.warn("git status for the board failed", { dir, error: String(error?.message ?? error) });
      }
    }
    gitCache.set(dir, { at: Date.now(), value });
    return value;
  };

  const buildRow = (project, workspace) => {
    const latest = storage.boardRunForWorkspace(workspace.id);
    const run = latest?.run ?? null;
    const session = run ? storage.getSession(run.sessionId) : project.preferences.standalone ? storage.listSessions({ projectId: project.id, limit: 1 })[0] : null;
    const pendingRecord = run && (run.state === "awaiting_permission" || run.state === "paused") ? storage.pendingPermissionForRun(run.id) : null;
    const pendingPermission = pendingRecord ? { permissionId: pendingRecord.id, tool: pendingRecord.tool, summary: pendingRecord.request.summary ?? pendingRecord.tool, ...(pendingRecord.request.argv ? { argv: pendingRecord.request.argv } : {}), ...(pendingRecord.request.script ? { script: pendingRecord.request.script } : {}), cwd: pendingRecord.request.cwd ?? ".", createdAt: pendingRecord.createdAt } : null;
    const actions = run ? storage.recentToolActivity(run.id, 3) : [];
    const { attention, reason } = attentionFor(run, workspace);
    const stopped = run && (TERMINAL_RUN_STATES.includes(run.state) || run.state === "paused");
    const note = stopped ? run.note : null;
    return {
      projectId: project.id,
      standalone: project.preferences.standalone === true,
      rootPath: project.rootPath,
      name: path.basename(project.rootPath) || project.rootPath,
      workspaceId: workspace.id,
      taskCount: storage.countSessionsForWorkspace(workspace.id, 'open'),
      working: storage.workspaceHasWorkingRuns(workspace.id),
      workspace: { id: workspace.id, mode: workspace.mode, branch: workspace.branch, path: workspace.path },
      lastViewedAt: workspace.lastViewedAt,
      attention,
      reason,
      summary: run ? (note?.summary ?? liveSummary(run, actions, pendingPermission)) : "No task yet.",
      nextStep: run ? (note?.nextStep ?? liveNextStep(run, pendingPermission)) : null,
      session: session ? { id: session.id, title: session.title } : null,
      run: run ? { id: run.id, sessionId: run.sessionId, state: run.state, revision: run.revision, pauseReason: run.pauseReason, failure: run.failure, prompt: run.prompt, createdAt: run.createdAt, updatedAt: run.updatedAt, verification: run.verification ?? null, usage: run.usage && Object.keys(run.usage).length ? run.usage : null, note: run.note ?? null } : null,
      pendingPermission,
      actions,
      changedFiles: run ? storage.changedPathsForRun(run.id).length : 0,
      git: gitCache.get(workspace.path)?.value ?? { branch: null, dirty: null },
      lastActivityAt: run ? (storage.lastEventAtForRun(run.id) ?? run.updatedAt) : null,
    };
  };

  return {
    async list() {
      const workspaces = storage.listProjects().filter(project => !project.preferences.standalone).flatMap(project => storage.listWorkspaces(project.id));
      // Two concurrent status calls, outside SQLite transactions.
      let index = 0;
      const worker = async () => { while (index < workspaces.length) await gitInfo(workspaces[index++].path); };
      await Promise.all([worker(), worker()]);
      // A folder remains available even before its first chat is created.
      const rows = storage.transaction(() => storage.listProjects().flatMap((project) => storage.listWorkspaces(project.id).map((workspace) => buildRow(project, workspace))));
      rows.sort((a, b) => ATTENTION_ORDER[a.attention] - ATTENTION_ORDER[b.attention] || (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? "") || a.name.localeCompare(b.name));
      return { projects: rows, generatedAt: new Date().toISOString() };
    },
    /**
     * Every open task across every project, for a task list that is not scoped to one project (§5.1). The
     * same attention rule the board rows use, so a task reads the same wherever it is shown.
     */
    tasks({ limit = 200, workspaceId, before, state = 'open', standalone } = {}) {
      const generatedAt = new Date().toISOString();
      const entries = storage.listSessionActivity({ limit: limit + 1, workspaceId, before, state, standalone });
      const rows = entries.slice(0, limit).map((entry) => {
        const { attention, reason } = attentionFor(entry.run, entry.workspace);
        const stopped = entry.run && (TERMINAL_RUN_STATES.includes(entry.run.state) || entry.run.state === "paused");
        return {
          sessionId: entry.session.id,
          standalone: entry.standalone,
          title: entry.session.title,
          agentId: entry.session.agentId,
          projectId: entry.session.projectId,
          projectName: path.basename(entry.projectRootPath) || entry.projectRootPath,
          rootPath: entry.projectRootPath,
          workspaceId: entry.workspace.id,
          branch: entry.workspace.branch,
          mode: entry.workspace.mode,
          attention,
          reason,
          summary: stopped ? entry.run.note?.summary ?? null : null,
          updatedAt: entry.run?.updatedAt ?? entry.session.updatedAt,
          run: entry.run ? { id: entry.run.id, state: entry.run.state, pauseReason: entry.run.pauseReason, createdAt: entry.run.createdAt, updatedAt: entry.run.updatedAt } : null,
        };
      });
      const last = rows.at(-1);
      return { tasks: rows, generatedAt, hasMore: entries.length > limit,
        nextCursor: entries.length > limit && last ? { updatedAt: last.updatedAt, sessionId: last.sessionId } : null };
    },
    viewed(workspaceId) {
      return storage.transaction(() => {
        const workspace = storage.getWorkspace(workspaceId);
        if (!workspace) return null;
        const lastViewedAt = storage.touchWorkspaceViewed(workspaceId);
        storage.appendEvent({ type: "workspace.viewed", payload: { projectId: workspace.projectId, workspaceId, lastViewedAt } });
        return { projectId: workspace.projectId, workspaceId, lastViewedAt };
      });
    },
  };
}
