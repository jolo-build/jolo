import { ProtocolError, TERMINAL_RUN_STATES } from '@jolo/protocol';

const UUID = /^[a-f0-9-]{36}$/;
const PROMPT_CHARS = 20_000;
const enabledKey = identity => `remote-prompts-enabled:${identity}`;
const approvalsKey = identity => `remote-prompts-approvals:${identity}`;
const trackedKey = identity => `remote-prompts-tracked:${identity}`;
const LIVE_CHARS = 16_000;
const COMMAND_CHARS = 4000, SUMMARY_CHARS = 500;
// Chat sync is retried this often, 10 s apart, before a finished prompt is reported without it.
const SYNC_TRIES = 12;
const commandOf = request => request.script ?? request.argv?.map(arg => /^[\w@%+=:,./-]+$/.test(arg) ? arg : JSON.stringify(arg)).join(' ') ?? null;
/**
 * A pending request as the web shows it. `complete` says nothing was cut off: not by the tool,
 * which caps scripts at 4,000 characters and summaries at 500, and not here. Only a complete
 * request can be answered from the web, because an approval covers the whole request.
 */
function permissionOf(pending) {
  const command = commandOf(pending.request), summary = pending.request.summary ?? pending.tool;
  const complete = pending.request.argv ? command.length <= COMMAND_CHARS : pending.request.script ? pending.request.script.length < COMMAND_CHARS : summary.length < SUMMARY_CHARS;
  return { id: pending.id, tool: pending.tool, summary: summary.slice(0, SUMMARY_CHARS), command: command?.slice(0, COMMAND_CHARS) || null, complete };
}
const titleFrom = text => (text.split('\n').find(line => line.trim())?.trim() ?? 'Web prompt').slice(0, 80);

/**
 * Receives prompts typed on the account website. The engine dials out to the account's relay, so
 * the device needs no open port, and it is reachable only while the engine runs, i.e. while the
 * desktop or a terminal client is attached. The socket is not a client: it never keeps the engine
 * alive. Prompts become ordinary runs and use the permissions this device already has; anything
 * that needs approval waits for the person at the device, or, when they turned on approvals from
 * the web, for an answer there: allow once or deny, never a standing grant.
 */
