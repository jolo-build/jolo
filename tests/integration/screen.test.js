// Whole-desktop control through the engine: per-task consent, dispatch to the desktop that provides
// the screen, a pause the moment the user takes over, and nothing replayed blind on resume.
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { startEngine, tempHome, waitFor, removeHome } from './helpers.js';
import { scriptedScreenHost, JPEG_BASE64 } from '../fixtures/scripted-screen-host.js';

const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function setup({ script, host = {}, withHost = true }) {
  const home = tempHome(); cleanup.push(() => removeHome(home));
  const repo = path.join(home, 'repo'); mkdirSync(repo, { recursive: true }); writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  const scriptPath = path.join(home, 'script.json'); writeFileSync(scriptPath, JSON.stringify(script));
  const engine = await startEngine({ home, env: { JOLO_FAKE_SCRIPT: scriptPath } }); cleanup.push(() => engine.stop());
  // An interactive client is attached, so permission requests wait for a decision instead of pausing.
  const client = await engine.connect({ clientKind: 'desktop' }); cleanup.push(() => client.close());
  const project = await client.call('project.open', { path: repo });
  const screen = withHost ? await scriptedScreenHost(engine, host) : null;
  if (screen) cleanup.push(() => screen.client.close());
  const { session, cursor } = await client.call('session.create', { projectId: project.projectId, workspaceId: project.workspaceId, title: 'screen' });
  const events = [];
  await client.subscribe({ after: cursor, sessionId: session.id }, { onEvent: (e) => events.push(e) });
  const { run } = await client.call('run.start', { sessionId: session.id, requestId: 'req_screen', prompt: 'open google in helium and search' });
  const state = async () => (await client.call('run.snapshot', { runId: run.id })).run;
  return { client, engine, session, screen, events, run, state };
}

const settled = (state, wanted = ['completed', 'failed', 'paused', 'cancelled']) => waitFor(async () => { const run = await state(); return wanted.includes(run.state) && run; }, { timeoutMs: 20_000, label: 'run settled' });

