import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { installBrowserHost } from '../src/main/browser-host.js';
import { createAttentionService } from '../src/main/attention-service.js';
import { noticeFrom, withoutAnswered } from '../src/renderer/engine-context.jsx';
import { projectAX } from '../src/main/ax-projection.js';
import { readFileSync } from 'node:fs';
import { METHOD_NAMES } from '@jolo/protocol';
const log = { info() {}, warn() {} };

test('the renderer may call the engine methods for background work and dialogs, and only methods the engine has', () => {
  // The main process cannot be imported outside Electron; its allow-list is read from the source, as the preload test reads its own.
  const source = readFileSync(new URL('../src/main/index.js', import.meta.url), 'utf8');
  const list = (source.match(/const RENDERER_METHODS = new Set\(\[([\s\S]*?)\]\);/)?.[1] ?? '').replace(/\/\/.*$/gm, '');
  const methods = [...list.matchAll(/["']([^"']+)["']/g)].map(match => match[1]);
  expect(methods).toEqual(expect.arrayContaining(['session.activity', 'session.stopBackground', 'session.stopTask', 'session.closeProcess', 'session.clearFinished', 'session.taskOutput', 'session.mcpStatus', 'delegation.list', 'dialog.resolve', 'dialog.dismiss']));
  expect(methods.filter(method => !METHOD_NAMES.includes(method))).toEqual([]);
});

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
    expect(preferences.preload).toEndWith('/browser-zoom-preload.cjs');
  }
  for (const [id, workspace] of [[1, 'b'], [2, 'a']]) {
    const guest = Object.assign(new EventEmitter(), { id, session: sessionForPartition(`jolo-browser-${workspace}`), debugger: { attach() {}, sendCommand: async () => {} }, setWindowOpenHandler() {}, setZoomMode() {}, async setVisualZoomLevelLimits() {} });
    contents.emit('did-attach-webview', {}, guest);
  }
  expect(attached).toEqual([[1, 'b'], [2, 'a']]);
});

