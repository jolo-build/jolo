import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Storage } from '../src/storage/index.js';
import { RunService } from '../src/runs/service.js';
import { createScheduler } from '../src/scheduler/index.js';

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'jolo-schedules-'));
  const storage = new Storage({ databasePath: path.join(root, 'db'), artifactsDir: path.join(root, 'artifacts'), bootId: 'test' });
  const project = storage.upsertProject({ identity: root, rootPath: root });
  const workspace = storage.ensureDirectWorkspace(project.id, root);
  const session = storage.createSession({ projectId: project.id, workspaceId: workspace.id, title: 'orchestrator' });
  let work = 0, clock = Date.now();
  const runs = new RunService({ storage, log: { error() {}, warn() {} },
    lifetime: { workStarted() { work++; }, workFinished() { work--; } },
    executor: { execute: async () => ({ outcome: 'completed' }) },
  });
  const scheduler = createScheduler({ storage, runs, lifetime: { workStarted() { work++; }, workFinished() { work--; } }, log: { info() {}, warn() {}, error() {} }, nowMs: () => clock });
  return { root, storage, project, workspace, session, runs, scheduler,
    work: () => work,
    advance: (ms) => { clock += ms; },
    sessionRuns: () => storage.listRunsForSession(session.id),
    async close() { scheduler.stop(); await runs.stopAll(); storage.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

test('a schedule wakes its session on the interval and holds the engine alive', async () => {
  const f = fixture();
  try {
    const { schedule } = f.scheduler.create({ sessionId: f.session.id, prompt: 'check in', everyMs: 15 * 60_000 });
    expect(schedule.state).toBe('active');
    expect(f.work()).toBe(1); // an active schedule is work: the engine must not idle out
    expect(f.sessionRuns()).toHaveLength(0);

    f.advance(15 * 60_000 + 1);
    f.scheduler.pump();
    const fired = f.storage.getSchedule(schedule.id);
    expect(fired.fireCount).toBe(1);
    expect(Date.parse(fired.nextFireAt)).toBeGreaterThan(Date.parse(schedule.nextFireAt));
    const runsList = f.sessionRuns();
    expect(runsList).toHaveLength(1);
    expect(runsList[0].prompt).toBe('[scheduled check-in]\n\ncheck in');
    expect(fired.lastRunId).toBe(runsList[0].id);
    await Bun.sleep(0);
    expect(runsList.map((r) => f.storage.getRun(r.id).state)).toEqual(['completed']);
  } finally { await f.close(); }
});

test('an engine that slept through beats fires once, not a backlog', async () => {
  const f = fixture();
  try {
    const { schedule } = f.scheduler.create({ sessionId: f.session.id, prompt: 'check in', everyMs: 60_000 });
    f.advance(3.5 * 60_000); // three beats missed
    f.scheduler.pump();
    const fired = f.storage.getSchedule(schedule.id);
    expect(fired.fireCount).toBe(1);
    expect(f.sessionRuns()).toHaveLength(1);
    // The next slot is in the future: missed beats are skipped, not caught up.
    const next = Date.parse(fired.nextFireAt);
    expect(next).toBeGreaterThan(Date.now());
    expect(next).toBeLessThanOrEqual(Date.parse(schedule.nextFireAt) + 4 * 60_000 + 1000);
  } finally { await f.close(); }
});

test('paused and cancelled schedules never fire; cancelling releases the engine', async () => {
  const f = fixture();
  try {
    const { schedule } = f.scheduler.create({ sessionId: f.session.id, prompt: 'check in', everyMs: 60_000 });
    f.scheduler.pause(schedule.id);
    f.advance(10 * 60_000);
    f.scheduler.pump();
    expect(f.sessionRuns()).toHaveLength(0);
    expect(f.storage.getSchedule(schedule.id).state).toBe('paused');
    expect(f.work()).toBe(0); // nothing active, nothing to stay alive for

    const { schedule: resumed } = f.scheduler.resume(schedule.id);
    expect(resumed.state).toBe('active');
    expect(Date.parse(resumed.nextFireAt)).toBeGreaterThan(Date.now()); // fresh interval, no stale fire
    expect(f.work()).toBe(1);
    f.scheduler.pump();
    expect(f.sessionRuns()).toHaveLength(0); // resumed interval has not elapsed

    f.scheduler.cancel(schedule.id);
    expect(f.storage.getSchedule(schedule.id).state).toBe('cancelled');
    expect(f.work()).toBe(0);
    f.advance(60_000);
    f.scheduler.pump();
    expect(f.sessionRuns()).toHaveLength(0);
  } finally { await f.close(); }
});

test('a schedule whose task was deleted cancels itself; an archived task pauses it', async () => {
  const f = fixture();
  try {
    const gone = f.storage.createSession({ projectId: f.project.id, workspaceId: f.workspace.id, title: 'gone' });
    const archived = f.storage.createSession({ projectId: f.project.id, workspaceId: f.workspace.id, title: 'archived' });
    const { schedule: dead } = f.scheduler.create({ sessionId: gone.id, prompt: 'wake', everyMs: 60_000 });
    const { schedule: held } = f.scheduler.create({ sessionId: archived.id, prompt: 'wake', everyMs: 60_000 });
    f.storage.updateSession(gone.id, { deleted: true });
    f.storage.updateSession(archived.id, { state: 'archived' });
    f.advance(60_000);
    f.scheduler.pump();
    expect(f.storage.getSchedule(dead.id).state).toBe('cancelled');
    expect(f.storage.getSchedule(held.id).state).toBe('paused');
    expect(f.storage.getSchedule(held.id).lastError).toContain('archived');
  } finally { await f.close(); }
});

test('a beat whose workspace is gone pauses the schedule rather than burst-failing', async () => {
  const f = fixture();
  try {
    const { schedule } = f.scheduler.create({ sessionId: f.session.id, prompt: 'check in', everyMs: 60_000 });
    f.storage.markWorkspaceRemoved(f.workspace.id); // runs.start would refuse this workspace
    f.advance(60_000);
    f.scheduler.pump();
    const fired = f.storage.getSchedule(schedule.id);
    expect(fired.state).toBe('paused');
    expect(fired.fireCount).toBe(0); // nothing started
    expect(fired.lastError).toContain('workspace');
    expect(f.sessionRuns()).toHaveLength(0);
    expect(f.work()).toBe(0); // paused schedules do not hold the engine
  } finally { await f.close(); }
});

test('a beat due while the task is mid-turn is skipped, not queued', async () => {
  const f = fixture();
  try {
    const { schedule } = f.scheduler.create({ sessionId: f.session.id, prompt: 'check in', everyMs: 60_000 });
    const { run } = f.runs.start({ sessionId: f.session.id, requestId: 'live', prompt: 'user turn' });
    f.advance(60_000);
    f.scheduler.pump();
    const fired = f.storage.getSchedule(schedule.id);
    expect(fired.fireCount).toBe(0); // the live turn owns the task
    expect(fired.lastError).toContain('in progress');
    expect(Date.parse(fired.nextFireAt)).toBeGreaterThan(Date.parse(schedule.nextFireAt));
    expect(f.sessionRuns()).toHaveLength(1);
    await f.runs.stopAll();
  } finally { await f.close(); }
});

test('a beat that cannot start a run advances the slot and records the error', async () => {
  const f = fixture();
  try {
    f.runs.start = () => { throw new Error('executor offline'); };
    const { schedule } = f.scheduler.create({ sessionId: f.session.id, prompt: 'check in', everyMs: 60_000 });
    f.advance(60_000);
    f.scheduler.pump();
    const fired = f.storage.getSchedule(schedule.id);
    expect(fired.state).toBe('active'); // transient failure does not pause the heartbeat
    expect(fired.fireCount).toBe(0);
    expect(fired.lastError).toContain('executor offline');
    expect(Date.parse(fired.nextFireAt)).toBeGreaterThan(Date.parse(schedule.nextFireAt));
    expect(f.sessionRuns()).toHaveLength(0);
  } finally { await f.close(); }
});

test('each firing is its own run with its own request id', async () => {
  const f = fixture();
  try {
    f.scheduler.create({ sessionId: f.session.id, prompt: 'check in', everyMs: 60_000 });
    f.advance(60_000); f.scheduler.pump();
    for (let i = 0; i < 40 && f.sessionRuns().some(run => !['completed', 'failed', 'cancelled'].includes(f.storage.getRun(run.id).state)); i++) await Bun.sleep(10);
    f.advance(60_000); f.scheduler.pump();
    const runsList = f.sessionRuns();
    expect(runsList).toHaveLength(2);
    expect(new Set(runsList.map((run) => run.requestId)).size).toBe(2);
  } finally { await f.close(); }
});

test('a capability credential manages only its own task’s schedules', async () => {
  const f = fixture();
  try {
    const { createRpcHandlers } = await import('../src/rpc/handlers.js');
    const other = f.storage.createSession({ projectId: f.project.id, workspaceId: f.workspace.id, title: 'other' });
    const { run } = f.runs.start({ sessionId: f.session.id, requestId: 'r1', prompt: 'work' });
    const conn = { capability: { runId: run.id, workspaceId: f.workspace.id } };
    const handlers = createRpcHandlers(/** @type {any} */ ({ storage: f.storage, schedules: f.scheduler }));

    // The credential names the session; a supplied sessionId is ignored.
    const { schedule } = await handlers['schedule.create']({ workspaceId: f.workspace.id, sessionId: other.id, prompt: 'wake', everyMs: 60_000 }, conn);
    expect(schedule.sessionId).toBe(f.session.id);

    const { schedules } = await handlers['schedule.list']({ workspaceId: f.workspace.id }, conn);
    expect(schedules.map((s) => s.id)).toEqual([schedule.id]);

    // Pausing another task's schedule is denied; its own is fine.
    const { schedule: foreign } = f.scheduler.create({ sessionId: other.id, prompt: 'x', everyMs: 60_000 });
    await expect(handlers['schedule.pause']({ scheduleId: foreign.id, workspaceId: f.workspace.id }, conn)).rejects.toThrow('unknown schedule for this task');
    const { schedule: paused } = await handlers['schedule.pause']({ scheduleId: schedule.id, workspaceId: f.workspace.id }, conn);
    expect(paused.state).toBe('paused');
  } finally { await f.close(); }
});

test('the shared interval spelling parses and bounds what the schema accepts', () => {
  const { parseEveryMs, SCHEDULE_LIMITS } = require('@jolo/protocol');
  expect(parseEveryMs('15m')).toBe(900_000);
  expect(parseEveryMs('1h')).toBe(3_600_000);
  expect(parseEveryMs('2d')).toBe(172_800_000);
  expect(parseEveryMs('15m'.toUpperCase())).toBe(900_000);
  expect(parseEveryMs('every 15 minutes')).toBeNull();
  expect(parseEveryMs('30s')).toBeNull(); // below the minimum
  expect(parseEveryMs('30d')).toBeNull(); // beyond the maximum
  expect(parseEveryMs(`${SCHEDULE_LIMITS.minEveryMs / 60_000}m`)).toBe(SCHEDULE_LIMITS.minEveryMs);
});

test('archiving, restoring, and deleting a task carries its schedules with it', async () => {
  const f = fixture();
  try {
    const { createRpcHandlers } = await import('../src/rpc/handlers.js');
    const handlers = createRpcHandlers(/** @type {any} */ ({ storage: f.storage, schedules: f.scheduler }));
    const { schedule } = f.scheduler.create({ sessionId: f.session.id, prompt: 'wake', everyMs: 60_000 });
    expect(f.work()).toBe(1);

    let session = f.storage.getSession(f.session.id);
    await handlers['session.archive']({ sessionId: f.session.id, expectedRevision: session.revision, archived: true }, {});
    let current = f.storage.getSchedule(schedule.id);
    expect(current.state).toBe('paused');
    expect(current.lastError).toContain('archived');
    expect(f.work()).toBe(0); // nothing active, so nothing keeps the engine resident

    session = f.storage.getSession(f.session.id);
    await handlers['session.archive']({ sessionId: f.session.id, expectedRevision: session.revision, archived: false }, {});
    current = f.storage.getSchedule(schedule.id);
    expect(current.state).toBe('active'); // paused only by the archive, so the restore restarts it
    expect(Date.parse(current.nextFireAt)).toBeGreaterThan(Date.now());
    expect(f.work()).toBe(1);

    session = f.storage.getSession(f.session.id);
    await handlers['session.delete']({ sessionId: f.session.id, expectedRevision: session.revision }, {});
    expect(f.storage.getSchedule(schedule.id).state).toBe('cancelled');
    expect(f.work()).toBe(0);
  } finally { await f.close(); }
});

test('a paused or permission-waiting run does not hold back a heartbeat', async () => {
  const f = fixture();
  try {
    const { schedule } = f.scheduler.create({ sessionId: f.session.id, prompt: 'check in', everyMs: 60_000 });
    const { run } = f.runs.start({ sessionId: f.session.id, requestId: 'live', prompt: 'user turn' });
    f.storage.updateRunState(run.id, 'paused', { pauseReason: 'user' });
    f.advance(60_000);
    f.scheduler.pump();
    expect(f.storage.getSchedule(schedule.id).fireCount).toBe(1); // the paused turn is settled, not in progress

    await Bun.sleep(0); // let the heartbeat's own run settle so the task is idle again
    f.storage.updateRunState(run.id, 'awaiting_permission');
    f.advance(60_000);
    f.scheduler.pump();
    expect(f.storage.getSchedule(schedule.id).fireCount).toBe(2);
  } finally { await f.close(); }
});

test('resume refuses a schedule whose task cannot run', async () => {
  const f = fixture();
  try {
    const { schedule } = f.scheduler.create({ sessionId: f.session.id, prompt: 'wake', everyMs: 60_000 });
    f.scheduler.pause(schedule.id);
    // A user pause on a live task resumes normally.
    expect(f.scheduler.resume(schedule.id).schedule.state).toBe('active');

    f.scheduler.pause(schedule.id);
    f.storage.updateSession(f.session.id, { state: 'archived' });
    expect(() => f.scheduler.resume(schedule.id)).toThrow(/archived/);
    expect(f.storage.getSchedule(schedule.id).state).toBe('paused');
  } finally { await f.close(); }
});

test('a failure inside a fire advances the slot and backs the pump off', async () => {
  const f = fixture();
  try {
    const { schedule } = f.scheduler.create({ sessionId: f.session.id, prompt: 'check in', everyMs: 60_000 });
    const realTransaction = f.storage.transaction.bind(f.storage);
    f.storage.transaction = () => { throw new Error('disk wedged'); };
    f.advance(60_000);
    expect(f.scheduler.pump()).toBe(false); // the tick floors its re-arm instead of tight-looping
    const fired = f.storage.getSchedule(schedule.id);
    expect(fired.fireCount).toBe(0);
    expect(fired.lastError).toContain('disk wedged');
    expect(Date.parse(fired.nextFireAt)).toBeGreaterThan(Date.parse(schedule.nextFireAt)); // the slot moved past the failed beat
    f.storage.transaction = realTransaction;
    f.advance(60_000);
    expect(f.scheduler.pump()).toBe(true);
    expect(f.storage.getSchedule(schedule.id).fireCount).toBe(1); // the recovered store fires the next slot
  } finally { await f.close(); }
});
