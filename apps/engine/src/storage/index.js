import { parseEvent } from "@jolo/protocol";
import { PermissionRepository } from "./permissions.js";
import { PlanRepository } from "./plans.js";
// Storage service: the only module that touches SQLite.
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { acquireDatabase, migrate, migrationBackup } from "./db.js";
import { migrations as embeddedMigrations } from "../../../../migrations/index.js";
import { EventRepository } from "./events.js";
import { ArtifactStore } from "./artifacts.js";

export { OwnershipError, SchemaError } from "./db.js";

export { newId } from "./records.js";
import { newId, now, mapSession, mapRun, mapProject, mapMessage, mapItem, mapInvocation, mapWorkspace, mapArtifact } from "./records.js";

export class Storage {
  /**
   * @param {{ databasePath: string, artifactsDir: string, migrationsDir: string, bootId: string }} options
   */
  constructor(options) {
    this.bootId = options.bootId;
    mkdirSync(path.dirname(options.databasePath), { recursive: true, mode: 0o700 });
    mkdirSync(options.artifactsDir, { recursive: true, mode: 0o700 });
    this.db = acquireDatabase(options.databasePath, { bootId: options.bootId });
    try {
    this.schema = migrate(this.db, options.migrationsDir ?? embeddedMigrations, { beforeMigrate: versions => migrationBackup(this.db, options.databasePath, versions) });
    this.artifacts = new ArtifactStore(options.artifactsDir);
    this.permissionRepository = new PermissionRepository(this);
    this.plans = new PlanRepository(this);
    this.eventRepository = new EventRepository(this.db);
    this.eventRepository.bootstrap();
    this.eventRepository.prune();
    this.eventStreamId = this.getPreference("event-stream-id") ?? newId("stream");
    this.setPreference("event-stream-id", this.eventStreamId);
    this.events = new EventEmitter();
    this.depth = 0;
    /** @type {any[]} */
    this.pendingEvents = [];
    this.commitCallbacks = [];
    this.flushingEvents = false;
    this.statements = {
      insertEvent: this.db.query("INSERT INTO events (session_id, run_id, type, payload, at) VALUES (?1, ?2, ?3, ?4, ?5)"),
      maxSeq: this.db.query("SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='events'), 0) AS seq"),
      minSeq: this.db.query("SELECT COALESCE(MIN(seq), 0) AS seq FROM events"),
      getSession: this.db.query("SELECT * FROM sessions WHERE id = ?1 AND deleted_at IS NULL"),
      getRun: this.db.query("SELECT * FROM runs WHERE id = ?1"),
      getRunByRequest: this.db.query("SELECT * FROM runs WHERE session_id = ?1 AND request_id = ?2"),
      getArtifact: this.db.query("SELECT * FROM artifacts WHERE id = ?1"),
      getMessage: this.db.query("SELECT * FROM messages WHERE id = ?1"),
    };
    } catch (error) { try { this.artifacts?.closeAll(); } catch {} this.db.close(); throw error; }
  }

  /** Run `fn` in one transaction; durable events are published only after the outermost commit. */
  transaction(fn) {
    const eventMark = this.pendingEvents.length;
    const callbackMark = this.commitCallbacks.length;
    this.depth += 1;
    let result;
    try {
      result = this.db.transaction(fn)();
    } catch (error) {
      this.pendingEvents.length = eventMark;
      this.commitCallbacks.length = callbackMark;
      throw error;
    } finally {
      this.depth -= 1;
    }
    if (this.depth === 0) this.flushEvents();
    return result;
  }

  afterCommit(fn) {
    if (this.depth || this.flushingEvents) this.commitCallbacks.push(fn);
    else fn();
  }

  flushEvents() {
    if (this.flushingEvents) return;
    this.flushingEvents = true;
    try {
      // A listener may commit more events. Drain in sequence order before callbacks.
      while (this.pendingEvents.length || this.commitCallbacks.length) {
        while (this.pendingEvents.length) {
          const event = this.pendingEvents.shift();
          for (const listener of this.events.rawListeners("event")) {
            try { listener.call(this.events, event); }
            catch (error) { console.error("durable event listener failed", error); }
          }
        }
        const callback = this.commitCallbacks.shift();
        if (callback) {
          try { callback(); } catch (error) { console.error("post-commit callback failed", error); }
        }
      }
    } finally { this.flushingEvents = false; }
  }