describe('screen control through the engine broker', () => {
  test('the first screen action asks for consent for the whole task; allowed, every later action runs without asking', async () => {
    const script = [
      { toolCalls: [{ name: 'screen_screenshot', arguments: {} }] },
      { toolCalls: [{ name: 'screen_windows', arguments: {} }, { name: 'screen_activate', arguments: { pid: 42 } }] },
      { toolCalls: [{ name: 'screen_pointer', arguments: { action: 'click', x: 10, y: 20, modifiers: [] } }, { name: 'screen_type', arguments: { text: 'cypho.io' } }, { name: 'screen_press', arguments: { key: 'Enter' } }] },
      { text: ['Searched.\n'] },
    ];
    const { client, screen, events, state, session } = await setup({ script });
    const requested = await waitFor(() => events.find(e => e.type === 'permission.requested')?.payload, { timeoutMs: 10_000, label: 'consent requested' });
    expect(requested).toMatchObject({ kind: 'screen', decisions: ['allow_run', 'deny'], tool: 'screen_screenshot' });
    expect(requested.summary).toContain('control its mouse and keyboard');
    expect(screen.received).toHaveLength(0); // nothing reaches the screen before consent
    // A reload of the session shows the same narrowed request.
    const page = await client.call('session.page', { sessionId: session.id });
    expect(page.pendingPermissions[0]).toMatchObject({ kind: 'screen', decisions: ['allow_run', 'deny'] });
    const { projects } = await client.call('board.list', {});
    expect(projects.find(row => row.run?.sessionId === session.id)?.pendingPermission).toMatchObject({ kind: 'screen', decisions: ['allow_run', 'deny'] });
    // One click or a whole project is not a choice for screen control.
    for (const decision of ['allow_once', 'allow_project']) await expect(client.call('permission.resolve', { permissionId: requested.permissionId, decision })).rejects.toMatchObject({ code: 'invalid_params' });
    await client.call('permission.resolve', { permissionId: requested.permissionId, decision: 'allow_run' });
    const run = await settled(state);
    expect(run.state).toBe('completed');
    expect(screen.received.map(r => r.operation)).toEqual(['screenshot', 'windows', 'activate', 'pointer', 'type', 'press']);
    expect(screen.received[3]).toMatchObject({ runId: run.id, capabilityId: screen.capabilityId, arguments: { action: 'click', x: 10, y: 20, modifiers: [] } });
    expect(events.filter(e => e.type === 'permission.requested')).toHaveLength(1);
    // The screenshot reached the model as an image; the events that clients read never carry pixels.
    const shot = events.find(e => e.type === 'tool.completed' && e.payload.name === 'screen_screenshot').payload;
    expect(shot.status).toBe('ok');
    const artifact = await client.call('artifact.read', { artifactId: shot.resultArtifactId, encoding: 'base64' });
    expect(artifact).toMatchObject({ kind: 'screenshot', text: JPEG_BASE64 });
    expect(JSON.stringify(events)).not.toContain(JPEG_BASE64);
  });

  test('declining consent reaches nothing on the screen and pauses the task', async () => {
    const script = [{ toolCalls: [{ name: 'screen_screenshot', arguments: {} }] }, { text: ['unreachable\n'] }];
    const { client, screen, events, state } = await setup({ script });
    const requested = await waitFor(() => events.find(e => e.type === 'permission.requested')?.payload, { timeoutMs: 10_000, label: 'consent requested' });
    await client.call('permission.resolve', { permissionId: requested.permissionId, decision: 'deny' });
    const run = await settled(state);
    expect(run).toMatchObject({ state: 'paused', pauseReason: 'user' });
    expect(screen.received).toHaveLength(0);
  });

  test('when the user takes over, the run pauses at once, later screen actions in the batch are recorded as not executed, and resume continues under the same consent', async () => {
    const script = [
      { toolCalls: [{ name: 'screen_screenshot', arguments: {} }] },
      { toolCalls: [{ name: 'screen_pointer', arguments: { action: 'click', x: 1, y: 1, modifiers: [] } }, { name: 'screen_type', arguments: { text: 'secret plan' } }, { name: 'read_file', arguments: { path: 'README.md' } }] },
      { toolCalls: [{ name: 'screen_screenshot', arguments: {} }] },
      { text: ['Continued after you were done.\n'] },
    ];
    const { client, engine, screen, events, state, session } = await setup({ script, host: { interruptOn: ['pointer'] } });
    cleanup.push(() => screen.client.close());
    const requested = await waitFor(() => events.find(e => e.type === 'permission.requested')?.payload, { timeoutMs: 10_000, label: 'consent requested' });
    await client.call('permission.resolve', { permissionId: requested.permissionId, decision: 'allow_run' });
    const paused = await settled(state);
    expect(paused).toMatchObject({ state: 'paused', pauseReason: 'user' });
    expect(screen.received.map(r => r.operation)).toEqual(['screenshot', 'pointer']); // type never reached the screen
    const completed = events.filter(e => e.type === 'tool.completed').map(e => e.payload);
    expect(completed.map(c => `${c.name}:${c.status}:${c.errorCode ?? ''}`)).toEqual(['screen_screenshot:ok:', 'screen_pointer:error:user_input', 'screen_type:cancelled:not_executed']);
    // Resume with the user done: the pending read runs, the skipped screen call is not replayed, and no
    // new consent is asked. A fresh desktop host stands in for the user letting go of the mouse.
    await screen.client.close();
    const fresh = await scriptedScreenHost(engine);
    cleanup.push(() => fresh.client.close());
    await client.call('run.resume', { runId: paused.id });
    const done = await settled(state, ['completed', 'failed', 'cancelled']);
    expect(done.state).toBe('completed');
    expect(fresh.received.map(r => r.operation)).toEqual(['screenshot']);
    expect(events.filter(e => e.type === 'permission.requested')).toHaveLength(1);
    await engine.stop();
    const db = new Database(engine.paths.databasePath, { readonly: true });
    try {
      const results = db.query("SELECT payload FROM conversation_items WHERE session_id = ?1 AND kind = 'tool_result' ORDER BY ordinal").all(session.id).map(row => JSON.parse(row.payload));
      expect(results.filter(r => r.output.includes('not_executed'))).toHaveLength(1);
      expect(results[0].images).toEqual([{ artifactId: expect.stringMatching(/^art/), mimeType: 'image/jpeg', width: 1, height: 1, bytes: expect.any(Number) }]);
    } finally { db.close(); }
  }, 40_000);

  test('without a desktop screen, screen tools are refused before any consent is asked', async () => {
    const script = [{ toolCalls: [{ name: 'screen_screenshot', arguments: {} }] }, { text: ['no screen\n'] }];
    const { events, state } = await setup({ script, withHost: false });
    const run = await settled(state);
    expect(run.state).toBe('completed');
    expect(events.some(e => e.type === 'permission.requested')).toBe(false);
    expect(events.find(e => e.type === 'tool.completed').payload).toMatchObject({ status: 'error', errorCode: 'unavailable' });
  });

  test('a missing macOS permission is refused before the desktop is asked, with where to turn it on', async () => {
    const script = [{ toolCalls: [{ name: 'screen_screenshot', arguments: {} }] }, { text: ['told the user\n'] }];
    const { client, engine, screen, events, state, session } = await setup({ script, host: { permissions: { accessibility: true, screenRecording: false } } });
    const requested = await waitFor(() => events.find(e => e.type === 'permission.requested')?.payload, { timeoutMs: 10_000, label: 'consent requested' });
    await client.call('permission.resolve', { permissionId: requested.permissionId, decision: 'allow_run' });
    const run = await settled(state);
    expect(run.state).toBe('completed');
    expect(screen.received).toHaveLength(0);
    expect(events.find(e => e.type === 'tool.completed').payload).toMatchObject({ name: 'screen_screenshot', status: 'error', errorCode: 'missing_screen_recording' });
    await engine.stop();
    const db = new Database(engine.paths.databasePath, { readonly: true });
    try {
      const output = JSON.parse(db.query("SELECT payload FROM conversation_items WHERE session_id = ?1 AND kind = 'tool_result'").get(session.id).payload).output;
      expect(output).toContain('Privacy & Security');
    } finally { db.close(); }
  });

  test('losing the desktop mid-action pauses the task with screen_host_unavailable', async () => {
    const script = [{ toolCalls: [{ name: 'screen_screenshot', arguments: {} }] }, { text: ['unreachable\n'] }];
    const { client, events, state } = await setup({ script, host: { vanishOn: ['screenshot'] } });
    const requested = await waitFor(() => events.find(e => e.type === 'permission.requested')?.payload, { timeoutMs: 10_000, label: 'consent requested' });
    await client.call('permission.resolve', { permissionId: requested.permissionId, decision: 'allow_run' });
    const run = await settled(state);
    expect(run).toMatchObject({ state: 'paused', pauseReason: 'screen_host_unavailable' });
    expect(events.find(e => e.type === 'tool.completed').payload).toMatchObject({ status: 'error', errorCode: 'screen_host_unavailable' });
  });
});
