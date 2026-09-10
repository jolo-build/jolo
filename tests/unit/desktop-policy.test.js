import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { installBrowserHost } from '../../apps/desktop/src/main/browser-host.mjs';
import { createAttentionService } from '../../apps/desktop/src/main/attention-service.mjs';
import { projectAX } from '../../apps/desktop/src/main/ax-projection.mjs';
const log = { info() {}, warn() {} };

test('browser attachment rejects unsafe URLs and keeps concurrent workspaces separate', () => {
  const contents = new EventEmitter(), sessions = new Map(), attached = [];
  const sessionForPartition = key => { if (!sessions.has(key)) sessions.set(key, Object.assign(new EventEmitter(), { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} })); return sessions.get(key); };
  installBrowserHost({ webContents: contents }, { log, sessionForPartition, onGuest: (guest, workspace) => attached.push([guest.id, workspace]) });
  let blocked = 0;
  for (const src of ['file:///etc/passwd', 'javascript:alert(1)', 'malformed']) contents.emit('will-attach-webview', { preventDefault() { blocked++; } }, {}, { src, partition: 'jolo-browser-a' });
  expect(blocked).toBe(3);
  for (const workspace of ['a', 'b']) {
    const preferences = { nodeIntegration: true, preload: '/bad' };
    contents.emit('will-attach-webview', { preventDefault() { throw new Error('valid attachment blocked'); } }, preferences, { src: 'https://example.com', partition: `jolo-browser-${workspace}` });
    expect(preferences).toMatchObject({ nodeIntegration: false, sandbox: true, contextIsolation: true });
    expect(preferences.preload).toBeUndefined();
  }
  for (const [id, workspace] of [[1, 'b'], [2, 'a']]) {
    const guest = Object.assign(new EventEmitter(), { id, session: sessionForPartition(`jolo-browser-${workspace}`), debugger: { attach() {}, sendCommand: async () => {} }, setWindowOpenHandler() {} });
    contents.emit('did-attach-webview', {}, guest);
  }
  expect(attached).toEqual([[1, 'b'], [2, 'a']]);
});

test('a pending permission produces one notice when the run also pauses', async () => {
  const notices = [], badges = [];
  const row = { projectId: 'p', workspaceId: 'w', rootPath: '/repo', name: 'repo', attention: 'needs_you', run: { id: 'r' }, session: { id: 's' }, pendingPermission: { permissionId: 'approval', summary: 'run command' } };
  const service = createAttentionService({ bridge: { rawCall: async method => method === 'board.list' ? { projects: [row] } : { pendingPermissions: [{ permissionId: 'approval', runId: 'r', summary: 'run command' }] } }, window: { isDestroyed: () => false, isFocused: () => true, webContents: { send: (channel, notice) => notices.push(notice) } }, app: { dock: { setBadge: value => badges.push(value) }, setBadgeCount: value => badges.push(value) }, Notification: {}, log });
  try {
    service.onEvent({ type: 'permission.requested', runId: 'r', sessionId: 's', payload: { permissionId: 'approval', summary: 'run command' } });
    service.onEvent({ type: 'run.state', runId: 'r', sessionId: 's', payload: { state: 'paused', pauseReason: 'permission' } });
    await Bun.sleep(1);
    expect(notices).toHaveLength(1); expect(notices[0].permissionId).toBe('approval'); expect(badges).toHaveLength(1);
  } finally { service.dispose(); }
});

test('browser accessibility projection bounds traversal and preserves action references', () => {
  const nodes = [{ nodeId: 'root', role: { value: 'RootWebArea' }, name: { value: 'page' }, childIds: ['button', 'other'] }, { nodeId: 'button', parentId: 'root', role: { value: 'button' }, name: { value: 'save' }, backendDOMNodeId: 42 }, { nodeId: 'other', parentId: 'root', role: { value: 'button' }, name: { value: 'cancel' } }];
  const result = projectAX(nodes, { snapshotId: 'snapshot', navigationRevision: 1, maxNodes: 2 });
  expect(result.snapshot.truncated).toBe(true); expect(result.snapshot.nodes).toHaveLength(2); expect(result.references.get('e2')).toBe(42);
});

