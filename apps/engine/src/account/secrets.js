import { createHash } from 'node:crypto';

export class AccountSecretStore {
  constructor({ dataDir, mode = process.env.JOLO_CREDENTIALS ?? 'keychain', secrets = Bun.secrets }) {
    this.scope = dataDir;
    this.mode = mode;
    this.secrets = secrets;
    this.memory = new Map();
  }
  key(origin) {
    return { service: 'jolo', name: `account:${createHash('sha256').update(this.scope + '\n' + origin).digest('hex')}` };
  }
  async get(origin) {
    if (this.memory.has(origin)) return this.memory.get(origin);
    if (this.mode !== 'keychain' || !this.secrets) return null;
    try { const value = await this.secrets.get(this.key(origin)); return value ? JSON.parse(value) : null; }
    catch { return null; }
  }
  async set(origin, value) {
    if (this.mode === 'keychain' && this.secrets) {
      try { await this.secrets.set({ ...this.key(origin), value: JSON.stringify(value) }); this.memory.delete(origin); return 'keychain'; }
      catch { /* Locked/unavailable keyrings use engine memory, never a plaintext file. */ }
    }
    this.memory.set(origin, value);
    return 'session';
  }
  async clear(origin) {
    this.memory.delete(origin);
    if (this.mode === 'keychain' && this.secrets) {
      try { await this.secrets.delete(this.key(origin)); } catch { /* The preference tombstone prevents stale credentials from being restored. */ }
    }
  }
}
