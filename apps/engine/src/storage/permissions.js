// SQL for the permissions aggregate, sharing Storage's exclusive connection and transactions.
import { newId, now, mapPermission, mapGrant } from "./records.js";

export class PermissionRepository {
  constructor(storage) { this.storage = storage; this.db = storage.db; }

  findGrant({ scope, workspaceId }) {
    const row = this.db.query("SELECT * FROM grants WHERE scope = ?1 AND json_extract(constraints, '$.workspaceId') = ?2 AND (expires_at IS NULL OR expires_at > ?3) ORDER BY created_at DESC LIMIT 1").get(scope, workspaceId, now());
    return mapGrant(row);
  }

  insertGrant({ scope, constraints, expiresAt = null, policyRevision = 1 }) {
    const id = newId("grt");
    this.db.query("INSERT INTO grants (id, scope, constraints, expires_at, policy_revision, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").run(id, scope, JSON.stringify(constraints), expiresAt, policyRevision, now());
    return mapGrant(this.db.query("SELECT * FROM grants WHERE id = ?1").get(id));
  }

  findStandingGrant({ scope, workspaceId, runId }) {
    return mapGrant(this.db.query("SELECT * FROM grants WHERE scope=?1 AND json_extract(constraints,'$.workspaceId')=?2 AND (expires_at IS NULL OR expires_at>?3) AND json_extract(constraints,'$.runId') IS ?4 AND json_extract(constraints,'$.argumentDigest') IS NULL AND json_extract(constraints,'$.once') IS NOT 1 ORDER BY created_at DESC LIMIT 1").get(scope, workspaceId, now(), runId ?? null));
  }

  findExecuteGrant({ workspaceId, runId, argumentDigest, toolName }) {
    return mapGrant(this.db.query("SELECT * FROM grants WHERE scope='execute' AND json_extract(constraints,'$.workspaceId')=?1 AND (expires_at IS NULL OR expires_at>?2) AND (json_extract(constraints,'$.runId') IS NULL OR json_extract(constraints,'$.runId')=?3) AND (json_extract(constraints,'$.argumentDigest') IS NULL OR json_extract(constraints,'$.argumentDigest')=?4) AND (json_extract(constraints,'$.once') IS NOT 1 OR json_extract(constraints,'$.toolName')=?5) ORDER BY created_at DESC LIMIT 1").get(workspaceId, now(), runId ?? null, argumentDigest ?? null, toolName ?? null));
  }

  findGrantWithLifetime({ scope, workspaceId, runId }) {
    return mapGrant(this.db.query("SELECT * FROM grants WHERE scope=?1 AND json_extract(constraints,'$.workspaceId')=?2 AND (expires_at IS NULL OR expires_at>?3) AND (json_extract(constraints,'$.runId') IS NULL OR json_extract(constraints,'$.runId')=?4) ORDER BY created_at DESC LIMIT 1").get(scope, workspaceId, now(), runId ?? null));
  }

  expireRunGrants(runId) {
    this.db.query("UPDATE grants SET expires_at=?1 WHERE json_extract(constraints,'$.runId')=?2 AND (expires_at IS NULL OR expires_at>?1)").run(now(), runId);
  }

  expireGrant(id) {
    this.db.query("UPDATE grants SET expires_at = ?1 WHERE id = ?2").run(now(), id);
  }

  insertPermission({ runId, sessionId, workspaceId, tool, request }) {
    const id = newId("perm");
    this.db.query("INSERT INTO permissions (id, run_id, session_id, workspace_id, tool, request, state, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7)").run(id, runId, sessionId, workspaceId, tool, JSON.stringify(request), now());
    return this.getPermission(id);
  }

  getPermission(id) {
    return mapPermission(this.db.query("SELECT * FROM permissions WHERE id = ?1").get(id));
  }

  resolvePermission(id, { state, decision, grantId = null }) {
    this.db.query("UPDATE permissions SET state = ?1, decision = ?2, grant_id = ?3, revision = revision + 1, resolved_at = ?4 WHERE id = ?5").run(state, decision, grantId, now(), id);
    return this.getPermission(id);
  }

  pendingPermissionForRun(runId) {
    return mapPermission(this.db.query("SELECT * FROM permissions WHERE run_id = ?1 AND state = 'pending' ORDER BY created_at DESC LIMIT 1").get(runId));
  }

  pendingPermissionsForSession(sessionId) {
    return this.db.query("SELECT p.* FROM permissions p JOIN runs r ON r.id = p.run_id WHERE p.session_id = ?1 AND p.state = 'pending' AND r.state NOT IN ('completed', 'failed', 'cancelled', 'interrupted') ORDER BY p.created_at, p.id").all(sessionId).map(mapPermission);
  }

  expirePendingPermissions(runId, state = "expired") {
    this.db.query("UPDATE permissions SET state = ?1, resolved_at = ?2 WHERE run_id = ?3 AND state = 'pending'").run(state, now(), runId);
  }
}
