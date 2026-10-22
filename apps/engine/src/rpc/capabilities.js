// Supplied guest credentials are narrower than the owner's endpoint credential.
// This is RPC scoping, not isolation from other files readable by the same OS user.
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';

/**
 * The run a credential is good for right now, never a model-supplied run id: the run it was issued to, or, for a
 * credential held by a conversation's agent process across its runs, the run of that conversation in progress.
 * @param {{ active: Map<string, any> }} runs @param {{ getRun(id: string): any }} storage @param {any} capability
 */
export function liveRunFor(runs, storage, capability) {
  if (!capability) return null;
  if (runs.active.has(capability.runId)) return capability.runId;
  if (!capability.sessionId) return null;
  return [...runs.active.keys()].find((runId) => storage.getRun(runId)?.sessionId === capability.sessionId) ?? null;
}

export class CapabilityTokens {
  constructor(directory) { this.directory = directory; this.tokens = new Map(); this.revoked = new Set(); }
  /**
   * A credential for one holder: a run, or a conversation's agent process that outlives its runs (then `runId`
   * is that holder's name and `sessionId` says which task it belongs to).
   * @param {string} runId @param {string} workspaceId @param {string[]} [methods] @param {{ sessionId?: string | null }} [scope]
   */
  issue(runId, workspaceId, methods = ['workspace.search'], { sessionId = null } = {}) {
    const existing = [...this.tokens.values()].find(entry => entry.runId === runId && entry.workspaceId === workspaceId && JSON.stringify(entry.methods) === JSON.stringify(methods));
    if (existing) return existing;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const token = randomBytes(32).toString('hex');
    const tokenPath = path.join(this.directory, randomBytes(16).toString('hex'));
    writeFileSync(tokenPath, token, { mode: 0o600, flag: 'wx' });
    const entry = { tokenPath, runId, workspaceId, sessionId, methods: [...methods] };
    this.tokens.set(token, entry);
    return entry;
  }
  onRevoke(listener) { this.revoked.add(listener); return () => this.revoked.delete(listener); }
  lookup(token) { return this.tokens.get(token) ?? null; }
  revoke(runId) {
    for (const [token, entry] of this.tokens) {
      if (entry.runId !== runId) continue;
      this.tokens.delete(token);
      for (const listener of this.revoked) listener(token);
      try { unlinkSync(entry.tokenPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}