  /** Append a durable event inside the current transaction (or its own if none is open). */
  appendEvent({ sessionId = null, runId = null, type, payload }) {
    const write = () => {
      const at = now();
      const checked = parseEvent({ engineBootId: this.bootId, eventSeq: "0", sessionId, runId, type, payload, at });
      if (!checked.ok) throw checked.error; // invalid durable events must roll back, never poison replay
      const info = this.statements.insertEvent.run(sessionId, runId, type, JSON.stringify(payload), at);
      const event = { engineBootId: this.bootId, eventSeq: String(info.lastInsertRowid), sessionId, runId, type, payload, at };
      this.eventRepository.project(event);
      if (Number(event.eventSeq) % 1000 === 0) this.eventRepository.prune();
      this.pendingEvents.push(event);
      return event;
    };
    if (this.depth > 0) return write();
    return this.transaction(write);
  }

  maxSeq() {
    return String(this.statements.maxSeq.get().seq);
  }

  minRetainedSeq() {
    return String(this.statements.minSeq.get().seq);
  }

  listEvents({ after = "0", sessionId, limit = 100 }) {
    const rows = sessionId
      ? this.db.query("SELECT * FROM events WHERE seq > ?1 AND session_id = ?2 ORDER BY seq LIMIT ?3").all(Number(after), sessionId, limit)
      : this.db.query("SELECT * FROM events WHERE seq > ?1 ORDER BY seq LIMIT ?2").all(Number(after), limit);
    return rows.map((r) => ({ engineBootId: this.bootId, eventSeq: String(r.seq), sessionId: r.session_id, runId: r.run_id, type: r.type, payload: JSON.parse(r.payload), at: r.at }));
  }

  /** Artifact byte access is always clamped to durable committed lengths. */
  readArtifact(artifact, offset, length, committedBytes = artifact.committedBytes) {
    return this.artifacts.read(artifact.storageKey, offset, length, Math.min(committedBytes, artifact.committedBytes));
  }

  openArtifactWriter(artifact) { return this.artifacts.openWriter(artifact.storageKey); }

  /** Maintenance preserves all referenced history and removes only proven orphans. */
  maintain() {
    this.eventRepository.prune();
    this.db.query("UPDATE grants SET expires_at=?1 WHERE json_extract(constraints,'$.runId') IS NOT NULL AND (expires_at IS NULL OR expires_at>?1) AND NOT EXISTS (SELECT 1 FROM runs WHERE id=json_extract(grants.constraints,'$.runId') AND state NOT IN ('completed','failed','cancelled','interrupted'))").run(now());
    const threshold = new Date(Date.now() - 30 * 86_400_000).toISOString();
    this.db.query("DELETE FROM grants WHERE expires_at < ?1 AND NOT EXISTS (SELECT 1 FROM permissions WHERE grant_id=grants.id) AND NOT EXISTS (SELECT 1 FROM invocations WHERE grant_id=grants.id)").run(threshold);
    const keys = new Set(this.db.query("SELECT storage_key FROM artifacts").all().map(row => row.storage_key));
    return { orphanFilesRemoved: this.artifacts.purgeOrphans(keys) };
  }

  /** Consistent SQLite backup. Artifact bytes are immutable below committed lengths;
   * callers must copy the artifact tree as well for a complete profile backup. */
  backup(destination) {
    if (this.depth) throw new Error("backup cannot run inside a transaction");
    this.db.query("VACUUM INTO ?1").run(destination);
  }

  // ---- projects and workspaces ------------------------------------------------------------

  upsertProject({ identity, rootPath }) {
    const existing = this.db.query("SELECT * FROM projects WHERE identity = ?1").get(identity);
    if (existing) {
      this.db.query("UPDATE projects SET root_path = ?1, updated_at = ?2 WHERE id = ?3").run(rootPath, now(), existing.id);
      return { id: existing.id, identity, rootPath, created: false };
    }
    const id = newId("prj");
    const at = now();
    this.db.query("INSERT INTO projects (id, identity, root_path, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)").run(id, identity, rootPath, at);
    return { id, identity, rootPath, created: true };
  }

  listProjects() {
    return this.db.query("SELECT * FROM projects ORDER BY updated_at DESC").all().map(mapProject);
  }