export class RemotePrompts {
  /**
   * `handlers` are the engine's RPC handlers, so a web prompt takes the same path as a typed one.
   * `resolvePermission` applies an answer the way `permission.resolve` does for a local client.
   * @param {{ account: any, storage: any, chatSync: any, handlers: Record<string, (params: any) => Promise<any>>,
   *   resolvePermission: (params: { permissionId: string, decision: string }) => any, log?: any, WebSocketImpl?: any, pingMs?: number }} options
   */
  constructor({ account, storage, chatSync, handlers, resolvePermission, log, WebSocketImpl = WebSocket, pingMs = 30_000 }) {
    this.account = account; this.storage = storage; this.chatSync = chatSync; this.handlers = handlers; this.resolvePermission = resolvePermission; this.log = log;
    this.WebSocketImpl = WebSocketImpl; this.pingMs = pingMs;
    this.socket = null; this.key = null; this.connected = false; this.error = null; this.retry = 0;
    this.reconnect = null; this.ping = null; this.folders = ''; this.stopped = false;
    /**
     * Prompts this engine accepted, until their final status reaches the relay. Saved per account,
     * so a restart still reports them, and loaded only for the account they came from.
     */
    this.tracked = new Map(); this.trackedFor = null;
    /** Prompts between arrival and their run, with whether the web cancelled them meanwhile. */
    this.starting = new Map();
    this.timer = setInterval(() => this.refresh(), 5000); this.timer.unref?.();
    this.watch = setInterval(() => { void this.poll(); }, 1000); this.watch.unref?.();
  }
  identity() { return this.chatSync.identity(); }
  status() {
    const identity = this.identity();
    const enabled = Boolean(identity && this.account.record.device.scopes.includes('prompts:run') && this.chatSync.status().enabled && this.storage.getPreference(enabledKey(identity)) !== false);
    return { enabled, connected: enabled && this.connected, approvals: enabled && this.approvals(), error: enabled ? this.error : null };
  }
  approvals() { return this.storage.getPreference(approvalsKey(this.identity())) === true; }
  /** @param {{ enabled?: boolean, approvals?: boolean }} change */
  async configure({ enabled, approvals }) {
    await this.account.ready;
    if (!this.identity() || !this.account.record.device.scopes.includes('prompts:run')) throw new ProtocolError('permission_denied', 'Approve web prompts for this device first.');
    if (enabled && !this.chatSync.status().enabled) throw new ProtocolError('conflict', 'Turn on chat sync first. Web prompts continue synced chats.');
    if (enabled !== undefined) this.storage.setPreference(enabledKey(this.identity()), enabled);
    if (approvals !== undefined) this.storage.setPreference(approvalsKey(this.identity()), approvals);
    this.refresh(); this.account.changed();
    return this.account.snapshot();
  }
  /** Open, keep or close the connection to match the account, its scopes and the switch. */
  refresh() {
    if (this.stopped) return;
    const want = this.status().enabled ? `${this.account.origin}\n${this.account.credential}` : null;
    if (want !== this.key) {
      this.close(); this.key = want; this.retry = 0; this.error = null;
    }
    const identity = want ? this.identity() : null;
    if (identity !== this.trackedFor) {
      this.trackedFor = identity;
      this.tracked = new Map(Object.entries(identity ? this.storage.getPreference(trackedKey(identity)) ?? {} : {}));
    }
    if (want && !this.socket && !this.reconnect) this.connect();
    else if (this.connected && `${this.localFolders().join()}|${this.approvals()}` !== this.folders) this.hello();
  }
  connect() {
    const url = `${this.account.origin.replace(/^http/, 'ws')}/api/relay`;
    let socket;
    try { socket = this.socket = new this.WebSocketImpl(url, { headers: { Authorization: `Bearer ${this.account.credential}` } }); }
    catch { this.socket = null; return this.later(); }
    socket.onopen = () => {
      if (socket !== this.socket) return;
      this.connected = true; this.error = null; this.retry = 0;
      this.hello();
      // A run that progressed while the socket was down reports where it is now.
      for (const [id, entry] of this.tracked) if (entry.last && this.send(entry.last) && entry.final) this.tracked.delete(id);
      this.save();
      this.ping = setInterval(() => { try { socket.send('ping'); } catch { /* closing */ } }, this.pingMs); this.ping.unref?.();
      this.account.changed();
    };
    socket.onmessage = event => {
      if (socket !== this.socket || event.data === 'pong') return;
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      void this.handle(message);
    };
    socket.onclose = event => {
      if (socket !== this.socket) return;
      this.socket = null; this.connected = false; clearInterval(this.ping);
      this.error = event.code === 4001 ? 'This device was removed from your account.' : 'Web prompts are offline. Reconnecting…';
      this.account.changed();
      this.later();
    };
    socket.onerror = () => { /* onclose follows */ };
  }
  later() {
    if (this.stopped || !this.key) return;
    const delay = Math.min(60_000, 1000 * 2 ** this.retry++);
    this.reconnect = setTimeout(() => { this.reconnect = null; this.refresh(); }, delay); this.reconnect.unref?.();
  }
  close() {
    clearTimeout(this.reconnect); this.reconnect = null; clearInterval(this.ping);
    const socket = this.socket;
    this.socket = null; this.connected = false;
    try { socket?.close(1000); } catch { /* already closed */ }
  }
  send(message) {
    if (!this.connected) return false;
    try { this.socket.send(JSON.stringify(message)); return true; } catch { return false; }
  }
  /** Synced folders with a real checkout here. Placeholders for folders from other devices never run prompts. */
  localFolders() {
    const map = this.storage.getPreference(`chat-sync-folders:${this.identity()}`)?.workspaces ?? {};
    return Object.entries(map).filter(([, local]) => {
      const workspace = this.storage.getWorkspace(local);
      return workspace && !workspace.removedAt && !workspace.needsFolder;
    }).map(([id]) => id).sort();
  }
  hello() {
    const folders = this.localFolders(), approvals = this.approvals();
    this.folders = `${folders.join()}|${approvals}`;
    this.send({ type: 'hello', folders, approvals });
  }
  /** The reply so far: the run's assistant text as committed, from the end. */
  liveText(runId) {
    const parts = this.storage.db.query("SELECT artifact_id, committed_bytes FROM messages WHERE run_id=?1 AND role='assistant' AND kind='text' ORDER BY ordinal").all(runId).map(row => {
      const artifact = this.storage.getArtifact(row.artifact_id), end = Math.min(row.committed_bytes, artifact.committedBytes), start = Math.max(0, end - LIVE_CHARS * 4);
      return this.storage.artifacts.read(artifact.storageKey, start, end - start, artifact.committedBytes).buffer.toString('utf8');
    });
    return parts.join('\n\n').slice(-LIVE_CHARS);
  }
  localChat(remote) {
    const map = this.storage.getPreference(`chat-sync-map:${this.identity()}`) ?? {};
    return Object.entries(map).find(([, value]) => value.remote === remote)?.[0] ?? null;
  }
  save() {
    if (!this.trackedFor) return;
    const kept = [...this.tracked].map(([id, { runId, sessionId, chatId, last, final, stopError }]) => [id, { runId, sessionId, chatId, last, final, stopError }]);
    this.storage.setPreference(trackedKey(this.trackedFor), Object.fromEntries(kept));
  }
  report(id, status, extra = {}) {
    const entry = this.tracked.get(id), message = { type: 'status', id, status, ...extra };
    if (entry) { entry.last = message; this.save(); }
    return this.send(message);
  }
  async handle(message) {
    if (message?.type === 'cancel') {
      const entry = this.tracked.get(message.id), starting = this.starting.get(message.id);
      if (entry) await this.handlers['run.cancel']({ runId: entry.runId }).catch(() => { /* already finished */ });
      else if (starting) starting.cancelled = true;
      // Nothing runs for it here (never received, or lost to a restart before it started), so the
      // web can stop waiting.
      else if (UUID.test(message.id ?? '')) this.send({ type: 'status', id: message.id, status: 'cancelled' });
      return;
    }
    if (message?.type === 'permission') {
      // Checked again here: the switch is on, the answer is once or deny, and the request is the
      // one this web prompt's run is waiting on now.
      const entry = this.tracked.get(message.id), pending = entry && this.storage.pendingPermissionForRun(entry.runId);
      if (!this.approvals() || !['allow_once', 'deny'].includes(message.decision) || !pending || pending.id !== message.permissionId || !permissionOf(pending).complete) return;
      try { this.resolvePermission({ permissionId: pending.id, decision: message.decision }); }
      catch (error) { this.log?.warn('web permission answer not applied', { promptId: message.id, error: String(error?.message ?? error) }); }
      return;
    }
    const text = typeof message?.text === 'string' ? message.text.trim() : '';
    if (message?.type !== 'prompt' || !UUID.test(message.id ?? '') || !text || text.length > PROMPT_CHARS || this.tracked.has(message.id) || this.starting.has(message.id)) return;
    const reject = error => this.send({ type: 'status', id: message.id, status: 'rejected', error });
    const starting = { cancelled: false };
    this.starting.set(message.id, starting);
    try {
      let sessionId = null;
      if (UUID.test(message.chatId ?? '')) {
        sessionId = this.localChat(message.chatId);
        // The chat may have been synced from another device moments ago.
        if (!sessionId) { await this.chatSync.run(); sessionId = this.localChat(message.chatId); }
        if (!sessionId) return reject('This chat has not synced to the device yet.');
      } else if (UUID.test(message.folderId ?? '')) {
        if (!this.localFolders().includes(message.folderId)) return reject('This folder is not linked on the device.');
        const workspace = this.storage.getWorkspace(this.storage.getPreference(`chat-sync-folders:${this.identity()}`).workspaces[message.folderId]);
        sessionId = (await this.handlers['session.create']({ projectId: workspace.projectId, workspaceId: workspace.id, title: titleFrom(text) })).session.id;
      } else return reject('This prompt has no chat or folder.');
      const session = this.storage.getSession(sessionId);
      if (!session || session.state === 'archived') return reject('This chat was removed or archived on the device.');
      if (this.storage.getWorkspace(session.workspaceId)?.needsFolder) return reject('Link this synced folder on the device before continuing.');
      if (this.storage.sessionHasBusyRuns(sessionId)) return reject('This chat is busy on the device.');
      if (starting.cancelled) return this.send({ type: 'status', id: message.id, status: 'cancelled' });
      const { run } = await this.handlers['run.start']({ sessionId, requestId: `web_${message.id}`, prompt: text });
      this.tracked.set(message.id, { runId: run.id, sessionId, chatId: message.chatId ?? null });
      this.report(message.id, 'accepted');
      this.log?.info('web prompt started', { promptId: message.id, sessionId, runId: run.id });
      // Cancelled while the run started: it stops now and reports `cancelled` like any other.
      if (starting.cancelled) await this.handlers['run.cancel']({ runId: run.id }).catch(() => { /* already finished */ });
    } catch (error) {
      reject(String(error?.message ?? 'Could not start this prompt.').slice(0, 300));
    } finally {
      this.starting.delete(message.id);
    }
  }
  async poll() {
    for (const [id, entry] of this.tracked) {
      if (entry.finishing || entry.retryAt > Date.now()) continue;
      const run = this.storage.getRun(entry.runId);
      if (!run) {
        if (this.report(id, 'failed', { error: 'The run is no longer on the device.' })) { this.tracked.delete(id); this.save(); }
        continue;
      }
      // A run paused for any other reason (a declined request, a stop) waits for the next message;
      // for the web prompt that is the end, and the chat takes a new prompt.
      const stopped = run.state === 'paused' && run.pauseReason !== 'permission';
      if (!TERMINAL_RUN_STATES.includes(run.state) && !stopped) {
        const waiting = run.state === 'awaiting_permission' || (run.state === 'paused' && run.pauseReason === 'permission');
        const pending = waiting ? this.storage.pendingPermissionForRun(run.id) : null;
        const permission = pending && permissionOf(pending);
        const status = waiting ? 'awaiting_permission' : 'running';
        if (entry.last?.status !== status || entry.last?.permission?.id !== permission?.id) this.report(id, status, permission ? { permission } : {});
        const text = this.liveText(run.id);
        if (text && text !== entry.text && this.send({ type: 'live', id, text })) entry.text = text;
        continue;
      }
      entry.finishing = true;
      // The web prompt ends here, so its paused run ends too; a paused run would keep the chat
      // from syncing, and the reply would never reach the web.
      if (stopped) {
        entry.stopError = `Stopped on the device${run.failure ? `: ${run.failure}` : ''}. Send another prompt to continue.`;
        this.save();
        await this.handlers['run.cancel']({ runId: run.id }).catch(() => { /* finished meanwhile */ });
      }
      // Upload the reply before the final status, so the page that reloads on it shows the answer.
      // A cycle already under way may have skipped this chat while it ran, hence a second one.
      try { await this.chatSync.run(); await this.chatSync.run(); } catch { /* checked below */ }
      const synced = this.chatSync.synced(entry.sessionId);
      if (!synced && (entry.syncTries = (entry.syncTries ?? 0) + 1) < SYNC_TRIES) {
        entry.finishing = false; entry.retryAt = Date.now() + 10_000;
        continue;
      }
      // A sync conflict moves the reply to a copy of the chat; the map names where it went.
      const chatId = (this.storage.getPreference(`chat-sync-map:${this.identity()}`) ?? {})[entry.sessionId]?.remote ?? entry.chatId;
      const status = entry.stopError ? 'failed' : run.state === 'completed' ? 'completed' : run.state === 'cancelled' ? 'cancelled' : 'failed';
      const unsynced = synced ? '' : ` The reply has not synced yet${this.chatSync.status().error ? `: ${this.chatSync.status().error}` : '.'}`;
      const error = status === 'failed' ? `${entry.stopError ?? run.failure ?? 'The run did not finish.'}${unsynced}` : unsynced ? `${status === 'completed' ? 'Finished' : 'Cancelled'} on the device.${unsynced}` : null;
      entry.final = true;
      if (this.report(id, status, { ...(chatId ? { chatId } : {}), ...(error ? { error } : {}) })) this.tracked.delete(id);
      this.save();
    }
  }
  async stop() {
    this.stopped = true; clearInterval(this.timer); clearInterval(this.watch); this.close();
  }
}
