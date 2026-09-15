import { expect, test } from 'bun:test';
import { executeHosted } from '../src/agents/executor.js';
import { BudgetSettingsSchema } from '@jolo/protocol';
import { SettingsService } from '../src/settings.js';

function fixture(execute, budgets = {}, interactive = 1, signal = new AbortController().signal) {
  const run = { id: 'run', state: 'preparing' };
  return executeHosted({
    ctx: { run, signal, transition: state => { run.state = state; } },
    manifest: {}, adapter: { execute }, tickMs: 5,
    storage: { getRun: () => run, pendingPermissionForRun: () => ({ id: 'permission' }) },
    budget: { maxActiveMs: 1000, toolDeadlineMs: 1000, hostedToolDeadlineMs: null, maxIterations: 5, ...budgets }, interactiveClients: () => interactive,
  });
}
const wait = ctx => new Promise(resolve => ctx.signal.addEventListener('abort', () => resolve({ outcome: 'cancelled' }), { once: true }));
test('hosted tools can outlive the native tool deadline by default', async () => {
  expect(BudgetSettingsSchema.parse({ toolDeadlineMs: 120_000 }).hostedToolDeadlineMs).toBeNull();
  expect(await fixture(async ctx => {
    ctx.transition('tools'); ctx.toolStarted('long-test');
    await Bun.sleep(60);
    ctx.toolFinished('long-test');
    return { outcome: 'completed' };
  }, { toolDeadlineMs: 15 })).toMatchObject({ outcome: 'completed' });
});

test('hosted active and explicitly configured tool deadlines pause instead of holding the run indefinitely', async () => {
  expect(await fixture(ctx => { ctx.transition('model'); return wait(ctx); }, { maxActiveMs: 15 })).toMatchObject({ outcome: 'paused', pauseReason: 'budget', detail: 'active time budget reached' });
  expect(await fixture(ctx => { ctx.transition('tools'); ctx.toolStarted('tool'); return wait(ctx); }, { hostedToolDeadlineMs: 15 })).toMatchObject({ outcome: 'paused', detail: 'hosted tool deadline reached' });
  expect(await fixture(ctx => { ctx.transition('tools'); ctx.toolStarted('tool'); return wait(ctx); }, { toolDeadlineMs: 15, maxActiveMs: 45 })).toMatchObject({ outcome: 'paused', detail: 'active time budget reached' });
});
test('hosted iteration limit counts model phases, not repeated text deltas', async () => {
  expect(await fixture(async ctx => { ctx.transition('model'); ctx.transition('model'); ctx.transition('tools'); ctx.transition('model'); return { outcome: 'completed' }; }, { maxIterations: 1 })).toMatchObject({ outcome: 'paused', detail: 'iteration budget reached' });
});
test('a detached hosted approval pauses durably with its permission id', async () => {
  expect(await fixture(ctx => { ctx.transition('awaiting_permission'); return wait(ctx); }, {}, 0)).toMatchObject({ outcome: 'paused', pauseReason: 'permission', permissionId: 'permission' });
});

test('a background command retains the task budget without timing out as a foreground tool', async () => {
  expect(await fixture(ctx => {
    ctx.transition('tools'); ctx.toolStarted('server');
    ctx.toolBackgrounded('server'); ctx.transition('model');
    return wait(ctx);
  }, { hostedToolDeadlineMs: 15, maxActiveMs: 45 })).toMatchObject({ outcome: 'paused', detail: 'active time budget reached' });
});

test('backgrounding one command does not exempt another blocked tool', async () => {
  expect(await fixture(ctx => {
    ctx.toolStarted('server'); ctx.toolBackgrounded('server');
    ctx.toolStarted('other');
    return wait(ctx);
  }, { hostedToolDeadlineMs: 15 })).toMatchObject({ outcome: 'paused', detail: 'hosted tool deadline reached' });
});

test('a new foreground wait gets a fresh deadline after background execution', async () => {
  expect(await fixture(async ctx => {
    ctx.toolStarted('server'); ctx.toolBackgrounded('server');
    await Bun.sleep(60);
    ctx.toolStarted('server');
    await Bun.sleep(10);
    ctx.toolFinished('server');
    return { outcome: 'completed' };
  }, { hostedToolDeadlineMs: 30 })).toMatchObject({ outcome: 'completed' });
});

test('long hosted tools still respond to user cancellation', async () => {
  const controller = new AbortController();
  const result = fixture(ctx => {
    ctx.transition('tools'); ctx.toolStarted('long-test');
    return wait(ctx);
  }, { toolDeadlineMs: 15 }, 1, controller.signal);
  await Bun.sleep(60);
  controller.abort();
  expect(await result).toEqual({ outcome: 'cancelled' });
});

test('waiting for approval does not consume active time or an optional tool deadline', async () => {
  expect(await fixture(async ctx => {
    ctx.toolStarted('tool'); ctx.transition('awaiting_permission');
    await Bun.sleep(60);
    ctx.transition('tools'); ctx.toolFinished('tool');
    return { outcome: 'completed' };
  }, { hostedToolDeadlineMs: 15, maxActiveMs: 30 })).toEqual({ outcome: 'completed' });
});

test('stored native budgets do not enable hosted deadlines; hosted settings persist and clear independently', () => {
  const prefs = new Map([['budgets', { toolDeadlineMs: 120_000, maxActiveMs: 60_000 }]]);
  const storage = { getPreference: key => prefs.get(key), setPreference: (key, value) => prefs.set(key, value), transaction: fn => fn() };
  const service = new SettingsService(storage);
  expect(service.get().budgets.hostedToolDeadlineMs).toBeNull();
  service.update({ budgets: { hostedToolDeadlineMs: 600_000 } });
  service.update({ budgets: { maxIterations: 10 } });
  expect(new SettingsService(storage).get().budgets).toEqual({ toolDeadlineMs: 120_000, hostedToolDeadlineMs: 600_000, maxActiveMs: 60_000, maxIterations: 10 });
  service.update({ budgets: { hostedToolDeadlineMs: null } });
  expect(new SettingsService(storage).get().budgets.hostedToolDeadlineMs).toBeNull();
  for (const invalid of [0, -1, 999, Infinity, '600000']) expect(() => service.update({ budgets: { hostedToolDeadlineMs: invalid } })).toThrow();
});