  getProject(id) {
    return mapProject(this.db.query("SELECT * FROM projects WHERE id = ?1").get(id));
  }

  getProjectPreferences(id) {
    return this.getProject(id)?.preferences ?? {};
  }

  setProjectPreferences(id, preferences) {
    this.db.query("UPDATE projects SET preferences = ?1, updated_at = ?2 WHERE id = ?3").run(JSON.stringify(preferences), now(), id);
  }

  /** The user looked at this workspace's latest outcome; "done since you last looked" clears (§4.1 board). */
  touchWorkspaceViewed(id) {
    const at = now();
    this.db.query("UPDATE workspaces SET last_viewed_at = ?1 WHERE id = ?2").run(at, id);
    return at;
  }

  directWorkspace(projectId) {
    return mapWorkspace(this.db.query("SELECT * FROM workspaces WHERE project_id = ?1 AND mode = 'direct' ORDER BY created_at LIMIT 1").get(projectId));
  }

  insertWorkspace({ projectId, mode, path: workspacePath, branch = null, baseCommit = null, owned = false }) {
    const id = newId("wsp");
    this.db.query("INSERT INTO workspaces (id, project_id, mode, path, branch, base_commit, owned, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)").run(id, projectId, mode, workspacePath, branch, baseCommit, owned ? 1 : 0, now());
    return this.getWorkspace(id);
  }

  /** Live workspaces of a project: the direct checkout first, then worktrees in creation order. */
  listWorkspaces(projectId) {
    return this.db.query("SELECT * FROM workspaces WHERE project_id = ?1 AND removed_at IS NULL ORDER BY CASE mode WHEN 'direct' THEN 0 ELSE 1 END, created_at").all(projectId).map(mapWorkspace);
  }

  /** Any workspace ever recorded at this path, removed ones included: proof that a checkout was handed over. */
  workspaceAtPath(workspacePath) {
    const row = this.db.query("SELECT * FROM workspaces WHERE path = ?1 LIMIT 1").get(workspacePath);
    return row ? mapWorkspace(row) : null;
  }

  markWorkspaceRemoved(id) {
    this.db.query("UPDATE workspaces SET removed_at = ?1 WHERE id = ?2").run(now(), id);
  }

  countSessionsForWorkspace(workspaceId) {
    return this.db.query("SELECT COUNT(*) AS n FROM sessions WHERE workspace_id = ?1 AND deleted_at IS NULL").get(workspaceId).n;
  }

  workspaceHasUnfinishedRuns(workspaceId) {
    return Boolean(this.db.query("SELECT 1 FROM runs r JOIN sessions s ON s.id = r.session_id WHERE s.workspace_id = ?1 AND r.state NOT IN ('completed', 'failed', 'cancelled', 'interrupted') LIMIT 1").get(workspaceId));
  }

  /** Newest run in any open, non-deleted session of a workspace; null when nothing ran there. */
  /**
   * The run a board row speaks for: one still holding a question for the user, oldest first, else the newest.
   * A newer task must not hide an older one that cannot move until someone answers it.
   */
  boardRunForWorkspace(workspaceId) {
    const open = "FROM runs r JOIN sessions s ON s.id = r.session_id WHERE s.workspace_id = ?1 AND s.deleted_at IS NULL AND s.state = 'open'";
    const waiting = this.db.query(`SELECT r.*, s.title AS session_title ${open} AND r.state IN ('awaiting_permission', 'paused') ORDER BY r.created_at LIMIT 1`).get(workspaceId);
    const r = waiting ?? this.db.query(`SELECT r.*, s.title AS session_title ${open} ORDER BY r.created_at DESC LIMIT 1`).get(workspaceId);
    return r ? { run: this.runRecord(r), sessionTitle: r.session_title } : null;
  }

  ensureDirectWorkspace(projectId, workspacePath) {
    const existing = this.db.query("SELECT * FROM workspaces WHERE project_id = ?1 AND mode = 'direct' AND path = ?2").get(projectId, workspacePath);
    if (existing) return { id: existing.id, projectId, mode: "direct", path: workspacePath };
    const id = newId("wsp");
    this.db.query("INSERT INTO workspaces (id, project_id, mode, path, created_at) VALUES (?1, ?2, 'direct', ?3, ?4)").run(id, projectId, workspacePath, now());
    return { id, projectId, mode: "direct", path: workspacePath };
  }

