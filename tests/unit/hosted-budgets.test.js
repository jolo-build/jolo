import { expect, test } from 'bun:test';
import { executeHosted } from '../../apps/engine/src/agents/executor.js';

function fixture(execute, budgets = {}, interactive = 1) {
  const run = { id: 'run', state: 'preparing' };
  return executeHosted({
    ctx: { run, signal: new AbortController().signal, transition: state => { run.state = state; } },
    manifest: {}, adapter: { execute }, tickMs: 5,
    storage: { getRun: () => run, pendingPermissionForRun: () => ({ id: 'permission' }) },
    budget: { maxActiveMs: 1000, toolDeadlineMs: 1000, maxIterations: 5, ...budgets }, interactiveClients: () => interactive,
  });
}
const wait = ctx => new Promise(resolve => ctx.signal.addEventListener('abort', () => resolve({ outcome: 'cancelled' }), { once: true }));
test('hosted active and tool deadlines pause instead of holding the run indefinitely', async () => {
  expect(await fixture(ctx => { ctx.transition('model'); return wait(ctx); }, { maxActiveMs: 15 })).toMatchObject({ outcome: 'paused', pauseReason: 'budget', detail: 'active time budget reached' });
  expect(await fixture(ctx => { ctx.transition('tools'); ctx.toolStarted('tool'); return wait(ctx); }, { toolDeadlineMs: 15 })).toMatchObject({ outcome: 'paused', detail: 'hosted tool deadline reached' });
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
  }, { toolDeadlineMs: 15, maxActiveMs: 45 })).toMatchObject({ outcome: 'paused', detail: 'active time budget reached' });
});

test('backgrounding one command does not exempt another blocked tool', async () => {
  expect(await fixture(ctx => {
    ctx.toolStarted('server'); ctx.toolBackgrounded('server');
    ctx.toolStarted('other');
    return wait(ctx);
  }, { toolDeadlineMs: 15 })).toMatchObject({ outcome: 'paused', detail: 'hosted tool deadline reached' });
});
