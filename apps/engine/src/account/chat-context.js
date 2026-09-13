import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { ProtocolError } from '@jolo/protocol';

const mapKey = identity => `chat-sync-folders:${identity}`;
const sessionKey = id => `chat-sync-context:${id}`;
const folderKey = id => `chat-sync-folder:${id}`;
const safeName = name => name.replace(/[^\p{L}\p{N}._ -]/gu, '_').replace(/^\.+$/, '_').slice(0, 60) || 'Project';
const loadMap = (storage, identity) => storage.getPreference(mapKey(identity)) ?? { projects: {}, workspaces: {} };

export function exportChatContext(storage, identity, session) {
  const remembered = storage.getPreference(sessionKey(session.id));
  if (remembered?.identity === identity && remembered.projectId === session.projectId && remembered.workspaceId === session.workspaceId) return remembered.context;
  const project = storage.getProject(session.projectId), workspace = storage.getWorkspace(session.workspaceId);
  if (project.preferences.standalone) return null;
  const map = loadMap(storage, identity);
  const projectId = Object.keys(map.projects).find(id => map.projects[id] === project.id) ?? randomUUID();
  const workspaceId = Object.keys(map.workspaces).find(id => map.workspaces[id] === workspace.id) ?? randomUUID();
  map.projects[projectId] = project.id; map.workspaces[workspaceId] = workspace.id;
  storage.setPreference(mapKey(identity), map);
  const context = { project: { id: projectId, name: path.basename(project.rootPath) || 'Project' }, workspace: { id: workspaceId, name: path.basename(workspace.path) || 'Folder', mode: workspace.mode, branch: workspace.branch } };
  rememberChatContext(storage, identity, session.id, context);
  return context;
}

export function restoreChatContext(storage, paths, identity, context) {
  const map = loadMap(storage, identity);
  const account = createHash('sha256').update(identity).digest('hex').slice(0, 24);
  let project = map.projects[context.project.id] && storage.getProject(map.projects[context.project.id]);
  if (!project) {
    const directory = path.join(paths.dataDir, 'synced-projects', account, context.project.id, safeName(context.project.name));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const root = realpathSync(directory);
    project = storage.upsertProject({ identity: root, rootPath: root });
    storage.setProjectPreferences(project.id, { syncPlaceholder: true });
    map.projects[context.project.id] = project.id;
  }
  let workspace = map.workspaces[context.workspace.id] && storage.getWorkspace(map.workspaces[context.workspace.id]);
  if (workspace && workspace.projectId !== project.id) throw new ProtocolError('conflict', 'Synced folder belongs to a different project.');
  if (!workspace || workspace.removedAt) {
    // Placeholder directories only hold the association. They never grant access
    // to the source device's path or become an agent's working directory.
    const directory = path.join(paths.dataDir, 'synced-folders', account, context.workspace.id, safeName(context.workspace.name));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const root = realpathSync(directory);
    workspace = storage.insertWorkspace({ projectId: project.id, mode: context.workspace.mode, path: root, branch: context.workspace.branch });
    storage.setPreference(folderKey(workspace.id), { needsFolder: true, identity, context });
    map.workspaces[context.workspace.id] = workspace.id;
  }
  storage.setPreference(mapKey(identity), map);
  return { projectId: project.id, workspaceId: workspace.id };
}

export function rememberChatContext(storage, identity, sessionId, context) {
  const session = storage.getSession(sessionId);
  storage.setPreference(sessionKey(sessionId), { identity, context, projectId: session.projectId, workspaceId: session.workspaceId });
}

/** Bind only a user-selected local folder. Existing local project/task ids survive. */
export function linkChatFolder({ storage, permissions, workspaceId, folder }) {
  const pending = storage.getPreference(folderKey(workspaceId));
  if (!pending?.needsFolder) throw new ProtocolError('conflict', 'This folder is already linked.');
  let root;
  try { root = realpathSync(folder); if (!statSync(root).isDirectory()) throw new Error(); }
  catch { throw new ProtocolError('not_found', 'Choose an existing local folder.'); }
  return storage.transaction(() => {
    const workspace = storage.getWorkspace(workspaceId);
    if (!workspace || workspace.removedAt) throw new ProtocolError('not_found', 'Folder no longer exists.');
    const source = storage.getProject(workspace.projectId);
    if (storage.listWorkspaces(source.id).some(w => storage.workspaceHasUnfinishedRuns(w.id))) throw new ProtocolError('conflict', 'Finish active tasks before linking this folder.');
    let target = source;
    const map = loadMap(storage, pending.identity);
    if (source.preferences.syncPlaceholder) {
      target = storage.listProjects().find(p => p.rootPath === root && p.id !== source.id && !p.preferences.standalone && !p.preferences.syncPlaceholder) ?? source;
      if (target.id !== source.id) {
        storage.db.query('UPDATE sessions SET project_id=?2 WHERE project_id=?1').run(source.id, target.id);
        storage.db.query('UPDATE workspaces SET project_id=?2 WHERE project_id=?1').run(source.id, target.id);
        storage.setProjectPreferences(source.id, { ...source.preferences, redirectProjectId: target.id });
        for (const id of Object.keys(map.projects)) if (map.projects[id] === source.id) map.projects[id] = target.id;
      } else {
        storage.db.query('UPDATE projects SET root_path=?2 WHERE id=?1').run(source.id, root);
        storage.setProjectPreferences(source.id, { ...source.preferences, syncPlaceholder: false });
      }
    }
    const existing = storage.listWorkspaces(target.id).find(w => w.id !== workspaceId && w.path === root && !w.needsFolder);
    let linkedId = workspaceId;
    if (existing) {
      linkedId = existing.id;
      storage.db.query('UPDATE sessions SET workspace_id=?2 WHERE workspace_id=?1').run(workspaceId, linkedId);
      storage.markWorkspaceRemoved(workspaceId);
      for (const id of Object.keys(map.workspaces)) if (map.workspaces[id] === workspaceId) map.workspaces[id] = linkedId;
    } else storage.db.query('UPDATE workspaces SET path=?2 WHERE id=?1').run(workspaceId, root);
    storage.setPreference(folderKey(workspaceId), { ...pending, needsFolder: false });
    // A deliberate link joins the local and synced project identities. Existing
    // local chats receive that association too, so a third device groups them.
    map.projects = { [pending.context.project.id]: target.id, ...map.projects };
    map.workspaces = { [pending.context.workspace.id]: linkedId, ...map.workspaces };
    storage.setPreference(mapKey(pending.identity), map);
    permissions.grantInspect(linkedId);
    for (const session of storage.db.query('SELECT id FROM sessions WHERE project_id=?1').all(target.id)) {
      const record = storage.getSession(session.id);
      const remembered = storage.getPreference(sessionKey(session.id));
      if (!remembered || remembered.identity === pending.identity) {
        const context = exportChatContext(storage, pending.identity, record);
        rememberChatContext(storage, pending.identity, session.id, { ...context, project: pending.context.project, ...(record.workspaceId === linkedId ? { workspace: pending.context.workspace } : {}) });
      }
      storage.appendEvent({ sessionId: session.id, type: 'session.updated', payload: { session: storage.getSession(session.id) } });
    }
    return { rootPath: storage.getProject(target.id).rootPath, workspaceId: linkedId };
  });
}