  // ---- sessions -------------------------------------------------------------------------------

  createSession({ projectId, workspaceId, title, agentId = null, planTaskId = null }) {
    const id = newId("ses");
    const at = now();
    this.db.query("INSERT INTO sessions (id, project_id, workspace_id, title, agent_id, plan_task_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)").run(id, projectId, workspaceId, title, agentId, planTaskId, at);
    return this.getSession(id);
  }

  /** What a hosted agent's adapter needs to continue its conversation next turn (for Claude Code, its session id). */
  setSessionAgentState(id, state) {
    this.db.query("UPDATE sessions SET agent_state = ?1 WHERE id = ?2").run(JSON.stringify(state), id);
  }

  setSessionAgent(id, agentId) {
    // Native continuation IDs belong to one agent. A switch starts that agent
    // with the shared transcript, while retaining the Jolo session itself.
    const handoff = this.getSession(id)?.agentState?._jolo;
    this.db.query("UPDATE sessions SET agent_id = ?1, agent_state = ?2, updated_at = ?3, revision = revision + 1 WHERE id = ?4").run(agentId, JSON.stringify(handoff ? { _jolo: handoff } : {}), now(), id);
    return this.getSession(id);
  }

  getSession(id) {
    return mapSession(this.statements.getSession.get(id));
  }

  listSessions({ projectId, limit, state = "open" }) {
    const rows = projectId
      ? this.db.query("SELECT * FROM sessions WHERE project_id = ?1 AND state = ?3 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?2").all(projectId, limit, state)
      : this.db.query("SELECT * FROM sessions WHERE state = ?2 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?1").all(limit, state);
    return rows.map(mapSession);
  }

  /**
   * Every open task across every project, newest activity first, with the project and checkout it belongs to
   * and its most recent run. One query, so a sidebar listing all projects costs the same as listing one.
   */
  listSessionActivity({ limit = 200, state = "open" } = {}) {
    const rows = this.db.query(`
      SELECT s.*, p.root_path AS project_root, w.branch AS workspace_branch, w.mode AS workspace_mode, w.last_viewed_at AS workspace_last_viewed_at, w.removed_at AS workspace_removed_at,
             r.id AS run_id, r.state AS run_state, r.pause_reason AS run_pause_reason, r.created_at AS run_created_at, r.updated_at AS run_updated_at, r.note AS run_note
      FROM sessions s
      JOIN projects p ON p.id = s.project_id
      JOIN workspaces w ON w.id = s.workspace_id
      LEFT JOIN runs r ON r.id = (SELECT id FROM runs WHERE session_id = s.id ORDER BY created_at DESC LIMIT 1)
      WHERE s.deleted_at IS NULL AND s.state = ?1 AND w.removed_at IS NULL
      ORDER BY COALESCE(r.updated_at, s.updated_at) DESC
      LIMIT ?2
    `).all(state, limit);
    return rows.map((row) => ({
      session: mapSession(row),
      projectRootPath: row.project_root,
      workspace: { id: row.workspace_id, branch: row.workspace_branch ?? null, mode: row.workspace_mode, lastViewedAt: row.workspace_last_viewed_at ?? null },
      run: row.run_id ? { id: row.run_id, sessionId: row.id, state: row.run_state, pauseReason: row.run_pause_reason ?? null, createdAt: row.run_created_at, updatedAt: row.run_updated_at, note: row.run_note ? JSON.parse(row.run_note) : null } : null,
    }));
  }

  updateSession(id, { title, state, deleted = false }) {
    this.db.query("UPDATE sessions SET title = COALESCE(?2, title), state = COALESCE(?3, state), deleted_at = CASE WHEN ?4 THEN ?5 ELSE deleted_at END, updated_at = ?5, revision = revision + 1 WHERE id = ?1")
      .run(id, title ?? null, state ?? null, deleted ? 1 : 0, now());
    return this.getSession(id);
  }

  sessionHasUnfinishedRuns(id) {
    return Boolean(this.db.query("SELECT 1 FROM runs WHERE session_id = ?1 AND state NOT IN ('completed', 'failed', 'cancelled', 'interrupted') LIMIT 1").get(id));
  }

  bumpSessionRevision(id) {
    this.db.query("UPDATE sessions SET revision = revision + 1, updated_at = ?1 WHERE id = ?2").run(now(), id);
    return this.getSession(id);
  }

