import { requireInteractive } from "./authorization.js";
import { browserCallHandler } from '../browser/rpc.js';
// Application RPC surface. Transport authentication stays in server.js; service composition stays in engine.js.
import { closeSync, mkdirSync, mkdtempSync, rmSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import path from 'node:path';
import { resolveWorkspacePath, WorkspacePathError } from "../tools/paths.js";
import { ProtocolError, PROTOCOL_VERSION } from "@jolo/protocol";
import { revertPatchPath } from "../workspaces/revert.js";
import { workingChanges, workingDiff } from "../workspaces/working-changes.js";
import { SELF_MENTION, routeFor } from "../agents/mentions.js";
import { fileTools } from "../tools/files.js";
import { createImageUpload, writeImageUpload } from '../attachments.js';

export function createRpcHandlers({ storage, settingsService, providerFactory, agentModels, credentials, account, tasks, permissions, dispatcher, browser, supervisor, search, terminals, board, worktrees, plans, agents, runs, paths, bootId, build, startedMs, startedAt, agentName, stop, getServer, toolEnv }) {
  const editSession = ({ sessionId, expectedRevision, title, state, deleted = false }) => storage.transaction(() => {
    const session = storage.getSession(sessionId);
    if (!session) throw new ProtocolError("not_found", "task no longer exists");
    if (session.revision !== expectedRevision) throw new ProtocolError("conflict", "task changed; refresh and try again");
    if ((state === "archived" || deleted) && storage.sessionHasUnfinishedRuns(sessionId)) throw new ProtocolError("conflict", "finish or stop this task before archiving or deleting it");
    const updated = storage.updateSession(sessionId, { title, state, deleted });
    storage.appendEvent({ sessionId, type: deleted ? "session.deleted" : "session.updated", payload: deleted ? { sessionId, projectId: session.projectId } : { session: updated } });
    return deleted ? { sessionId } : { session: updated };
  });

  let activeSearches = 0;
  let inFlight = 0, reloading = false;
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
      if (!cancelActive && (runs.activeCount > 0 || runs.queuedCount > 0)) throw new ProtocolError("conflict", "runs are active; pass cancelActive to stop anyway", { activeRuns: runs.activeCount, queuedRuns: runs.queuedCount });
      setTimeout(() => void stop("requested"), 50);
      return { stopping: true };
    },
    "engine.reload": (_params, conn) => {
      requireInteractive(conn);
      if (inFlight > 1 || runs.activeCount || runs.queuedCount || terminals.list().length) {
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
        const project = storage.upsertProject({ identity: root, rootPath: root });
        const workspace = storage.ensureDirectWorkspace(project.id, root);
        const { grant, created } = permissions.grantInspect(workspace.id); // user selected the project (§10.1)
        if (created) storage.appendEvent({ type: "grant.created", payload: { grantId: grant.id, scope: grant.scope, workspaceId: workspace.id } });
        const preferredMode = storage.getProjectPreferences(project.id).workspaceMode === "worktree" ? "worktree" : "direct";
        return { projectId: project.id, workspaceId: workspace.id, rootPath: root, mode: "direct", preferredMode, standalone: storage.getProjectPreferences(project.id).standalone === true };
      });
    },
    "settings.get": () => ({ settings: settingsService.get() }),
    'task.list': params => tasks.list(params),
    'task.get': params => tasks.get(params),
    'account.status': params => account.status(params),
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
    "workspace.remove": (params, conn) => {
      requireInteractive(conn, "only an interactive client can remove a worktree");
      return worktrees.remove(params);
    },
    // Hosted coding agents still require a cwd. Each standalone chat gets its own
    // private working directory, never the user's last selected repository.
    'chat.create': ({ title, agentId }) => {
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
          const session = storage.createSession({ projectId: project.id, workspaceId: workspace.id, title, agentId: agentId ?? null });
          storage.appendEvent({ sessionId: session.id, type: 'session.created', payload: { session } });
          return { session, rootPath: root };
        });
      } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
    },
    "session.create": ({ projectId, workspaceId, title, agentId }) => storage.transaction(() => {
      const workspace = storage.getWorkspace(workspaceId);
      if (!workspace || workspace.projectId !== projectId || workspace.removedAt) throw new ProtocolError("not_found", "unknown project/workspace");
      if (agentId) {
        // Only an agent with a structured transport can answer as a session; a terminal agent is watched, not conversed with (§4.3).
        const manifest = agents.catalog.get(agentId);
        if (manifest.transport === "pty") throw new ProtocolError("invalid_params", `${manifest.displayName} runs in a terminal; open it from the Agents panel instead of as a task`);
      }
      storage.setProjectPreferences(projectId, { ...storage.getProjectPreferences(projectId), workspaceMode: workspace.mode }); // remember the selected mode (§9.1)
      const session = storage.createSession({ projectId, workspaceId, title, agentId: agentId ?? null });
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
    "session.setAgent": ({ sessionId, agentId, expectedRevision }) => storage.transaction(() => {
      const session = storage.getSession(sessionId);
      if (!session) throw new ProtocolError("not_found", "task no longer exists");
      if (session.revision !== expectedRevision) throw new ProtocolError("conflict", "task changed; refresh and try again");
      if (session.agentId === agentId) return { session };
      if (storage.sessionHasUnfinishedRuns(sessionId)) throw new ProtocolError("conflict", "Finish or stop the current task before switching agents; your conversation will stay here.");
      if (agentId) {
        const manifest = agents.catalog.get(agentId);
        if (manifest.transport === "pty") throw new ProtocolError("invalid_params", `${manifest.displayName} runs in a separate terminal, not a chat`);
        agents.catalog.command(manifest); // Refuse an unavailable binary before changing the session.
      }
      const updated = storage.setSessionAgent(sessionId, agentId);
      storage.appendEvent({ sessionId, type: "session.updated", payload: { session: updated } });
      return { session: updated };
    }),
    "session.archive": ({ archived, ...params }) => editSession({ ...params, state: archived ? "archived" : "open" }),
    "session.delete": (params) => editSession({ ...params, deleted: true }),
    "session.page": ({ sessionId, beforeOrdinal, limit }) => storage.transaction(() => {
      const session = storage.getSession(sessionId);
      if (!session) throw new ProtocolError("not_found", `unknown session ${sessionId}`);
      const { messages, hasOlder } = storage.listMessagesForSession(sessionId, { beforeOrdinal, limit });
      const pendingPermissions = storage.pendingPermissionsForSession(sessionId).map(permission => ({ permissionId: permission.id, runId: permission.runId, workspaceId: permission.workspaceId, tool: permission.tool, summary: permission.request.summary ?? permission.tool, ...(permission.request.argv ? { argv: permission.request.argv } : {}), ...(permission.request.script ? { script: permission.request.script } : {}), cwd: permission.request.cwd ?? ".", isolation: "none", revision: permission.revision }));
      return { session, messages, runs: storage.listRunsForSession(sessionId), pendingPermissions, hasOlder, cursor: storage.maxSeq() };
    }),
    "run.start": async (params) => {
      const existing = storage.findRunByRequest(params.sessionId, params.requestId);
      if (existing) return { run: existing, deduplicated: true };
      const resolved = tasks ? await tasks.resolve(params.prompt) : { references: [], assertCurrent() {} };
      resolved.assertCurrent();
      params = { ...params, taskReferences: resolved.references };
      // "@codex …" at the start of a message calls that agent into this conversation for one turn (§6.5).
      const session = storage.getSession(params.sessionId);
      const named = params.execution?.preset ? { agentId: SELF_MENTION } : params.execution?.agentId ? { agentId: params.execution.agentId } : routeFor({ prompt: params.prompt, catalog: agents.catalog, sessionAgentId: session?.agentId ?? null });
      if (!named) return runs.start(params);
      if (named.agentId !== SELF_MENTION) {
        const manifest = agents.catalog.get(named.agentId); // throws when a client names an agent that is gone
        if (manifest.transport === "pty") throw new ProtocolError("invalid_params", `${manifest.displayName} runs in a terminal and cannot answer a task`);
      } else if (!session?.agentId) {
        return runs.start(params); // Jolo already answers here
      }
      return runs.start({ ...params, execution: { ...(params.execution ?? {}), agentId: named.agentId } });
    },
    "run.cancel": (params) => ({ run: runs.cancel(params) }),
    "run.sendNow": (params, conn) => { requireInteractive(conn); return { run: runs.sendNow(params) }; },
    "run.snapshot": ({ runId }) => runs.snapshot(runId),
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
      return { permissionId: permission.id, decision: permission.decision, revision: permission.revision, runId: permission.runId };
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
    try { return await handler(...args); }
    finally { inFlight--; }
  }]));
}
