import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { CHAT_BYTES, validChat } from '../../../../packages/protocol/src/chat-sync.js';
import { ProtocolError } from '@jolo/protocol';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class ChatSync {
  constructor({ account, storage, paths, permissions }) {
    this.account = account; this.storage = storage; this.paths = paths; this.permissions = permissions;
    this.running = null; this.stopped = false; this.error = null; this.lastSyncedAt = null;
    this.timer = setInterval(() => { void this.run(); }, 15000); this.timer.unref?.();
  }
  identity() { return this.account.record ? `${this.account.origin}:${this.account.record.account.id}` : null; }
  status() {
    const enabled = Boolean(this.identity() && this.account.record.device.scopes.includes('chats:sync') && this.storage.getPreference(`chat-sync-enabled:${this.identity()}`) !== false);
    return { enabled, lastSyncedAt: enabled ? this.lastSyncedAt : null, error: enabled ? this.error : null };
  }
  async configure(enabled) {
    await this.account.ready;
    if (!this.identity() || !this.account.record.device.scopes.includes('chats:sync')) throw new ProtocolError('permission_denied', 'Approve chat sync for this device first.');
    this.storage.setPreference(`chat-sync-enabled:${this.identity()}`, enabled);
    this.account.changed();
    if (enabled) void this.run();
    return this.account.snapshot();
  }
  run() {
    if (this.running) return this.running;
    this.running = this.cycle().catch(error => { this.error = error.message; }).finally(() => { this.running = null; });
    return this.running;
  }
  async cycle() {
    await this.account.ready;
    if (this.stopped || !this.status().enabled) return;
    const identity = this.identity(), token = this.account.credential, origin = this.account.origin;
    const current = () => !this.stopped && this.identity() === identity && this.account.credential === token && this.status().enabled;
    const request = async (suffix = '', body = null) => {
      if (!current()) throw new Error('Chat sync paused.');
      let response;
      try { response = await this.account.fetch(`${origin}/api/chats${suffix}`, { method: body ? 'PUT' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual', signal: AbortSignal.timeout(10000) }); }
      catch { throw new Error('Chat sync is offline. It will retry automatically.'); }
      if (!current()) throw new Error('Chat sync paused.');
      if (response.status === 409) return null;
      if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'Reconnect chat sync in Account settings.' : 'Chat sync is unavailable. It will retry automatically.');
      const reader = response.body.getReader(), chunks = []; let size = 0;
      while (true) { const {done,value} = await reader.read(); if(done) break; size += value.byteLength; if(size > CHAT_BYTES + 65536) { await reader.cancel(); throw new Error('Invalid chat sync response.'); } chunks.push(value); }
      const result = JSON.parse(await new Blob(chunks).text());
      if (!current()) throw new Error('Chat sync paused.');
      return result;
    };
    const key = `chat-sync-map:${identity}`, map = this.storage.getPreference(key) ?? {};
    // Every local conversation is bound to the account that first synced it.
    let skipped = 0;
    const sessions = this.storage.db.query('SELECT id FROM sessions WHERE deleted_at IS NULL').all();
    for (const {id} of sessions) {
      if (!current()) return;
      const owner = this.storage.getPreference(`chat-sync-owner:${id}`);
      if (owner && owner !== identity) continue;
      if (this.storage.sessionHasUnfinishedRuns(id)) continue;
      let chat;
      try { chat = this.export(id); } catch { skipped++; continue; }
      if (!chat.messages.length) continue;
      if (!validChat(chat)) { skipped++; continue; }
      const hash = digest(chat), saved = map[id];
      if (saved?.hash === hash) continue;
      this.storage.setPreference(`chat-sync-owner:${id}`, identity);
      const target = saved?.remote ?? randomUUID();
      // Persist the remote id before sending so a crash retries the same identity.
      map[id] ??= { remote: target, revision: 0, hash: null };
      this.storage.setPreference(key,map);
      let result = await request(`/${target}`, { revision: saved?.revision ?? 0, chat });
      if (!result) {
        const remote = await request(`/${target}`);
        if (digest(remote.chat) === hash) result = { revision: remote.revision };
        else {
          // Both sides changed. Fork the local branch; pull the remote branch below.
          const fork = randomUUID();
          map[id] = { remote: fork, revision: 0, hash: null };
          this.storage.setPreference(key,map);
          result = await request(`/${fork}`, { revision: 0, chat });
          if (!result) throw new Error('Chat sync storage limit reached.');
        }
      }
      map[id] = { ...map[id], revision: result.revision, hash };
      this.storage.setPreference(key,map);
    }
    let after = '';
    do {
      const page = await request(after ? `?after=${encodeURIComponent(after)}` : '');
      if (!Array.isArray(page.chats) || page.chats.length > 50) throw new Error('Invalid chat list.');
      for (const row of page.chats) {
        if (!/^[a-f0-9-]{36}$/.test(row.id) || !Number.isSafeInteger(row.revision)) throw new Error('Invalid chat list.');
        const entry = Object.entries(map).find(([,v]) => v.remote === row.id);
        if (entry && entry[1].revision === row.revision) continue;
        // Local removal stays removed on this device. Never overwrite active work.
        if (entry && (!this.storage.getSession(entry[0]) || this.storage.db.query('SELECT deleted_at FROM sessions WHERE id=?1').get(entry[0])?.deleted_at || this.storage.sessionHasUnfinishedRuns(entry[0]))) continue;
        const remote = await request(`/${row.id}`);
        if (!validChat(remote.chat)) throw new Error('Invalid synced chat.');
        // The user may have edited during the network read. Retry next cycle instead.
        if (entry && (this.storage.sessionHasUnfinishedRuns(entry[0]) || this.storage.db.query('SELECT deleted_at FROM sessions WHERE id=?1').get(entry[0])?.deleted_at || digest(this.export(entry[0])) !== entry[1].hash)) continue;
        let existing = entry?.[0];
        if (existing && !this.export(existing).messages.every((m,i) => JSON.stringify(m) === JSON.stringify(remote.chat.messages[i]))) {
          map[existing] = { remote: randomUUID(), revision: 0, hash: null };
          existing = null;
        }
        const id = this.restore(remote.chat, existing);
        this.storage.setPreference(`chat-sync-owner:${id}`,identity);
        map[id] = { remote: row.id, revision: remote.revision, hash: digest(this.export(id)) };
        this.storage.setPreference(key,map);
      }
      if (page.next && (typeof page.next !== 'string' || page.next <= after)) throw new Error('Invalid chat cursor.');
      after = page.next;
    } while (after && current());
    this.error = skipped ? `${skipped} chat(s) exceed the sync limit of 1 MB or 10,000 messages. Other chats are synced.` : null; this.lastSyncedAt = new Date().toISOString(); this.account.changed();
  }
  export(id) {
    const session = this.storage.getSession(id);
    const messages = this.storage.db.query("SELECT role,artifact_id FROM messages WHERE session_id=?1 AND role IN ('user','assistant') AND kind='text' ORDER BY ordinal").all(id).map(row => {
      const artifact = this.storage.getArtifact(row.artifact_id);
      if (artifact.committedBytes > CHAT_BYTES) throw new Error('A message exceeds the 1 MB chat sync limit.');
      return { role: row.role, text: this.storage.artifacts.read(artifact.storageKey,0,CHAT_BYTES,artifact.committedBytes).buffer.toString('utf8') };
    });
    return { version: 1, title: session.title, messages };
  }
  restore(chat, existing = null) {
    return this.storage.transaction(() => {
      let session = existing && this.storage.getSession(existing);
      if (!session) {
        const base = path.join(this.paths.dataDir,'chats'); mkdirSync(base,{recursive:true,mode:0o700});
        const root = mkdtempSync(path.join(base,'synced-'));
        const project = this.storage.upsertProject({identity:root,rootPath:root});
        this.storage.setProjectPreferences(project.id,{standalone:true});
        const workspace = this.storage.ensureDirectWorkspace(project.id,root);
        this.permissions.grantInspect(workspace.id);
        session = this.storage.createSession({projectId:project.id,workspaceId:workspace.id,title:chat.title});
      }
      const offset = this.export(session.id).messages.length;
      this.storage.db.query("UPDATE sessions SET title=?2,agent_state='{}',revision=revision+1,updated_at=?3 WHERE id=?1").run(session.id,chat.title,new Date().toISOString());
      for (const m of chat.messages.slice(offset)) {
        const ordinal = this.storage.nextMessageOrdinal(session.id);
        const artifact = this.storage.createArtifact({sessionId:session.id,kind:'text'}), bytes = Buffer.from(m.text);
        this.storage.artifacts.writeChunk(artifact.storageKey,0,bytes);
        this.storage.finalizeArtifact(artifact.id,bytes.length,createHash('sha256').update(bytes).digest('hex'));
        const message = this.storage.insertMessage({sessionId:session.id,runId:null,role:m.role,artifactId:artifact.id,ordinal});
        this.storage.finishMessage(message.id,'complete',bytes.length);
        this.storage.insertItem({sessionId:session.id,kind:`${m.role}_message`,groupId:randomUUID(),payload:{text:m.text},messageId:message.id});
      }
      this.storage.appendEvent({sessionId:session.id,type:'session.created',payload:{session:this.storage.getSession(session.id)}});
      return session.id;
    });
  }
  async stop() { this.stopped = true; clearInterval(this.timer); await this.running; }
}