  // ---- runs -----------------------------------------------------------------------------------

  runRecord(row) {
    const run = mapRun(row);
    if (run) run.taskReferences = this.getRunTaskReferences(run.id).map(({description, ...summary}) => summary);
    return run;
  }

  getRunTaskReferences(runId) {
    return this.db.query('SELECT payload FROM run_task_references WHERE run_id=?1 ORDER BY position').all(runId).map(row => JSON.parse(row.payload));
  }

  insertRun({ sessionId, requestId, prompt, execution = null, attachments = [], taskReferences = [] }) {
    const id = newId("run");
    const at = now();
    this.db.query("INSERT INTO runs (id, session_id, request_id, state, prompt, execution, attachments, created_at, updated_at) VALUES (?1, ?2, ?3, 'queued', ?4, ?5, ?6, ?7, ?7)")
      .run(id, sessionId, requestId, prompt, execution ? JSON.stringify(execution) : null, JSON.stringify(attachments), at);
    taskReferences.forEach((ref, position) => this.db.query('INSERT INTO run_task_references(run_id,position,payload) VALUES (?1,?2,?3)').run(id,position,JSON.stringify(ref)));
    return this.getRun(id);
  }

  getRun(id) {
    return this.runRecord(this.statements.getRun.get(id));
  }

  findRunByRequest(sessionId, requestId) {
    return this.runRecord(this.statements.getRunByRequest.get(sessionId, requestId));
  }

  /** Transition with a monotonically increasing revision; stale expectations are rejected by callers. */
  updateRunState(id, state, { pauseReason = null, failure = null, newAttempt = false } = {}) {
    const attempt = newAttempt ? ", attempt = attempt + 1" : "";
    this.db.query(`UPDATE runs SET state = ?1, revision = revision + 1, pause_reason = ?2, failure = ?3, updated_at = ?4${attempt} WHERE id = ?5`).run(state, pauseReason, failure, now(), id);
    return this.getRun(id);
  }

  /** Newest run in any open, non-deleted session of a project; null when the project has no runs. */
  latestRunForProject(projectId) {
    const r = this.db.query("SELECT r.*, s.title AS session_title FROM runs r JOIN sessions s ON s.id = r.session_id WHERE s.project_id = ?1 AND s.deleted_at IS NULL AND s.state = 'open' ORDER BY r.created_at DESC LIMIT 1").get(projectId);
    return r ? { run: this.runRecord(r), sessionTitle: r.session_title } : null;
  }

  setRunNote(runId, note) {
    this.db.query("UPDATE runs SET note = ?1 WHERE id = ?2").run(JSON.stringify(note), runId);
  }

  /** Last `limit` tool invocations of a run in start order, with their completion status when known. */
  recentToolActivity(runId, limit = 3) {
    return this.eventRepository.recentTools(runId, limit);
  }

  changedPathsForRun(runId) { return this.eventRepository.changedPaths(runId); }
  lastEventAtForRun(runId) { return this.eventRepository.lastAt(runId); }


  listRunsByState(states) {
    const placeholders = states.map((_, i) => `?${i + 1}`).join(", ");
    return this.db.query(`SELECT * FROM runs WHERE state IN (${placeholders}) ORDER BY created_at`).all(...states).map(row => this.runRecord(row));
  }

  // ---- artifacts and messages ----------------------------------------------------------------

  createArtifact({ sessionId, kind, extension = '' }) {
    if (extension && !['.png', '.jpg', '.gif', '.webp'].includes(extension)) throw new Error('unsupported artifact extension');
    const id = newId("art");
    const storageKey = `${sessionId}/${id}${extension}`;
    this.db.query("INSERT INTO artifacts (id, session_id, kind, storage_key, created_at) VALUES (?1, ?2, ?3, ?4, ?5)").run(id, sessionId, kind, storageKey, now());
    return mapArtifact(this.statements.getArtifact.get(id));
  }

  getArtifact(id) {
    return mapArtifact(this.statements.getArtifact.get(id));
  }

  commitArtifactBytes(id, committedBytes) {
    this.db.query("UPDATE artifacts SET committed_bytes = ?1 WHERE id = ?2").run(committedBytes, id);
  }

  finalizeArtifact(id, committedBytes, hash) {
    this.db.query("UPDATE artifacts SET committed_bytes = ?1, finalized_hash = ?2 WHERE id = ?3").run(committedBytes, hash, id);
  }

