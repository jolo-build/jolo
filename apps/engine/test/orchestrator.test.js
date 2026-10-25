import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Storage } from '../src/storage/index.js';
import { RunService } from '../src/runs/service.js';
import { createOrchestrator } from '../src/orchestrator/index.js';

const activity = state => ({ state, tasks: [], truncated: false, updatedAt: new Date().toISOString() });
const open = [];
afterEach(async () => { for (const f of open.splice(0)) await f.close(); });

/** A plan engine whose agent answers at once; a task titled in `background` leaves its process working in the background. */
function fixture({ background = [], outcome = 'completed' } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'jolo-orchestrator-'));
  const storage = new Storage({ databasePath: path.join(root, 'db'), artifactsDir: path.join(root, 'artifacts'), bootId: 'test' });
  const project = storage.upsertProject({ identity: root, rootPath: root });
  storage.ensureDirectWorkspace(project.id, root);
  // What each conversation's process is doing, as the hosted links report it; no entry is no live process. A session in
  // `due` has background work that has just finished and is about to be reported.
  const links = { activities: new Map(), due: new Set(), get(id) { const a = this.activities.get(id); return a ? { activity: a, working: a.state !== 'idle' || this.due.has(id) } : null; } };
  const runs = new RunService({ storage, log: { error() {}, warn() {} }, lifetime: { workStarted() {}, workFinished() {} },
    executor: { async execute(ctx) {
      const session = storage.getSession(ctx.run.sessionId);
      if (background.includes(session.title)) links.activities.set(session.id, activity('background'));
      return outcome === 'failed' ? { outcome, failure: 'it broke' } : { outcome };
    } } });
  const plans = createOrchestrator({ storage, runs, catalog: { get() { throw new Error('no agents here'); } }, log: { info() {}, warn() {}, error() {} }, links });
  const f = { storage, runs, plans, links,
    plan(titles) { return plans.create({ projectId: project.id, workspaceId: null, goal: 'do the work', tasks: titles.map(title => ({ title, brief: title })), policy: {} }).plan; },
    task(planId, title) { return plans.get(planId).tasks.find(task => task.title === title); },
    run(planId, title) {
      const execution = storage.listPlanExecutions(planId).find(entry => entry.taskId === f.task(planId, title).id);
      return execution?.runId ? storage.getRun(execution.runId) : null;
    },
    /** A conversation's process says what it is doing, as the engine reports it. */
    report(sessionId, state) { links.activities.set(sessionId, activity(state)); storage.appendEvent({ sessionId, type: 'session.activity', payload: activity(state) }); },
    async close() { plans.close(); await runs.stopAll(); storage.close(); rmSync(root, { recursive: true, force: true }); },
  };
  open.push(f);
  return f;
}

async function until(check, label, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting until ${label}`);
    await Bun.sleep(5);
  }
}

test('a task whose run completes while its process works in the background finishes once the process is idle', async () => {
  const f = fixture({ background: ['first'] });
  const plan = f.plan(['first', 'second']);
  f.plans.start({ planId: plan.id, expectedRevision: plan.revision });
  await until(() => f.run(plan.id, 'first')?.state === 'completed', 'the first run completed');
  expect(f.task(plan.id, 'first')).toMatchObject({ state: 'running', summary: 'finishing background work' });
  expect(f.task(plan.id, 'second').state).toBe('pending'); // one task at a time: the next waits for this one's process
  const { sessionId } = f.task(plan.id, 'first');
  f.report(sessionId, 'working'); // the process reports its finished work in a turn of its own
  expect(f.task(plan.id, 'first').state).toBe('running');
  f.report(sessionId, 'idle');
  expect(f.task(plan.id, 'first').state).toBe('done');
  await until(() => f.plans.get(plan.id).plan.state === 'done', 'the plan finished');
  expect(f.plans.get(plan.id).tasks.map(task => task.state)).toEqual(['done', 'done']);
});

test('a run that fails while its process works in the background settles at once', async () => {
  const f = fixture({ background: ['only'], outcome: 'failed' });
  const plan = f.plan(['only']);
  f.plans.start({ planId: plan.id, expectedRevision: plan.revision });
  await until(() => f.run(plan.id, 'only')?.state === 'failed', 'the run failed');
  expect(f.task(plan.id, 'only')).toMatchObject({ state: 'failed', summary: 'it broke' });
  expect(f.plans.get(plan.id).plan.state).toBe('failed');
});

test('a task waits while finished background work is still to be reported, and finishes when its process ends', async () => {
  const f = fixture({ background: ['only'] });
  const plan = f.plan(['only']);
  f.plans.start({ planId: plan.id, expectedRevision: plan.revision });
  await until(() => f.run(plan.id, 'only')?.state === 'completed', 'the run completed');
  const { sessionId } = f.task(plan.id, 'only');
  f.links.due.add(sessionId);
  f.report(sessionId, 'idle'); // its background work ended; the turn that reports it has not begun
  expect(f.task(plan.id, 'only')).toMatchObject({ state: 'running', summary: 'finishing background work' });
  f.links.activities.delete(sessionId); // the process ends before it reports, which tells nobody
  await until(() => f.task(plan.id, 'only').state === 'done', 'the task finished');
  expect(f.plans.get(plan.id).plan.state).toBe('done');
});