test('a pending permission produces one notice when the run also pauses', async () => {
  const notices = [], badges = [];
  const row = { projectId: 'p', workspaceId: 'w', rootPath: '/repo', name: 'repo', attention: 'needs_you', run: { id: 'r' }, session: { id: 's' }, pendingPermission: { permissionId: 'approval', summary: 'run command' } };
  // The window, the app and the Notification class are partial doubles: the service only ever
  // reaches for the handful of members named here, so they are asserted rather than filled in with
  // the rest of Electron's surface. An empty Notification stands for a system that never shows one.
  const service = createAttentionService({ bridge: { rawCall: async method => method === 'board.list' ? { projects: [row] } : { pendingPermissions: [{ permissionId: 'approval', runId: 'r', summary: 'run command' }] } }, window: /** @type {any} */ ({ isDestroyed: () => false, isFocused: () => true, webContents: { send: (channel, notice) => notices.push(notice) } }), app: /** @type {any} */ ({ dock: { setBadge: value => badges.push(value) }, setBadgeCount: value => badges.push(value) }), Notification: /** @type {any} */ ({}), log });
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

/**
 * One attention service over doubles, with the two things the tests vary.
 * @param {{ focused?: boolean, read?: (method: string, params?: any) => Promise<any> }} [options]
 */
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
  /** A question Claude asks, as its dialog.requested event and the page's pendingDialogs show it. @type {{ dialogId: string, runId: string, tool: string, input: any, toolUseId: string | null }} */
  const question = { dialogId: 'dlg', runId: 'r', tool: 'AskUserQuestion', input: { questions: [{ question: 'tea or coffee?', header: 'Choice', options: [], multiSelect: false }] }, toolUseId: null };
  const dialogs = [question];
  // Partial doubles again, including the Notification class above, which implements only the three
  // members the service uses and records what it was asked to show.
  const service = createAttentionService({ bridge: { rawCall: read ?? (async method => method === 'board.list' ? { projects: [row] } : { pendingPermissions: pending, pendingDialogs: dialogs }) },
    window: /** @type {any} */ ({ isDestroyed: () => false, isFocused: () => focused, webContents: { send: (_channel, notice) => notices.push(notice) } }),
    app: /** @type {any} */ ({ dock: { setBadge() {} }, setBadgeCount() {}, getName: () => 'Jolo' }), Notification: /** @type {any} */ (Notification), log });
  const requested = { type: 'permission.requested', runId: 'r', sessionId: 's', payload: { permissionId: 'approval', summary: 'run command' } };
  const resolved = { type: 'permission.resolved', runId: 'r', sessionId: 's', payload: { permissionId: 'approval', decision: 'allow_run' } };
  const asked = { type: 'dialog.requested', runId: 'r', sessionId: 's', payload: question };
  const answered = { type: 'dialog.resolved', runId: 'r', sessionId: 's', payload: { dialogId: 'dlg', state: 'answered' } };
  return { service, notices, notifications, pending, dialogs, question, row, requested, resolved, asked, answered };
}

test('a decision cancels a notice still waiting on a board read', async () => {
  /** @type {(value: any) => void} the board read's resolve, captured by the promise below */
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

test('a question Claude asks is told like an approval, and withdrawn once answered', async () => {
  const f = attentionFixture();
  try {
    f.service.onEvent(f.asked);
    await Bun.sleep(1);
    expect(f.notices).toHaveLength(1);
    expect(f.notices[0]).toMatchObject({ kind: 'approval', dialogId: 'dlg', permissionId: null, title: 'repo needs your answer', body: 'tea or coffee?' });
    f.dialogs.length = 0;
    f.service.onEvent(f.answered);
    await Bun.sleep(1);
    expect(f.notices).toContainEqual({ dismiss: true, dialogId: 'dlg' });
    expect(f.notices.filter(notice => !notice.dismiss)).toHaveLength(1);
  } finally { f.service.dispose(); }
});

test('a plan says it is ready for review, a question too long to send names its tool, and both may sound', async () => {
  const f = attentionFixture({ focused: false });
  try {
    f.dialogs[0] = { ...f.question, tool: 'ExitPlanMode', input: { plan: 'Rename the module' } };
    f.service.onEvent({ ...f.asked, payload: f.dialogs[0] });
    await Bun.sleep(1);
    expect(f.notifications[0].options).toEqual({ title: 'repo needs your answer', body: 'Plan ready for your review', silent: false });
    f.service.onEvent(f.answered);
    expect(f.notifications[0].closed).toBe(true);
    f.dialogs[0] = { ...f.question, dialogId: 'dlg2', input: { truncated: true, preview: '{"questions":[{"question":"tea or' } };
    f.service.onEvent({ ...f.asked, payload: f.dialogs[0] });
    await Bun.sleep(1);
    expect(f.notifications[1].options).toEqual({ title: 'repo needs your answer', body: 'AskUserQuestion', silent: false });
  } finally { f.service.dispose(); }
});

test('a question already answered by the time it is read produces no notice', async () => {
  const f = attentionFixture();
  try {
    f.dialogs.length = 0;
    f.service.onEvent(f.asked);
    await Bun.sleep(1);
    expect(f.notices).toHaveLength(0);
  } finally { f.service.dispose(); }
});

test('answering a question cancels its notice still waiting on a board read', async () => {
  /** @type {(value: any) => void} the board read's resolve, captured by the promise below */
  let release;
  // The page still lists the question, as if it was read before the answer arrived.
  const f = attentionFixture({ focused: false, read: async method => method === 'board.list' ? new Promise(resolve => { release = resolve; }) : { pendingPermissions: [], pendingDialogs: f.dialogs } });
  try {
    f.service.onEvent(f.asked);
    f.service.onEvent(f.answered);
    release({ projects: [f.row] });
    await Bun.sleep(1);
    expect(f.notices.filter(notice => !notice.dismiss)).toHaveLength(0);
    expect(f.notifications).toHaveLength(0);
    expect(f.notices).toContainEqual({ dismiss: true, dialogId: 'dlg' });
  } finally { f.service.dispose(); }
});

test('a question replayed while still open is told once', async () => {
  const f = attentionFixture();
  try {
    f.service.onEvent(f.asked);
    f.service.onEvent(f.asked);
    await Bun.sleep(1);
    expect(f.notices).toHaveLength(1);
  } finally { f.service.dispose(); }
});

test('a question is withdrawn when its run ends, and answering a permission of that run does not withdraw it', async () => {
  /** @type {(value: any) => void} the board read's resolve, captured by the promise below */
  let release;
  const f = attentionFixture({ read: async method => method === 'board.list' ? new Promise(resolve => { release = resolve; }) : { pendingPermissions: [], pendingDialogs: f.dialogs } });
  try {
    f.service.onEvent(f.asked);
    f.service.onEvent(f.resolved);
    release({ projects: [f.row] });
    await Bun.sleep(1);
    expect(f.notices.filter(notice => !notice.dismiss)).toMatchObject([{ dialogId: 'dlg' }]);
    f.service.onEvent({ type: 'run.state', runId: 'r', sessionId: 's', payload: { state: 'cancelled' } });
    expect(f.notices).toContainEqual({ dismiss: true, dialogId: 'dlg' });
  } finally { f.service.dispose(); }
});

test('the app drops the notice of a question once it is answered, and only that notice', () => {
  const news = { kind: 'approval', projectId: 'p', rootPath: '/repo', sessionId: 's', tone: 'needs', at: 1 };
  const question = noticeFrom({ ...news, permissionId: null, dialogId: 'dlg', title: 'repo needs your answer', body: 'tea or coffee?' });
  const approval = noticeFrom({ ...news, permissionId: 'approval', title: 'repo needs your approval', body: 'run command' });
  const engine = { key: 'engine', tone: 'needs', title: 'Local engine stopped', body: '' };
  // Main's dismissal { dismiss: true, dialogId } and the dialog.resolved event's payload both name the question by its id.
  expect(withoutAnswered([question, approval, engine], { dialogId: 'dlg' })).toEqual([approval, engine]);
  expect(withoutAnswered([question, approval, engine], { permissionId: 'approval' })).toEqual([question, engine]);
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

test('a run that showed nothing is not announced', async () => {
  const f = attentionFixture({ focused: false });
  try {
    f.service.onEvent({ type: 'run.state', runId: 'r', sessionId: 's', payload: { state: 'completed', quiet: true } });
    await Bun.sleep(1);
    expect(f.notifications).toHaveLength(0);
    expect(f.notices).toHaveLength(0);
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

test('a finished task says nothing its title already says', async () => {
  const f = attentionFixture({ focused: false });
  try {
    Object.assign(f.row, { session: { id: 's', title: 'look around' }, run: { id: 'r', prompt: 'look around', verification: { status: 'not_run' } } });
    f.service.onEvent({ type: 'run.state', runId: 'r', sessionId: 's', payload: { state: 'completed' } });
    await Bun.sleep(1);
    expect(f.notifications[0].options.title).toBe('repo · look around: done');
    expect(f.notifications[0].options.body).toBeUndefined();
    Object.assign(f.row, { changedFiles: 3, run: { id: 'r', prompt: 'look around', verification: { status: 'failed' } } });
    f.service.onEvent({ type: 'run.state', runId: 'r', sessionId: 's', payload: { state: 'completed' } });
    await Bun.sleep(1);
    expect(f.notifications[1].options.body).toBe('3 files changed · checks failed');
  } finally { f.service.dispose(); }
});

test('a run that answered while its process still runs background work is not announced as done', async () => {
  /** What `session.activity` answers for the conversation, by test step; a throw stands for an engine that cannot say. */
  let activity = /** @type {any} */ ({ state: 'background', tasks: [], truncated: false, updatedAt: new Date().toISOString() });
  const asked = [];
  const f = attentionFixture({ focused: false, read: async (method, params) => {
    if (method === 'board.list') return { projects: [f.row] };
    if (method === 'session.activity') { asked.push(params); if (activity instanceof Error) throw activity; return { activity }; }
    return { pendingPermissions: [], pendingDialogs: [] };
  } });
  try {
    Object.assign(f.row, { session: { id: 's', title: 'look around' } });
    const completed = { type: 'run.state', runId: 'r', sessionId: 's', payload: { state: 'completed' } };
    f.service.onEvent(completed);
    await Bun.sleep(1);
    expect(asked).toEqual([{ sessionId: 's' }]);
    expect(f.notifications[0].options).toMatchObject({ title: 'repo · look around: answered · background work running', silent: true });
    // Once its process is idle or answering again, or nothing says what it does, a finished run is done.
    for (const [state, title] of [['idle', 'repo · look around: done'], ['working', 'repo · look around: done']]) {
      activity = { ...activity, state };
      f.service.onEvent(completed);
      await Bun.sleep(1);
      expect(f.notifications.at(-1).options.title).toBe(title);
    }
    activity = null; // no process
    f.service.onEvent(completed);
    await Bun.sleep(1);
    expect(f.notifications.at(-1).options.title).toBe('repo · look around: done');
    activity = new Error('unknown method');
    f.service.onEvent(completed);
    await Bun.sleep(1);
    expect(f.notifications.at(-1).options.title).toBe('repo · look around: done');
    expect(f.notifications).toHaveLength(5);
  } finally { f.service.dispose(); }
});

test('the answered-with-background-work notice is muted in the app', async () => {
  const f = attentionFixture({ read: async method => method === 'board.list' ? { projects: [f.row] } : method === 'session.activity' ? { activity: { state: 'background', tasks: [], truncated: false, updatedAt: new Date().toISOString() } } : { pendingPermissions: [], pendingDialogs: [] } });
  try {
    f.service.onEvent({ type: 'run.state', runId: 'r', sessionId: 's', payload: { state: 'completed' } });
    await Bun.sleep(1);
    expect(f.notices).toMatchObject([{ title: 'repo: answered · background work running', tone: 'muted' }]);
  } finally { f.service.dispose(); }
});

test('browser uses native isolated mouse zoom and bounded keyboard shortcuts', () => {
  const contents = new EventEmitter();
  const session = Object.assign(new EventEmitter(), { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} });
  let factor = 1, mode = '', limits = [];
  const guest = Object.assign(new EventEmitter(), { id: 77, session,
    debugger: { attach() {}, async sendCommand() {} }, setWindowOpenHandler() {},
    setZoomMode(value) { mode = value; }, async setVisualZoomLevelLimits(min, max) { limits = [min, max]; },
    getZoomFactor() { return factor; }, setZoomFactor(value) { factor = value; },
  });
  installBrowserHost({ webContents: contents }, { log, sessionForPartition: () => session, onGuest() {} });
  contents.emit('did-attach-webview', {}, guest);
  expect(mode).toBe('isolated'); expect(limits).toEqual([1, 3]);
  guest.emit('before-input-event', { preventDefault() {} }, { type: 'keyDown', key: '+', meta: true }); expect(factor).toBeCloseTo(1.2);
  guest.emit('before-input-event', { preventDefault() {} }, { type: 'keyDown', key: '-', control: true }); expect(factor).toBeCloseTo(1);
  for (let i = 0; i < 100; i++) guest.emit('before-input-event', { preventDefault() {} }, { type: 'keyDown', key: '+', meta: true });
  expect(factor).toBe(3);
  for (let i = 0; i < 100; i++) guest.emit('before-input-event', { preventDefault() {} }, { type: 'keyDown', key: '-', control: true });
  expect(factor).toBe(0.5);
  guest.emit('before-input-event', { preventDefault() {} }, { type: 'keyDown', key: '0', meta: true });
  expect(factor).toBe(1);
  guest.emit('ipc-message', {}, 'jolo:browser:wheel-zoom', 'in');
  expect(factor).toBeCloseTo(1.1);
  guest.emit('ipc-message', {}, 'jolo:browser:wheel-zoom', 'invalid');
  expect(factor).toBeCloseTo(1.1);
});

test('refresh targets the visible browser from its page or toolbar and the desktop outside it', async () => {
  let reloads = 0, hardReloads = 0, prevented = 0, destroyed = false;
  let desktopReloads = 0, selectedGuest = 91;
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    executeJavaScript: async () => selectedGuest,
    reload: () => { desktopReloads++; }, reloadIgnoringCache: () => { desktopReloads++; },
  });
  const session = Object.assign(new EventEmitter(), { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} });
  const guest = Object.assign(new EventEmitter(), { id: 91, session,
    debugger: { attach() {}, async sendCommand() {} }, setWindowOpenHandler() {},
    setZoomMode() {}, async setVisualZoomLevelLimits() {},
    isDestroyed: () => destroyed,
    reload: () => { reloads++; }, reloadIgnoringCache: () => { hardReloads++; },
  });
  installBrowserHost({ webContents: contents }, { log, sessionForPartition: () => session, onGuest() {} });
  contents.emit('did-attach-webview', {}, guest);
  /** @param {any} input @param {EventEmitter} [source] */
  const key = async (input, source = guest) => {
    for (const listener of source.listeners('before-input-event')) await listener({ preventDefault() { prevented++; } }, { type: 'keyDown', ...input });
  };
  await key({ key: 'F5' });
  await key({ key: 'r', ...(process.platform === 'darwin' ? { meta: true } : { control: true }) });
  await key({ key: 'F5', shift: true });
  expect([reloads, hardReloads, prevented]).toEqual([2, 1, 3]);
  expect(desktopReloads).toBe(0);
  for (const input of [{ key: 'r' }, { key: 'F5', type: 'keyUp' }, { key: 'F5', alt: true }]) await key(input);
  expect([reloads, hardReloads, prevented]).toEqual([2, 1, 3]);
  await key({ key: 'F5', isAutoRepeat: true });
  expect([reloads, hardReloads, prevented]).toEqual([2, 1, 4]);
  await key({ key: 'F5' }, contents); // Address bar belongs to the application WebContents.
  expect([reloads, desktopReloads]).toEqual([3, 0]);
  selectedGuest = null;
  await key({ key: 'F5' }, contents);
  await key({ key: 'F5' }); // Stale native focus on a now-hidden browser.
  expect([reloads, desktopReloads]).toEqual([3, 2]);
  selectedGuest = 91;
  destroyed = true;
  await key({ key: 'F5' });
  expect([reloads, desktopReloads]).toEqual([3, 2]);
});
