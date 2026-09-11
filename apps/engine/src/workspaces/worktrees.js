// Git worktree workspaces: a named branch checked out from a recorded commit into an
// application-owned directory. Worktrees separate working files, not security; grants stay per workspace.
import { existsSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { capture } from "../processes/capture.js";
import { ProtocolError } from "@jolo/protocol";

const GIT_TIMEOUT_MS = 30_000;
const BRANCH_MAX = 120;

const slug = (text) => String(text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
const stamp = () => { const d = new Date(); const p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; };

/**
 * @param {{ storage: any, permissions: any, paths: { dataDir: string }, env: { git: string | null, path: string }, terminals?: any, log: any }} deps
 */
export function createWorktreeService({ storage, permissions, paths, env, terminals, log }) {
  const busy = new Set();
  const git = async (cwd, args) => {
    if (!env.git) throw new ProtocolError("unavailable", "git is not available in the engine's environment profile");
    const result = await capture([env.git, ...args], { cwd, env: { PATH: env.path, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" }, timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
    return { ok: result.exitCode === 0, exitCode: result.exitCode, stdout: result.stdout.toString("utf8").trim(), stderr: result.stderr.toString("utf8").trim() };
  };

  const repoRoot = async (project) => {
    const top = await git(project.rootPath, ["rev-parse", "--show-toplevel"]);
    if (!top.ok) throw new ProtocolError("unavailable", "worktrees need a Git repository; this project is not one");
    return realpathSync(top.stdout);
  };

  const branchExists = async (root, name) => (await git(root, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`])).ok;

  const chooseBranch = async (root, requested, title) => {
    let base = requested ? String(requested).trim() : `jolo/${slug(title) || stamp()}`;
    if (base.length > BRANCH_MAX) base = base.slice(0, BRANCH_MAX);
    if (!(await git(root, ["check-ref-format", "--branch", base])).ok) throw new ProtocolError("invalid_params", `"${base}" is not a valid branch name`);
    if (requested) {
      if (await branchExists(root, base)) throw new ProtocolError("conflict", `branch ${base} already exists; pick another name or check it out yourself`);
      return base;
    }
    let name = base;
    for (let n = 2; await branchExists(root, name); n += 1) name = `${base}-${n}`;
    return name;
  };

  // A checkout exists on disk before the database can name it, so the intent is written down first (§14.4).
  // A marker left behind means the engine stopped between `git worktree add` and the row that hands the
  // checkout to the user: nobody ever saw it, so it can be taken back — unless the branch has moved since,
  // which makes the outcome ambiguous and therefore the user's to judge.
  const journalDir = path.join(paths.dataDir, "worktrees", "pending");
  const journalPath = (token) => path.join(journalDir, `${token}.json`);
  const journal = (record) => {
    const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      mkdirSync(journalDir, { recursive: true, mode: 0o700 });
      writeFileSync(`${journalPath(token)}.tmp`, JSON.stringify(record), { mode: 0o600 });
      renameSync(`${journalPath(token)}.tmp`, journalPath(token));
    } catch (error) { throw new ProtocolError("unavailable", `could not persist worktree intent: ${error.message}`); }
    return token;
  };
  const forget = (token) => { try { unlinkSync(journalPath(token)); } catch { /* never written, or already reconciled */ } };

  const chooseDirectory = (project, branch) => {
    const parent = path.join(paths.dataDir, "worktrees", project.id);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const stem = branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "worktree";
    let dir = path.join(parent, stem);
    for (let n = 2; existsSync(dir); n += 1) dir = path.join(parent, `${stem}-${n}`);
    return dir;
  };

  return {
    isBusy: workspaceId => busy.has(workspaceId),
    /** Create a worktree on a new branch from `base` (default HEAD of the main checkout); grants inspection. */
    async create({ projectId, branch: requested, base: requestedBase, title }) {
      const project = storage.getProject(projectId);
      if (!project) throw new ProtocolError("not_found", "unknown project");
      const root = await repoRoot(project);
      const baseRef = requestedBase ? String(requestedBase).trim() : "HEAD";
      const resolved = await git(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${baseRef}^{commit}`]);
      if (!resolved.ok) throw new ProtocolError("invalid_params", requestedBase ? `"${baseRef}" is not a commit in this repository` : "the repository has no commits yet; make the first commit before creating a worktree");
      const baseCommit = resolved.stdout;
      const branch = await chooseBranch(root, requested, title);
      const dir = chooseDirectory(project, branch);
      const token = journal({ projectId, root, branch, dir, baseCommit, at: new Date().toISOString() });
      const added = await git(root, ["worktree", "add", "-b", branch, dir, baseCommit]);
      if (!added.ok) {
        rmSync(dir, { recursive: true, force: true });
        forget(token);
        throw new ProtocolError("internal", `git worktree add failed: ${added.stderr.slice(0, 500)}`);
      }
      const workspacePath = realpathSync(dir);
      let workspace;
      try { workspace = storage.transaction(() => {
        const workspace = storage.insertWorkspace({ projectId, mode: "worktree", path: workspacePath, branch, baseCommit, owned: true });
        const { grant, created } = permissions.grantInspect(workspace.id); // the user asked for this checkout (§10.1)
        if (created) storage.appendEvent({ type: "grant.created", payload: { grantId: grant.id, scope: grant.scope, workspaceId: workspace.id } });
        storage.setProjectPreferences(projectId, { ...storage.getProjectPreferences(projectId), workspaceMode: "worktree" });
        storage.appendEvent({ type: "workspace.created", payload: { workspace } });
        log.info("worktree created", { projectId, workspaceId: workspace.id, branch, path: workspacePath });
        return workspace;
      });
      } catch (error) {
        try {
          const removed = await git(root, ["worktree", "remove", "--force", dir]);
          if (removed.ok) {
            await git(root, ["branch", "-D", branch]);
            forget(token);
          }
        } catch (cleanupError) { log.error("worktree cleanup deferred to recovery", { path: dir, error: String(cleanupError) }); }
        throw error;
      }
      forget(token); // the checkout is the user's now; the journal has nothing left to reconcile
      return workspace;
    },

    /**
     * Take back checkouts the engine made but never handed over, and say so for the ones it must not touch.
     * Runs once at startup, before any client can ask for a workspace list (§14.1).
     * @returns {Promise<{ removed: number, parked: number }>}
     */
    async reconcile() {
      let removed = 0;
      let parked = 0;
      let entries = [];
      try { entries = readdirSync(journalDir).filter((name) => name.endsWith(".json")); } catch { return { removed, parked }; }
      for (const name of entries) {
        const file = path.join(journalDir, name);
        let record;
        try { record = JSON.parse(readFileSync(file, "utf8")); } catch { try { unlinkSync(file); } catch { /* gone */ } continue; }
        const { root, branch, dir, baseCommit } = record ?? {};
        if (!root || !branch || !dir) { try { unlinkSync(file); } catch { /* gone */ } continue; }
        if (record.operation === "remove") {
          const workspace = storage.getWorkspace(record.workspaceId);
          if (workspace && workspace.owned && workspace.path === dir && !existsSync(dir) && !workspace.removedAt) {
            storage.transaction(() => {
              storage.markWorkspaceRemoved(workspace.id);
              storage.appendEvent({ type: "workspace.removed", payload: { workspaceId: workspace.id, projectId: workspace.projectId, path: dir, branch: workspace.branch } });
            });
            removed++;
          }
          unlinkSync(file);
          continue;
        }
        let known = storage.workspaceAtPath(dir);
        if (!known) { try { known = storage.workspaceAtPath(realpathSync(dir)); } catch { /* the directory is gone */ } }
        if (known) { try { unlinkSync(file); } catch { /* gone */ } continue; } // the row did commit; nothing was stranded
        const head = await git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
        if (head.ok && baseCommit && head.stdout !== baseCommit) {
          // Something committed on this branch after the crash. Removing it would destroy work nobody can see.
          log.warn("a worktree left over from an interrupted start has moved on; leaving it for the user", { branch, path: dir });
          parked += 1;
          continue;
        }
        if (existsSync(dir)) {
          const gone = await git(root, ["worktree", "remove", "--force", dir]);
          if (!gone.ok) { rmSync(dir, { recursive: true, force: true }); await git(root, ["worktree", "prune"]); }
        } else await git(root, ["worktree", "prune"]);
        if (head.ok) await git(root, ["branch", "-D", branch]);
        try { unlinkSync(file); } catch { /* gone */ }
        removed += 1;
        log.info("took back a worktree the engine made but never handed over", { branch, path: dir });
      }
      return { removed, parked };
    },

    list(projectId) {
      return storage.listWorkspaces(projectId).map((workspace) => ({ ...workspace, present: existsSync(workspace.path), sessionCount: storage.countSessionsForWorkspace(workspace.id) }));
    },

    /**
     * Remove a Jolo-owned worktree. Refuses while a run uses it and, without `force`, while it holds
     * uncommitted changes; open terminals in it are closed. The branch stays; user-created worktrees are never touched (§9.1).
     */
    async remove({ workspaceId, force = false }) {
      if (busy.has(workspaceId)) throw new ProtocolError("conflict", "workspace removal is already in progress");
      busy.add(workspaceId);
      try {
      const workspace = storage.getWorkspace(workspaceId);
      if (!workspace || workspace.removedAt) throw new ProtocolError("not_found", "unknown workspace");
      if (workspace.mode !== "worktree" || !workspace.owned) throw new ProtocolError("permission_denied", "only worktrees created by Jolo can be removed here");
      if (storage.workspaceHasUnfinishedRuns(workspaceId)) throw new ProtocolError("conflict", "a task is still running in this worktree; stop or finish it first");
      if (terminals) for (const terminal of terminals.list(workspaceId)) terminals.close({ terminalId: terminal.terminalId }); // the user chose removal; its shells go with it
      const project = storage.getProject(workspace.projectId);
      const root = await repoRoot(project);
      const token = journal({ operation: "remove", workspaceId, root, dir: workspace.path, branch: workspace.branch });
      if (existsSync(workspace.path)) {
        if (!force) {
          const status = await git(workspace.path, ["status", "--porcelain", "--untracked-files=normal"]);
          if (status.ok && status.stdout.length > 0) throw new ProtocolError("conflict", "the worktree has uncommitted changes; commit or export them, or remove with force", { dirty: status.stdout.split("\n").length });
        }
        const removed = await git(root, ["worktree", "remove", ...(force ? ["--force"] : []), workspace.path]);
        if (!removed.ok) throw new ProtocolError("internal", `git worktree remove failed: ${removed.stderr.slice(0, 500)}`);
      } else {
        await git(root, ["worktree", "prune"]);
      }
      const result = storage.transaction(() => {
        storage.markWorkspaceRemoved(workspaceId);
        storage.appendEvent({ type: "workspace.removed", payload: { workspaceId, projectId: workspace.projectId, path: workspace.path, branch: workspace.branch } });
        log.info("worktree removed", { workspaceId, branch: workspace.branch, forced: force });
        return { workspaceId, branch: workspace.branch, path: workspace.path };
      });
      forget(token);
      return result;
      } finally { busy.delete(workspaceId); }
    },
  };
}