  nextMessageOrdinal(sessionId) {
    return this.db.query("SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal FROM messages WHERE session_id = ?1").get(sessionId).ordinal;
  }

  insertMessage({ sessionId, runId, role, kind = "text", artifactId, ordinal }) {
    const id = newId("msg");
    this.db.query("INSERT INTO messages (id, session_id, run_id, ordinal, role, kind, artifact_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)").run(id, sessionId, runId, ordinal, role, kind, artifactId, now());
    return this.getMessage(id);
  }

  getWorkspace(id) {
    return mapWorkspace(this.db.query("SELECT * FROM workspaces WHERE id = ?1").get(id));
  }

  // ---- preferences ----------------------------------------------------------------------------

  getPreference(key) {
    const row = this.db.query("SELECT value FROM preferences WHERE key = ?1").get(key);
    return row ? JSON.parse(row.value) : undefined;
  }

  setPreference(key, value) {
    this.db.query("INSERT INTO preferences (key, version, value) VALUES (?1, 1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value, version = preferences.version + 1").run(key, JSON.stringify(value));
  }

  // ---- conversation items (provider-facing transcript) ------------------------------------

  insertItem({ sessionId, runId = null, kind, groupId, payload, messageId = null, invocationId = null, payloadArtifactId = null }) {
    const id = newId("itm");
    const ordinal = this.db.query("SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal FROM conversation_items WHERE session_id = ?1").get(sessionId).ordinal;
    this.db.query("INSERT INTO conversation_items (id, session_id, run_id, ordinal, kind, group_id, message_id, invocation_id, payload, payload_artifact_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)")
      .run(id, sessionId, runId, ordinal, kind, groupId, messageId, invocationId, JSON.stringify(payload), payloadArtifactId, now());
    return mapItem(this.db.query("SELECT * FROM conversation_items WHERE id = ?1").get(id));
  }

  listItems(sessionId, { afterOrdinal } = {}) {
    if (afterOrdinal === undefined) return this.db.query("SELECT * FROM conversation_items WHERE session_id = ?1 ORDER BY ordinal").all(sessionId).map(mapItem);
    return this.db.query("SELECT * FROM conversation_items WHERE session_id = ?1 AND ordinal > ?2 ORDER BY ordinal").all(sessionId, afterOrdinal).map(mapItem);
  }

  /** Latest checkpoint for a session: the provider-facing transcript starts after its ordinal (§7.2). */
  latestCheckpoint(sessionId) {
    const r = this.db.query("SELECT * FROM checkpoints WHERE session_id = ?1 ORDER BY through_ordinal DESC LIMIT 1").get(sessionId);
    return r && { id: r.id, sessionId: r.session_id, throughOrdinal: r.through_ordinal, summaryArtifactId: r.summary_artifact_id, providerState: r.provider_state ? JSON.parse(r.provider_state) : null, contextVersion: r.context_version, createdAt: r.created_at };
  }

  insertCheckpoint({ sessionId, throughOrdinal, summaryArtifactId, providerState = null, contextVersion = 1 }) {
    const id = newId("ckp");
    this.db.query("INSERT INTO checkpoints (id, session_id, through_ordinal, summary_artifact_id, provider_state, context_version, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)").run(id, sessionId, throughOrdinal, summaryArtifactId, providerState ? JSON.stringify(providerState) : null, contextVersion, now());
    return this.latestCheckpoint(sessionId);
  }

  // ---- invocations ----------------------------------------------------------------------------

  insertInvocation({ runId, providerCallId, name, argumentDigest, grantId, argumentArtifactId = null }) {
    const id = newId("inv");
    const at = now();
    this.db.query("INSERT INTO invocations (id, run_id, provider_call_id, name, argument_digest, argument_artifact_id, grant_id, state, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'admitted', ?8, ?8)")
      .run(id, runId, providerCallId, name, argumentDigest, argumentArtifactId, grantId, at);
    return this.getInvocation(id);
  }

  getInvocation(id) {
    return mapInvocation(this.db.query("SELECT * FROM invocations WHERE id = ?1").get(id));
  }