function attentionFixture({ focused = true, read } = {}) {
  const notices = [], notifications = [];
  const row = { projectId: 'p', workspaceId: 'w', rootPath: '/repo', name: 'repo', run: { id: 'r' }, session: { id: 's' } };
  class Notification extends EventEmitter {
    static isSupported() { return true; }
    constructor(options) { super(); this.options = options; this.shown = false; this.closed = false; notifications.push(this); }
    show() { this.shown = true; }
    close() { this.closed = true; }
  }
  const pending = [{ permissionId: 'approval', runId: 'r', summary: 'run command' }];
  const service = createAttentionService({ bridge: { rawCall: read ?? (async method => method === 'board.list' ? { projects: [row] } : { pendingPermissions: pending }) },
    window: { isDestroyed: () => false, isFocused: () => focused, webContents: { send: (_channel, notice) => notices.push(notice) } },
    app: { dock: { setBadge() {} }, setBadgeCount() {}, getName: () => 'Jolo' }, Notification, log });
  const requested = { type: 'permission.requested', runId: 'r', sessionId: 's', payload: { permissionId: 'approval', summary: 'run command' } };
  const resolved = { type: 'permission.resolved', runId: 'r', sessionId: 's', payload: { permissionId: 'approval', decision: 'allow_run' } };
  return { service, notices, notifications, pending, row, requested, resolved };
}

test('a decision cancels a notice still waiting on a board read', async () => {
  let release;
  const f = attentionFixture({ read: () => new Promise(resolve => { release = resolve; }) });
  try {
    f.service.onEvent(f.requested);
    f.service.onEvent(f.resolved);
    release({ projects: [f.row] });
    await Bun.sleep(1);
    expect(f.notices.filter(notice => !notice.dismiss)).toHaveLength(0);
    expect(f.notices).toContainEqual({ dismiss: true, permissionId: 'approval' });
  } finally { f.service.dispose(); }
});

test('replayed approvals that no longer need a dialog produce no notice', async () => {
  const f = attentionFixture();
  try {
    f.pending.length = 0;
    f.service.onEvent(f.requested);
    await Bun.sleep(1);
    expect(f.notices).toHaveLength(0);
  } finally { f.service.dispose(); }
});

test('approving closes the OS notification and a late OS failure cannot restore it', async () => {
  const f = attentionFixture({ focused: false });
  try {
    f.service.onEvent(f.requested);
    await Bun.sleep(1);
    expect(f.notifications).toHaveLength(1);
    expect(f.notifications[0].shown).toBe(true);
    expect(f.notifications[0].options.silent).toBe(false);
    f.service.onEvent(f.resolved);
    expect(f.notifications[0].closed).toBe(true);
    f.notifications[0].emit('failed', {}, 'late failure');
    expect(f.notices.filter(notice => !notice.dismiss)).toHaveLength(0);
  } finally { f.service.dispose(); }
});

test('commands covered by a standing approval generate no approval notices', async () => {
  const f = attentionFixture();
  try {
    f.service.onEvent(f.resolved);
    f.pending.length = 0;
    for (const type of ['tool.started', 'tool.completed', 'run.state']) f.service.onEvent({ type, runId: 'r', sessionId: 's', payload: { state: 'tools' } });
    await Bun.sleep(1);
    expect(f.notices.filter(notice => !notice.dismiss)).toHaveLength(0);
    expect(f.notifications).toHaveLength(0);
  } finally { f.service.dispose(); }
});

test('routine task notifications explicitly suppress the OS sound', async () => {
  const f = attentionFixture({ focused: false });
  try {
    f.service.onEvent({ type: 'run.state', runId: 'r', sessionId: 's', payload: { state: 'completed' } });
    await Bun.sleep(1);
    expect(f.notifications).toHaveLength(1);
    expect(f.notifications[0].options.silent).toBe(true);
  } finally { f.service.dispose(); }
});
