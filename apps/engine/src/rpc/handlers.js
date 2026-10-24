import { delegationTools } from '../tools/delegation.js';
import { requireInteractive } from "./authorization.js";
import { permissionCwd } from '../permissions/service.js';
import { browserCallHandler } from '../browser/rpc.js';
import { liveRunFor } from './capabilities.js';
// Application RPC surface. Transport authentication stays in server.js; service composition stays in engine.js.
import { closeSync, existsSync, mkdirSync, mkdtempSync, rmSync, openSync, readSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from 'node:path';
import { resolveWorkspacePath, WorkspacePathError } from "../tools/paths.js";
import { ProtocolError, PROTOCOL_VERSION, activityPayload } from "@jolo/protocol";
import { revertPatchPath } from "../workspaces/revert.js";
import { workingChanges, workingDiff } from "../workspaces/working-changes.js";
import { SELF_MENTION, routeFor } from "../agents/mentions.js";
import { CONTINUATION_PREFIX, isContinuation } from "../agents/claude-stream.js";
import { withTaskChoice } from "../agents/hosted.js";
import { endedActivity } from "../agents/claude-link.js";
import { fileTools } from "../tools/files.js";
import { createImageUpload, writeImageUpload } from '../attachments.js';
import { linkChatFolder } from '../account/chat-context.js';
import { searchWorkspaceFiles, listWorkspaceFolder, searchWorkspaceText } from '../search/files.js';

/**
 * Every service the RPC surface reaches. The engine hands over all of them at once; a test driving
 * a single method stands in for the few that method touches and names this type as it does so.
 * @typedef {{
 *   storage: any, settingsService: any, providerFactory: any, agentModels: any, agentLimits: any, credentials: any,
 *   account: any, tasks: any, permissions: any, dialogs: any, dispatcher: any, browser: any, supervisor: any,
 *   search: any, terminals: any, board: any, worktrees: any, plans: any, schedules: any, delegations?: any, agents: any, runs: any,
 *   hostedLinks?: any, paths: any, bootId: string, build: string, startedMs: number, startedAt: string,
 *   agentName: () => string, stop: (reason: string) => any, getServer: () => any, toolEnv: any, log?: any,
 * }} RpcDependencies
 */

/** @param {RpcDependencies} deps */
export function createRpcHandlers({ storage, settingsService, providerFactory, agentModels, agentLimits, credentials, account, tasks, permissions, dialogs, dispatcher, browser, supervisor, search, terminals, board, worktrees, plans, schedules, delegations, agents, runs, hostedLinks = null, paths, bootId, build, startedMs, startedAt, agentName, stop, getServer, toolEnv, log = null }) {
  /**
   * The one write path behind rename, archive and delete: each names only the field it changes.
   * @param {{ sessionId: string, expectedRevision: number, title?: string, state?: string, deleted?: boolean }} request
   */
  const editSession = ({ sessionId, expectedRevision, title, state, deleted = false }) => {
    const result = storage.transaction(() => {
      const session = storage.getSession(sessionId);
      if (!session) throw new ProtocolError("not_found", "task no longer exists");
      if (session.revision !== expectedRevision) throw new ProtocolError("conflict", "task changed; refresh and try again");
      if ((state === "archived" || deleted) && storage.sessionHasUnfinishedRuns(sessionId)) throw new ProtocolError("conflict", "finish or stop this task before archiving or deleting it");
      const updated = storage.updateSession(sessionId, { title, state, deleted });
      storage.appendEvent({ sessionId, type: deleted ? "session.deleted" : "session.updated", payload: deleted ? { sessionId, projectId: session.projectId } : { session: updated } });
      return deleted ? { sessionId } : { session: updated };
    });
    // Archive, restore and delete each carry the task's heartbeats with them.
    schedules?.reconcileSession(sessionId);
    // A task put away or removed has no further turns: its agent process, if one is kept, is closed.
    if (state === "archived" || deleted) void hostedLinks?.close(sessionId, deleted ? "task deleted" : "task archived");
    return result;
  };

  let activeSearches = 0;
  let inFlight = 0, reloading = false;
  /** The task a capability credential is bound to: named on the credential, else resolved from the run it was issued for. Fails closed. */
  const capabilitySession = (conn) => {
    if (!conn?.capability) return null;
    const sessionId = conn.capability.sessionId ?? storage.getRun(conn.capability.runId)?.sessionId;
    if (!sessionId) throw new ProtocolError("permission_denied", "this credential no longer names a task");
    return sessionId;
  };
  const scheduleScope = (conn) => conn?.capability ? { sessionId: capabilitySession(conn) } : null;

  const handlers = {
    'browser.call': browserCallHandler({ storage, runs, dispatcher, settingsService }),
    'workspace.search': async ({ workspaceId, ...args }, conn) => {
      const workspace = storage.getWorkspace(workspaceId);
      if (!workspace || workspace.removedAt) throw new ProtocolError('not_found', 'unknown workspace');
      permissions.authorize({ toolClass: "read", workspaceId });
      if (activeSearches >= 8) throw new ProtocolError('limit_exceeded', 'search is busy; retry shortly');
      const controller = new AbortController();
      const cancel = () => controller.abort();
      const timer = setTimeout(cancel, 60_000);
      conn.closeHooks.add(cancel);
      activeSearches++;
      try {
        return await fileTools.find(tool => tool.name === 'search_text').execute(dispatcher.searchContext(workspace, controller.signal), args);
      } finally { activeSearches--; clearTimeout(timer); conn.closeHooks.delete(cancel); }
    },
    "engine.status": () => ({
      engineBootId: bootId, pid: process.pid, build, protocol: PROTOCOL_VERSION, agent: agentName(),
      clients: getServer().clientCount, activeRuns: runs.activeCount, queuedRuns: runs.queuedCount, uptimeMs: Date.now() - startedMs, startedAt, cursor: storage.maxSeq(),
    }),
    "engine.stop": ({ cancelActive }) => {
      if (!cancelActive && (runs.activeCount > 0 || runs.queuedCount > 0 || hostedLinks?.working)) throw new ProtocolError("conflict", "runs or agents' background work are active; pass cancelActive to stop anyway", { activeRuns: runs.activeCount, queuedRuns: runs.queuedCount });
      setTimeout(() => void stop("requested"), 50);
      return { stopping: true };
    },
    "engine.reload": (_params, conn) => {
      requireInteractive(conn);
      if (inFlight > 1 || runs.activeCount || runs.queuedCount || terminals.list().length || hostedLinks?.working) {
        throw new ProtocolError("conflict", "engine will reload after active tasks, terminals and requests finish");
      }
      // The check and admission gate are synchronous: no new request can start
      // work between deciding the engine is idle and closing its connections.
      reloading = true;
      setTimeout(() => void stop("source updated"), 50);
      return { stopping: true };
    },
    "project.open": ({ path }) => {
      let root;
      try {
        root = realpathSync(path);
        if (!statSync(root).isDirectory()) throw new Error("not a directory");
      } catch {
        throw new ProtocolError("not_found", "project path is not an existing directory");
      }
      return storage.transaction(() => {
        let project = storage.listProjects().find(p => p.rootPath === root) ?? storage.upsertProject({ identity: root, rootPath: root });
        const preferences = storage.getProjectPreferences(project.id);
        if (preferences.redirectProjectId) project = storage.getProject(preferences.redirectProjectId);
        if (storage.getProjectPreferences(project.id).removedAt) storage.setProjectRemoved(project.id, false); // opening the folder again puts it back in the sidebar
        const workspace = storage.getProjectPreferences(project.id).syncPlaceholder ? storage.listWorkspaces(project.id)[0] : storage.ensureDirectWorkspace(project.id, project.rootPath);
        const needsFolder = storage.getWorkspace(workspace.id).needsFolder;
        if (!needsFolder) {
          const { grant, created } = permissions.grantInspect(workspace.id); // user selected the project (§10.1)
          if (created) storage.appendEvent({ type: "grant.created", payload: { grantId: grant.id, scope: grant.scope, workspaceId: workspace.id } });
        }
        const preferredMode = storage.getProjectPreferences(project.id).workspaceMode === "worktree" ? "worktree" : "direct";
        return { projectId: project.id, workspaceId: workspace.id, rootPath: project.rootPath, mode: workspace.mode, preferredMode, needsFolder, standalone: storage.getProjectPreferences(project.id).standalone === true };
      });
    },
    'project.linkFolder': ({ workspaceId, path }, conn) => {
      requireInteractive(conn, 'Choose a local folder in Jolo to link this synced project.');
      return linkChatFolder({ storage, permissions, workspaceId, folder: path });
    },
    // Forget a folder in the sidebar without touching it: its chats are archived, so they stay in history and come
    // back when the same folder is opened again, and its worktrees stay on disk. A run still going refuses.
    'project.remove': ({ projectId }, conn) => {
      requireInteractive(conn, 'only an interactive client can remove a project from the sidebar');
      const archived = storage.transaction(() => {
        const project = storage.getProject(projectId);
        if (!project) throw new ProtocolError('not_found', 'unknown project');
        if (project.preferences.standalone) throw new ProtocolError('invalid_params', 'a chat is archived from its own menu');
        const busy = storage.unfinishedRunForProject(projectId);
        if (busy) throw new ProtocolError('conflict', `“${busy.sessionTitle || 'New task'}” is still running in this folder; stop or finish it first`, { runId: busy.runId, sessionId: busy.sessionId });
        const ids = storage.openSessionIdsForProject(projectId);
        for (const sessionId of ids) {
          const session = storage.updateSession(sessionId, { state: 'archived' });
          storage.appendEvent({ sessionId, type: 'session.updated', payload: { session } });
        }
        if (!project.preferences.removedAt) storage.setProjectRemoved(projectId, true);
        return ids;
      });
      for (const sessionId of archived) {
        schedules?.reconcileSession(sessionId); // archived chats drop their heartbeats, as archiving one does
        void hostedLinks?.close(sessionId, "task archived"); // and their agent processes, as archiving one does
      }
      return { projectId, archived: archived.length };
    },
    "settings.get": () => ({ settings: settingsService.get() }),
    'task.list': params => tasks.list(params),
    'task.get': params => tasks.get(params),
    'account.status': params => account.status(params),
    'account.sync': (params, conn) => { requireInteractive(conn, 'Chat sync must be changed by an interactive client.'); return account.chatSync.configure(params.enabled); },
    'account.login': (params, conn) => { requireInteractive(conn, 'Account sign-in must be started by an interactive client.'); return account.login(params); },
    'account.cancel': (_params, conn) => { requireInteractive(conn); return account.cancel(); },
    'account.logout': (_params, conn) => { requireInteractive(conn); return account.logout(); },
    "settings.update": (params) => ({ settings: settingsService.update(params) }),
    "provider.presets": () => providerFactory.presets(),
    "provider.models": ({ preset, refresh }) => providerFactory.models(preset, { refresh }),
    "credential.set": async ({ provider, value }) => {
      providerFactory?.catalog.get(provider);
      const stored = await credentials.set(provider, value);
      providerFactory?.directory.clear();
      return { provider, stored };
    },
    "credential.status": async ({ provider }) => credentials.status(provider),
    "workspace.create": async (params) => ({ workspace: await worktrees.create(params) }),
    "workspace.list": ({ projectId }) => {
      if (!storage.getProject(projectId)) throw new ProtocolError("not_found", "unknown project");
      return { workspaces: worktrees.list(projectId) };
    },
    "workspace.remove": async (params, conn) => {
      requireInteractive(conn, "only an interactive client can remove a worktree");
      // No process keeps a file open in a folder being deleted, but only once the removal has passed its checks: a refused
      // removal must not have stopped the background work of the conversations in it.
      return worktrees.remove(params, { beforeRemove: () => hostedLinks?.closeWorkspace(params.workspaceId, "workspace removed") });
    },
    // Hosted coding agents still require a cwd. Each standalone chat gets its own
    // private working directory, never the user's last selected repository.
    'chat.create': ({ title, agentId, model }) => {
      if (model) providerFactory.catalog.get(model.preset);
      if (agentId && agents.catalog.get(agentId).transport === 'pty') throw new ProtocolError('invalid_params', 'Choose an agent that supports chat');
      const directory = path.join(paths.dataDir, 'chats');
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const root = realpathSync(mkdtempSync(path.join(directory, 'chat-')));
      try {
        return storage.transaction(() => {
          const project = storage.upsertProject({ identity: root, rootPath: root });
          storage.setProjectPreferences(project.id, { standalone: true });
          const workspace = storage.ensureDirectWorkspace(project.id, root);
          const { grant, created } = permissions.grantInspect(workspace.id);
          if (created) storage.appendEvent({ type: 'grant.created', payload: { grantId: grant.id, scope: grant.scope, workspaceId: workspace.id } });
          const session = storage.createSession({ projectId: project.id, workspaceId: workspace.id, title, agentId: agentId ?? null, model });
          storage.appendEvent({ sessionId: session.id, type: 'session.created', payload: { session } });
          return { session, rootPath: root };
        });
      } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
    },
    "session.create": ({ projectId, workspaceId, title, agentId, model }) => storage.transaction(() => {
      if (model) providerFactory.catalog.get(model.preset);
      const workspace = storage.getWorkspace(workspaceId);
      if (!workspace || workspace.projectId !== projectId || workspace.removedAt) throw new ProtocolError("not_found", "unknown project/workspace");
      if (agentId) {
        // Only an agent with a structured transport can answer as a session; a terminal agent is watched, not conversed with (§4.3).
        const manifest = agents.catalog.get(agentId);
        if (manifest.transport === "pty") throw new ProtocolError("invalid_params", `${manifest.displayName} runs in a terminal; open it from the Agents panel instead of as a task`);
      }
      storage.setProjectPreferences(projectId, { ...storage.getProjectPreferences(projectId), workspaceMode: workspace.mode }); // remember the selected mode (§9.1)
      const session = storage.createSession({ projectId, workspaceId, title, agentId: agentId ?? null, model });
      storage.appendEvent({ sessionId: session.id, type: "session.created", payload: { session } });
      return { session, cursor: storage.maxSeq() };
    }),
    "session.list": (params) => ({ sessions: storage.listSessions(params) }),
    "session.rename": (params) => editSession(params),
    "session.setModel": ({ sessionId, model, expectedRevision }) => storage.transaction(() => {
      const session = storage.getSession(sessionId);
      if (!session) throw new ProtocolError('not_found', 'task no longer exists');
      if (session.revision !== expectedRevision) throw new ProtocolError('conflict', 'task changed; refresh and try again');
      if (model) providerFactory.catalog.get(model.preset);
      const updated = storage.setSessionModel(sessionId, model);
      storage.appendEvent({ sessionId, type: 'session.updated', payload: { session: updated } });
      return { session: updated };
    }),
    "session.setAgent": ({ sessionId, agentId, expectedRevision }) => {
      const result = storage.transaction(() => {
        const session = storage.getSession(sessionId);
        if (!session) throw new ProtocolError("not_found", "task no longer exists");
        if (session.revision !== expectedRevision) throw new ProtocolError("conflict", "task changed; refresh and try again");
        if (session.agentId === agentId) return { session, changed: false };
        if (storage.sessionHasUnfinishedRuns(sessionId)) throw new ProtocolError("conflict", "Finish or stop the current task before switching agents; your conversation will stay here.");
        if (agentId) {
          const manifest = agents.catalog.get(agentId);
          if (manifest.transport === "pty") throw new ProtocolError("invalid_params", `${manifest.displayName} runs in a separate terminal, not a chat`);
          agents.catalog.command(manifest); // Refuse an unavailable binary before changing the session.
        }
        const updated = storage.setSessionAgent(sessionId, agentId);
        storage.appendEvent({ sessionId, type: "session.updated", payload: { session: updated } });
        return { session: updated, changed: true };
      });
      // The remembered vendor conversation goes with the switch, and so does the process that was holding it.
      if (result.changed) void hostedLinks?.close(sessionId, "handed to another agent");
      return { session: result.session };
    },
    /** @param {{ archived: boolean, sessionId: string, expectedRevision: number }} params */
    "session.archive": ({ archived, ...params }) => editSession({ ...params, state: archived ? "archived" : "open" }),
    "session.delete": (params) => editSession({ ...params, deleted: true }),
    "session.pin": ({ sessionId, pinned, expectedRevision }) => storage.transaction(() => {
      const session = storage.getSession(sessionId);
      if (!session) throw new ProtocolError("not_found", "task no longer exists");
      if (session.revision !== expectedRevision) throw new ProtocolError("conflict", "task changed; refresh and try again");
      const updated = storage.setSessionPinned(sessionId, pinned);
      storage.appendEvent({ sessionId, type: "session.updated", payload: { session: updated } });
      return { session: updated };
    }),
    "session.setAgentModel": ({ sessionId, model, effort, expectedRevision }) => storage.transaction(() => {
      const session = storage.getSession(sessionId);
      if (!session) throw new ProtocolError("not_found", "task no longer exists");
      if (session.revision !== expectedRevision) throw new ProtocolError("conflict", "task changed; refresh and try again");
      if (!session.agentId) throw new ProtocolError("invalid_params", "Jolo answers this task; choose its model with session.setModel");
      const updated = storage.setSessionAgentModel(sessionId, model || effort ? { model: model ?? null, effort: effort ?? null } : null);
      storage.appendEvent({ sessionId, type: "session.updated", payload: { session: updated } });
      return { session: updated };
    }),
    "session.page": ({ sessionId, beforeOrdinal, limit }) => storage.transaction(() => {
      const session = storage.getSession(sessionId);
      if (!session) throw new ProtocolError("not_found", `unknown session ${sessionId}`);
      // A turn Claude began by itself has no message from the user; earlier ones stored a stand-in, left out before the
      // page is cut so that a page is never emptied by it.
      const { messages, hasOlder } = storage.listMessagesForSession(sessionId, { beforeOrdinal, limit, hideUserMessagesOf: CONTINUATION_PREFIX });
      const runsOf = storage.listRunsForSession(sessionId).map(run => isContinuation(run) ? { ...run, prompt: "" } : run);
      const pendingPermissions = storage.pendingPermissionsForSession(sessionId).map(permission => ({ permissionId: permission.id, runId: permission.runId, workspaceId: permission.workspaceId, tool: permission.tool, summary: permission.request.summary ?? permission.tool, ...(permission.request.argv ? { argv: permission.request.argv } : {}), ...(permission.request.script ? { script: permission.request.script } : {}), cwd: permissionCwd(storage.getWorkspace(permission.workspaceId).path, permission.request.cwd), isolation: "none", revision: permission.revision }));
      const pendingDialogs = dialogs?.pendingForSession(sessionId) ?? [];
      return { session, messages, runs: runsOf.map(run => ({ ...run, changedPaths: storage.changedPathsForRun(run.id) })), pendingPermissions, pendingDialogs, hasOlder, cursor: storage.maxSeq() };
    }),
    // What the conversation's agent process is doing now, for a client that joins while its work runs. With no process,
    // what its last one left, as it reads now that it is gone (see endedActivity); the read stores nothing, and the next
    // process starts from it and stores the change. Null when it never had a process.
    "session.activity": ({ sessionId }) => {
      if (!storage.getSession(sessionId)) throw new ProtocolError("not_found", `unknown session ${sessionId}`);
      const activity = hostedLinks?.get(sessionId)?.activity;
      if (activity) return { activity: activityPayload(activity) };
      const stored = storage.getSessionActivity(sessionId);
      return { activity: stored ? activityPayload(endedActivity(stored)) : null };
    },
    // Delete the conversation's finished tasks for good (the panel's Clear finished): from its process's ledger, which
    // reports and so stores the change, or with no process from its stored activity, announced here.
    "session.clearFinished": ({ sessionId }, conn) => {
      requireInteractive(conn, "only an interactive client can clear a conversation's finished tasks");
      if (!storage.getSession(sessionId)) throw new ProtocolError("not_found", `unknown session ${sessionId}`);
      const link = hostedLinks?.get(sessionId);
      if (link) return { cleared: link.clearFinished() };
      return storage.transaction(() => {
        const stored = storage.getSessionActivity(sessionId);
        if (!stored) return { cleared: 0 };
        // A task its gone process left running reads stopped, and goes with the other finished ones.
        if (stored.tasks.some(task => task.status === "running")) storage.saveSessionActivity(sessionId, endedActivity(stored));
        const cleared = storage.clearFinishedActivity(sessionId);
        if (cleared) storage.appendEvent({ sessionId, type: "session.activity", payload: activityPayload(endedActivity(storage.getSessionActivity(sessionId))) });
        return { cleared };
      });
    },
    // Stop the background work of the conversation's agent process, or one task of it; the turn under way goes on.
    "session.stopBackground": async ({ sessionId }) => {
      if (!storage.getSession(sessionId)) throw new ProtocolError("not_found", `unknown session ${sessionId}`);
      const link = hostedLinks?.get(sessionId);
      return link?.alive ? link.stopBackground() : { requested: 0, stopped: 0, escalated: false };
    },
    // A task's whole output, read from the conversation's process, which holds it during the task and after it.
    "session.taskOutput": async ({ sessionId, taskId }) => {
      if (!storage.getSession(sessionId)) throw new ProtocolError("not_found", `unknown session ${sessionId}`);
      const link = hostedLinks?.get(sessionId);
      if (!link?.alive) throw new ProtocolError("no_process", "the process that ran this task has ended");
      try { return await link.taskOutput(taskId); }
      catch (error) {
        if (error?.code === "no_process") throw new ProtocolError("no_process", "the process that ran this task has ended");
        if (error?.timedOut) throw new ProtocolError("unavailable", "Claude did not answer with the task's output");
        throw new ProtocolError("not_found", String(error?.message ?? error)); // Claude's own words: it knows no such task
      }
    },
    // The MCP servers of the conversation's process and how each is: asked now, else as its latest turn's init listed them.
    "session.mcpStatus": async ({ sessionId }) => {
      if (!storage.getSession(sessionId)) throw new ProtocolError("not_found", `unknown session ${sessionId}`);
      const link = hostedLinks?.get(sessionId);
      if (!link?.alive) return { servers: null };
      try { return await link.mcpStatus(); }
      catch (error) {
        if (error?.code === "no_process") return { servers: null }; // it ended meanwhile: it has no servers now
        log?.info?.("MCP status had no answer; using the process's latest init list", { sessionId, reason: String(error?.message ?? error) });
        return { servers: link.state.mcpServers ?? null };
      }
    },
    "session.stopTask": async ({ sessionId, taskId }) => {
      if (!storage.getSession(sessionId)) throw new ProtocolError("not_found", `unknown session ${sessionId}`);
      const link = hostedLinks?.get(sessionId);
      return link?.alive ? link.stopTask(taskId) : { ok: false, error: "no process" };
    },
    // Close the process itself, for tasks that ignored stop_task; a graceful close can outlast the call, so it is not awaited.
    "session.closeProcess": ({ sessionId }, conn) => {
      requireInteractive(conn, "only an interactive client can stop a conversation's process");
      if (!storage.getSession(sessionId)) throw new ProtocolError("not_found", `unknown session ${sessionId}`);
      if (!hostedLinks?.get(sessionId)?.alive) return { closing: false };
      void hostedLinks.close(sessionId, "stopped by the person");
      return { closing: true };
    },
    'delegation.models': ({ source }) => delegations.models(source),
    'delegation.list': ({ sessionId }) => delegations.list(sessionId),
    'delegation.call': (params, conn) => {
      const runId = conn?.capability ? liveRunFor(runs, storage, conn.capability) : params.runId;
      const run = runId && storage.getRun(runId);
      if (!run) throw new ProtocolError('permission_denied', 'Delegation needs an existing parent run');
      const session = storage.getSession(run.sessionId);
      if (!session || (conn?.capability && session.workspaceId !== conn.capability.workspaceId)) throw new ProtocolError('permission_denied', 'The parent workspace is unavailable');
      const tool = delegationTools.find(tool => tool.name === params.name);
      return tool.execute({ delegations, runId }, tool.params.parse(params.arguments));
    },
    "run.start": async (params) => {
      const existing = storage.findRunByRequest(params.sessionId, params.requestId);
      if (existing) return { run: existing, deduplicated: true };
      const selected = await delegations?.prepare(params.prompt) ?? [];
      const session = storage.getSession(params.sessionId);
      // A task's own choice of model and effort applies when its own agent answers, under anything named for this run.
      const ownChoice = request => ({ ...request, execution: withTaskChoice(session, request.execution) });
      const admit = request => storage.transaction(() => {
        delegations?.register(request.sessionId, selected);
        return runs.start(ownChoice(request));
      });
      const resolved = tasks ? await tasks.resolve(params.prompt) : { references: [], assertCurrent() {} };
      resolved.assertCurrent();
      params = { ...params, taskReferences: resolved.references };
      // "@codex …" at the start of a message calls that agent into this conversation for one turn (§6.5).
      const named = params.execution?.preset ? { agentId: SELF_MENTION } : params.execution?.agentId ? { agentId: params.execution.agentId } : routeFor({ prompt: params.prompt, catalog: agents.catalog, sessionAgentId: session?.agentId ?? null });
      if (!named) return admit(params);
      if (named.agentId !== SELF_MENTION) {
        const manifest = agents.catalog.get(named.agentId); // throws when a client names an agent that is gone
        if (manifest.transport === "pty") throw new ProtocolError("invalid_params", `${manifest.displayName} runs in a terminal and cannot answer a task`);
      } else if (!session?.agentId) {
        return admit(params); // Jolo already answers here
      }
      return admit({ ...params, execution: { ...(params.execution ?? {}), agentId: named.agentId } });
    },
    "run.cancel": (params) => ({ run: runs.cancel(params) }),
    "run.sendNow": (params, conn) => { requireInteractive(conn); return { run: runs.sendNow(params) }; },
    "run.snapshot": ({ runId }) => {
      const snapshot = runs.snapshot(runId);
      return { ...snapshot, run: { ...snapshot.run, changedPaths: storage.changedPathsForRun(runId) } };
    },
    'attachment.create': (params, conn) => { requireInteractive(conn); return createImageUpload(storage, params); },
    'attachment.write': (params, conn) => { requireInteractive(conn); return writeImageUpload(storage, params); },
    "artifact.read": ({ artifactId, offset, length, encoding }) => {
      const artifact = storage.getArtifact(artifactId);
      if (!artifact) throw new ProtocolError("not_found", "unknown artifact");
      const { buffer, eof } = storage.readArtifact(artifact, offset, length, artifact.committedBytes);
      return { artifactId, offset, bytes: buffer.length, text: buffer.toString(encoding === "base64" ? "base64" : "utf8"), committedBytes: artifact.committedBytes, eof, kind: artifact.kind };
    },
    'browser.setOpener': ({ workspaceIds }, conn) => {
      requireInteractive(conn);
      const liveIds = workspaceIds.filter(id => { const workspace = storage.getWorkspace(id); return workspace && !workspace.removedAt; });
      return browser.setOpener(conn, liveIds);
    },
    'browser.openResult': (params, conn) => browser.openResult(conn, params),
    "browser.register": (params, conn) => storage.transaction(() => {
      requireInteractive(conn);
      const workspace = storage.getWorkspace(params.workspaceId);
      if (!workspace || workspace.removedAt) throw new ProtocolError("not_found", "unknown workspace");
      const { grant, created } = permissions.grantBrowse(params.workspaceId); // attached from the Browser button or a chat browser_open request
      if (created) storage.appendEvent({ type: "grant.created", payload: { grantId: grant.id, scope: grant.scope, workspaceId: params.workspaceId } });
      const capability = browser.register(conn, params, grant.id);
      return { capabilityId: capability.capabilityId, grantId: grant.id };
    }),
    "browser.update": (params, conn) => { const capability = browser.update(conn, params); return { capabilityId: capability.capabilityId, navigationRevision: capability.navigationRevision }; },
    "browser.unregister": ({ capabilityId }, conn) => {
      const capability = browser.capability(capabilityId);
      if (!capability || capability.conn !== conn) throw new ProtocolError("not_found", "unknown capability for this host");
      browser.unregister(capabilityId, "host unregistered");
      return { capabilityId };
    },
    "browser.result": (params, conn) => browser.result(conn, params),
    "permission.resolve": (params, conn) => {
      requireInteractive(conn, "only an interactive client can submit a user's decision");
      const permission = permissions.resolve(params);
      const run = storage.getRun(permission.runId);
      if (run?.state === "paused" && run.pauseReason === "permission" && permission.state === "allowed") runs.resume({ runId: run.id });
      // A standing answer also answered other questions: runs paused on them go on as well.
      for (const other of permission.settled ?? []) {
        const paused = storage.getRun(other.runId);
        if (paused?.id === run?.id || paused?.state !== "paused" || paused.pauseReason !== "permission") continue;
        try { runs.resume({ runId: paused.id }); } catch { /* it stays paused, to be resumed by hand */ }
      }
      return { permissionId: permission.id, decision: permission.decision, revision: permission.revision, runId: permission.runId };
    },
    // The person's answer to a question an agent asked them, or their refusal to answer; the first settlement wins.
    "dialog.resolve": ({ dialogId, response }, conn) => {
      requireInteractive(conn, "only an interactive client can answer for the user");
      return { dialogId, state: dialogs.resolve(dialogId, response).state };
    },
    "dialog.dismiss": ({ dialogId, message }, conn) => {
      requireInteractive(conn, "only an interactive client can answer for the user");
      return { dialogId, state: dialogs.dismiss(dialogId, message).state };
    },
    "run.resume": (params) => ({ run: runs.resume(params) }),
    "terminal.open": (params, conn) => { requireInteractive(conn, "terminals are for interactive clients"); return terminals.open({ conn, ...params }); },
    "terminal.attach": (params, conn) => terminals.attach({ conn, ...params }),
    "terminal.input": (params, conn) => terminals.input({ conn, ...params }),
    "terminal.resize": (params, conn) => terminals.resize({ conn, ...params }),
    "terminal.lease": (params, conn) => terminals.lease({ conn, ...params }),
    "terminal.close": (params) => terminals.close(params),
    "terminal.list": ({ workspaceId }) => ({ terminals: terminals.list(workspaceId) }),
    "agent.catalog": () => ({ agents: agents.catalog.list() }),
    // Asking an agent for its models starts that agent, so only an interactive client may (§4.3).
    "agent.models": ({ agentId, refresh }, conn) => {
      requireInteractive(conn, "asking an agent for its models is for interactive clients");
      return agentModels.list(agentId, { refresh });
    },
    // So does asking how much of its plan is left.
    "agent.limits": ({ agentId, refresh }, conn) => {
      requireInteractive(conn, "asking an agent for its usage limits is for interactive clients");
      return agentLimits.read(agentId, { refresh });
    },
    "agent.start": (params, conn) => {
      // Launching another vendor's CLI is a user action, like opening a terminal: never a model tool (§4.3).
      requireInteractive(conn, "hosted agents are for interactive clients");
      return agents.start({ conn, ...params });
    },
    "agent.list": ({ workspaceId }) => ({ agents: agents.list(workspaceId) }),
    "agent.stop": (params, conn) => {
      requireInteractive(conn, "hosted agents are for interactive clients");
      return agents.stop(params);
    },
    "patch.revert": ({ invocationId, path: relative }, conn) => {
      requireInteractive(conn, "only an interactive client can revert changes");
      return revertPatchPath({ storage, invocationId, relative, patchesDir: paths.patchesDir });
    },
    // Plans (§6.6). Starting one is like starting a run: it needs no interactive client, and a task that asks
    // a question nobody is there to answer waits durably rather than being answered for the user.
    "plan.create": (params) => plans.create(params),
    "plan.list": (params) => ({ plans: plans.list(params) }),
    "plan.get": ({ planId }) => plans.get(planId),
    "plan.start": (params) => plans.start(params),
    "plan.pause": ({ planId }) => plans.pause(planId),
    "plan.cancel": ({ planId }) => plans.cancel(planId),
    "plan.task.add": (params) => plans.addTask(params),
    "plan.task.update": (params) => plans.updateTask(params),
    "plan.task.remove": ({ taskId }) => plans.removeTask(taskId),
    "plan.task.retry": ({ taskId }) => plans.retryTask(taskId),
    "plan.task.skip": ({ taskId }) => plans.skipTask(taskId),
    // A schedule is a heartbeat a task asked for: it fires whether or not anyone is watching.
    // A capability credential (the MCP bridge a hosted agent gets) is bound to one run: the schedule
    // it manages is that run's own session's. Owner callers name the session themselves.
    "schedule.create": (params, conn) => {
      const sessionId = capabilitySession(conn) ?? params.sessionId;
      if (!sessionId) throw new ProtocolError("invalid_params", "a schedule needs a task to wake");
      return schedules.create({ sessionId, prompt: params.prompt, everyMs: params.everyMs });
    },
    "schedule.list": (params, conn) => schedules.list({ sessionId: capabilitySession(conn) ?? params.sessionId ?? null }),
    "schedule.pause": ({ scheduleId }, conn) => schedules.pause(scheduleId, scheduleScope(conn)),
    "schedule.resume": ({ scheduleId }, conn) => schedules.resume(scheduleId, scheduleScope(conn)),
    "schedule.cancel": ({ scheduleId }, conn) => schedules.cancel(scheduleId, scheduleScope(conn)),
    "board.list": () => board.list(),
    "board.tasks": (params) => board.tasks(params),
    "board.viewed": ({ workspaceId }) => {
      const viewed = board.viewed(workspaceId);
      if (!viewed) throw new ProtocolError("not_found", "unknown workspace");
      return viewed;
    },
    "workspace.readFile": ({ workspaceId, path: relative, maxBytes, offset = 0, encoding = 'utf8' }, conn) => {
      requireInteractive(conn, "file previews are for interactive clients");
      const workspace = storage.getWorkspace(workspaceId);
      if (!workspace || workspace.removedAt) throw new ProtocolError("not_found", "unknown workspace");
      permissions.authorize({ toolClass: "read", workspaceId });
      let resolved;
      try { resolved = resolveWorkspacePath(workspace.path, relative); } catch (error) { throw new ProtocolError(error instanceof WorkspacePathError && error.code === "not_found" ? "not_found" : "permission_denied", error.message); }
      if (!resolved.stat.isFile()) throw new ProtocolError("invalid_params", "path is not a file");
      const fd = openSync(resolved.absolute, "r");
      try {
        const buffer = Buffer.alloc(Math.min(Math.max(0, resolved.stat.size - offset), maxBytes));
        const bytes = readSync(fd, buffer, 0, buffer.length, offset);
        const view = buffer.subarray(0, bytes);
        const binary = view.subarray(0, 8192).includes(0);
        return { path: resolved.relative, text: encoding === 'base64' ? view.toString('base64') : binary ? "" : view.toString("utf8"), bytes, truncated: resolved.stat.size > offset + bytes, binary };
      } finally {
        closeSync(fd);
      }
    },
    // The composer's "@" picker. A typed fragment ranks the workspace's non-ignored files and folders;
    // a folder path lists that folder's top level, which a message carries so the agent knows where to look.
    "workspace.writeFile": ({ workspaceId, path: relative, text }, conn) => {
      requireInteractive(conn, "file editing is for interactive clients");
      const workspace = storage.getWorkspace(workspaceId);
      if (!workspace || workspace.removedAt) throw new ProtocolError("not_found", "unknown workspace");
      permissions.authorize({ toolClass: "read", workspaceId }); // the user edits their own folder: opening it was the grant
      let resolved;
      try { resolved = resolveWorkspacePath(workspace.path, relative, { mustExist: false }); } catch (error) { throw new ProtocolError(error instanceof WorkspacePathError && error.code === "not_found" ? "not_found" : "permission_denied", error.message); }
      if (resolved.stat && !resolved.stat.isFile()) throw new ProtocolError("invalid_params", "path is not a file");
      if (!resolved.stat && !existsSync(path.dirname(resolved.absolute))) throw new ProtocolError("not_found", "the file's folder does not exist");
      writeFileSync(resolved.absolute, text);
      return { path: resolved.relative, bytes: Buffer.byteLength(text) };
    },
    "workspace.files": async ({ workspaceId, query, path: folder, limit }, conn) => {
      requireInteractive(conn, "file pickers are for interactive clients");
      const workspace = storage.getWorkspace(workspaceId);
      if (!workspace || workspace.removedAt) throw new ProtocolError("not_found", "unknown workspace");
      permissions.authorize({ toolClass: "read", workspaceId });
      if (folder !== undefined) return listWorkspaceFolder({ root: workspace.path, folder, limit });
      const controller = new AbortController();
      const cancel = () => controller.abort();
      const timer = setTimeout(cancel, 10_000);
      conn.closeHooks.add(cancel);
      try { return await searchWorkspaceFiles({ root: workspace.path, env: toolEnv, signal: controller.signal, query, limit }); }
      finally { clearTimeout(timer); conn.closeHooks.delete(cancel); }
    },
    // The Files panel's search in files. It shares the engine-wide bound on searches running at once with
    // workspace.search, stops with the client that asked, and answers with what it found by its own deadline.
    "workspace.searchInFiles": async ({ workspaceId, query, limit }, conn) => {
      requireInteractive(conn, "searching in files is for interactive clients");
      const workspace = storage.getWorkspace(workspaceId);
      if (!workspace || workspace.removedAt) throw new ProtocolError("not_found", "unknown workspace");
      permissions.authorize({ toolClass: "read", workspaceId });
      if (activeSearches >= 8) throw new ProtocolError('limit_exceeded', 'search is busy; retry shortly');
      const controller = new AbortController();
      const cancel = () => controller.abort();
      conn.closeHooks.add(cancel);
      activeSearches++;
      try { return await searchWorkspaceText({ root: workspace.path, env: toolEnv, signal: controller.signal, query, limit }); }
      finally { activeSearches--; conn.closeHooks.delete(cancel); }
    },
    "workspace.changes": ({ workspaceId }) => {
      const workspace = storage.getWorkspace(workspaceId);
      if (!workspace) throw new ProtocolError("not_found", "unknown workspace");
      permissions.authorize({ toolClass: "read", workspaceId });
      return workingChanges(workspace, toolEnv);
    },
    "workspace.diff": ({ workspaceId, path: relative }) => {
      const workspace = storage.getWorkspace(workspaceId);
      if (!workspace) throw new ProtocolError("not_found", "unknown workspace");
      permissions.authorize({ toolClass: "read", workspaceId });
      return workingDiff(workspace, toolEnv, relative);
    },
  };

  return Object.fromEntries(Object.entries(handlers).map(([method, handler]) => [method, async (...args) => {
    if (reloading) throw new ProtocolError("unavailable", "engine is reloading");
    inFlight++;
    // Each handler takes its own params shape; the wrapper only counts them, so it calls through
    // the one signature they all share.
    try { return await /** @type {(...args: any[]) => any} */ (handler)(...args); }
    finally { inFlight--; }
  }]));
}