  updateInvocation(id, { state, exitData = null, resultArtifactId = null }) {
    this.db.query("UPDATE invocations SET state = ?1, exit_data = ?2, result_artifact_id = COALESCE(?3, result_artifact_id), updated_at = ?4 WHERE id = ?5").run(state, exitData ? JSON.stringify(exitData) : null, resultArtifactId, now(), id);
    return this.getInvocation(id);
  }

  listInvocationsForRun(runId) {
    return this.db.query("SELECT * FROM invocations WHERE run_id = ?1 ORDER BY created_at, id").all(runId).map(mapInvocation);
  }

  // ---- grants ---------------------------------------------------------------------------------

  findGrant(...args) { return this.permissionRepository.findGrant(...args); }
  findStandingGrant(...args) { return this.permissionRepository.findStandingGrant(...args); }

  insertGrant(...args) { return this.permissionRepository.insertGrant(...args); }

  // ---- plans ----------------------------------------------------------------------------------
  // A plan holds ordered tasks; a task holds the tries made at it. Reads are small and indexed, because the
  // board and the plan view ask for them on every refresh.

  insertPlan(...args) { return this.plans.insertPlan(...args); }

  getPlan(...args) { return this.plans.getPlan(...args); }

  listPlans(...args) { return this.plans.listPlans(...args); }

  listPlansByState(...args) { return this.plans.listPlansByState(...args); }

  /** How many tasks a plan holds in each state, for a list that should not have to read every task. */
  planTaskCounts(...args) { return this.plans.planTaskCounts(...args); }

  updatePlanState(...args) { return this.plans.updatePlanState(...args); }

  insertPlanTask(...args) { return this.plans.insertPlanTask(...args); }

  getPlanTask(...args) { return this.plans.getPlanTask(...args); }

  listPlanTasks(...args) { return this.plans.listPlanTasks(...args); }

  /** The next task a running plan should carry out: the first still pending, in the order the user wrote. */
  nextPlanTask(...args) { return this.plans.nextPlanTask(...args); }

  updatePlanTask(...args) { return this.plans.updatePlanTask(...args); }

  updatePlanTaskState(...args) { return this.plans.updatePlanTaskState(...args); }

  deletePlanTask(...args) { return this.plans.deletePlanTask(...args); }

  insertPlanExecution(...args) { return this.plans.insertPlanExecution(...args); }

  getPlanExecution(...args) { return this.plans.getPlanExecution(...args); }

  planExecutionForRun(...args) { return this.plans.planExecutionForRun(...args); }

  listPlanExecutions(...args) { return this.plans.listPlanExecutions(...args); }

  countPlanExecutions(...args) { return this.plans.countPlanExecutions(...args); }

  /** The run that is carrying out this try, recorded once the run service has admitted it. */
  setPlanExecutionRun(...args) { return this.plans.setPlanExecutionRun(...args); }

  finishPlanExecution(...args) { return this.plans.finishPlanExecution(...args); }

  // ---- permissions ------------------------------------------------------------------------

  insertPermission(...args) { return this.permissionRepository.insertPermission(...args); }

  getPermission(...args) { return this.permissionRepository.getPermission(...args); }

  resolvePermission(...args) { return this.permissionRepository.resolvePermission(...args); }

  pendingPermissionForRun(...args) { return this.permissionRepository.pendingPermissionForRun(...args); }

  pendingPermissionsForSession(...args) { return this.permissionRepository.pendingPermissionsForSession(...args); }

  expirePendingPermissions(...args) { return this.permissionRepository.expirePendingPermissions(...args); }

  /** Execution grants: project-wide, run-scoped, or single-use for one argument digest (§10.1). */
  findExecuteGrant(...args) { return this.permissionRepository.findExecuteGrant(...args); }

  findGrantWithLifetime(...args) { return this.permissionRepository.findGrantWithLifetime(...args); }

  expireRunGrants(...args) { return this.permissionRepository.expireRunGrants(...args); }

  countModelTurns(sessionId) {
    return this.db.query("SELECT COUNT(DISTINCT group_id) AS count FROM conversation_items WHERE session_id=?1 AND kind IN ('assistant_message','tool_call','reasoning')").get(sessionId).count;
  }

  insertPatch({ invocationId, manifestKey, status, hashes }) {
    this.db.query("INSERT INTO patches (invocation_id, manifest_key, status, hashes) VALUES (?1, ?2, ?3, ?4)").run(invocationId, manifestKey, status, JSON.stringify(hashes));
  }

