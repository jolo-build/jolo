// Supplied guest credentials are narrower than the owner's endpoint credential.
// This is RPC scoping, not isolation from other files readable by the same OS user.
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';

export class CapabilityTokens {
  constructor(directory) { this.directory = directory; this.tokens = new Map(); this.revoked = new Set(); }
  issue(runId, workspaceId, methods = ['workspace.search']) {
    const existing = [...this.tokens.values()].find(entry => entry.runId === runId && entry.workspaceId === workspaceId && JSON.stringify(entry.methods) === JSON.stringify(methods));
    if (existing) return existing;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const token = randomBytes(32).toString('hex');
    const tokenPath = path.join(this.directory, randomBytes(16).toString('hex'));
    writeFileSync(tokenPath, token, { mode: 0o600, flag: 'wx' });
    const entry = { tokenPath, runId, workspaceId, methods: [...methods] };
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