  updatePatch(invocationId, { status, hashes }) {
    this.db.query("UPDATE patches SET status = ?1, hashes = COALESCE(?2, hashes) WHERE invocation_id = ?3").run(status, hashes ? JSON.stringify(hashes) : null, invocationId);
  }

  getPatch(invocationId) {
    const r = this.db.query("SELECT * FROM patches WHERE invocation_id = ?1").get(invocationId);
    return r && { invocationId: r.invocation_id, manifestKey: r.manifest_key, status: r.status, hashes: JSON.parse(r.hashes) };
  }

  listPatchesForRun(runId) {
    return this.db.query("SELECT p.*, i.name AS tool FROM patches p JOIN invocations i ON i.id = p.invocation_id WHERE i.run_id = ?1 ORDER BY i.created_at").all(runId).map((r) => ({ invocationId: r.invocation_id, tool: r.tool, manifestKey: r.manifest_key, status: r.status, hashes: JSON.parse(r.hashes) }));
  }

  expireGrant(...args) { return this.permissionRepository.expireGrant(...args); }

  updateRunUsage(runId, usage) {
    this.db.query("UPDATE runs SET usage = ?1, updated_at = ?2 WHERE id = ?3").run(JSON.stringify(usage), now(), runId);
  }

  setRunVerification(runId, verification) {
    this.db.query("UPDATE runs SET verification = ?1 WHERE id = ?2").run(JSON.stringify(verification), runId);
  }

  getMessage(id) {
    return mapMessage(this.statements.getMessage.get(id));
  }

  commitMessageBytes(id, committedBytes) {
    this.db.query("UPDATE messages SET committed_bytes = ?1 WHERE id = ?2").run(committedBytes, id);
  }

  finishMessage(id, status, committedBytes) {
    this.db.query("UPDATE messages SET status = ?1, committed_bytes = ?2 WHERE id = ?3").run(status, committedBytes, id);
    return this.getMessage(id);
  }

  listMessagesForSession(sessionId, { beforeOrdinal = Number.MAX_SAFE_INTEGER, afterOrdinal = -1, limit }) {
    const rows = this.db.query("SELECT * FROM messages WHERE session_id = ?1 AND ordinal < ?2 AND ordinal > ?3 ORDER BY ordinal DESC LIMIT ?4").all(sessionId, beforeOrdinal, afterOrdinal, limit + 1);
    const hasOlder = rows.length > limit;
    return { messages: rows.slice(0, limit).reverse().map(mapMessage), hasOlder };
  }

  lastMessageOrdinal(sessionId, runId = null) {
    const row = runId
      ? this.db.query("SELECT MAX(ordinal) AS ordinal FROM messages WHERE session_id = ?1 AND run_id = ?2").get(sessionId, runId)
      : this.db.query("SELECT MAX(ordinal) AS ordinal FROM messages WHERE session_id = ?1").get(sessionId);
    return row.ordinal ?? -1;
  }

  /** The oldest message in a session, optionally of one role: what the conversation opened with. */
  firstMessageForSession(sessionId, { role = null } = {}) {
    const row = role
      ? this.db.query("SELECT * FROM messages WHERE session_id = ?1 AND role = ?2 ORDER BY ordinal LIMIT 1").get(sessionId, role)
      : this.db.query("SELECT * FROM messages WHERE session_id = ?1 ORDER BY ordinal LIMIT 1").get(sessionId);
    return mapMessage(row);
  }

  listRunsForSession(sessionId, limit = 50) {
    return this.db.query("SELECT * FROM runs WHERE session_id = ?1 ORDER BY created_at DESC LIMIT ?2").all(sessionId, limit).map(row => this.runRecord(row)).reverse();
  }

  listMessagesForRun(runId) {
    return this.db.query("SELECT * FROM messages WHERE run_id = ?1 ORDER BY ordinal").all(runId).map(mapMessage);
  }

  listStreamingMessages() {
    return this.db.query("SELECT * FROM messages WHERE status = 'streaming'").all().map(mapMessage);
  }

  /** Checkpoint the WAL during idle work; safe under exclusive ownership. */
  checkpoint() {
    try { this.db.exec("PRAGMA wal_checkpoint(PASSIVE)"); } catch { /* best effort */ }
  }

  close() {
    this.artifacts.closeAll();
    this.db.close();
  }
}
