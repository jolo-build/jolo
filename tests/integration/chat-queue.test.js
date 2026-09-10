import { afterEach, expect, test } from 'bun:test';
import { startEngine, tempHome, openSession, waitFor, removeHome } from './helpers.js';

const engines = [], homes = [];
afterEach(async () => { for (const engine of engines.splice(0)) await engine.stop(); for (const home of homes.splice(0)) removeHome(home); });

async function fixture() {
  const home = tempHome(); homes.push(home);
  const engine = await startEngine({ home, fakeSteps: 40, fakeDelayMs: 10 }); engines.push(engine);
  const client = await engine.connect({ clientKind: 'desktop' });
  const { session } = await openSession(client, home);
  let sequence = 0;
  const start = prompt => client.call('run.start', { sessionId: session.id, requestId: `queue-${sequence++}`, prompt }).then(result => result.run);
  const snapshot = id => client.call('run.snapshot', { runId: id });
  return { client, session, start, snapshot };
}

test('chat messages queue durably and run in order in the same session', async () => {
  const { client, session, start, snapshot } = await fixture();
  const first = await start('first');
  await waitFor(async () => (await snapshot(first.id)).run.state === 'model');
  const second = await start('second'), third = await start('third');
  const page = await client.call('session.page', { sessionId: session.id });
  expect(page.runs.filter(run => run.state === 'queued').map(run => run.prompt)).toEqual(['second', 'third']);
  await waitFor(async () => (await snapshot(third.id)).run.state === 'completed');
  expect((await snapshot(first.id)).run.state).toBe('completed');
  expect((await snapshot(second.id)).run.state).toBe('completed');
  const final = await client.call('session.page', { sessionId: session.id });
  expect(final.messages.filter(message => message.role === 'user').map(message => message.runId)).toEqual([first.id, second.id, third.id]);
  await client.close();
});

test('send now interrupts the current turn and promotes only the chosen follow-up', async () => {
  const { client, session, start, snapshot } = await fixture();
  const first = await start('first');
  await waitFor(async () => (await snapshot(first.id)).run.state === 'model');
  const second = await start('second'), third = await start('send this now');
  await client.call('run.sendNow', { runId: third.id });
  await waitFor(async () => (await snapshot(third.id)).run.state === 'model');
  expect((await snapshot(first.id)).run.state).toBe('cancelled');
  expect((await snapshot(second.id)).run.state).toBe('queued');
  await client.call('run.sendNow', { runId: third.id }); // a second click cannot cancel the promoted turn
  await waitFor(async () => (await snapshot(second.id)).run.state === 'completed');
  const final = await client.call('session.page', { sessionId: session.id });
  expect(final.messages.filter(message => message.role === 'user').map(message => message.runId)).toEqual([first.id, third.id, second.id]);
  expect(final.runs).toHaveLength(3);
  await client.close();
});

test('removing a queued message leaves the active turn running', async () => {
  const { client, start, snapshot } = await fixture();
  const first = await start('first');
  await waitFor(async () => (await snapshot(first.id)).run.state === 'model');
  const second = await start('remove this');
  await client.call('run.cancel', { runId: second.id, expectedRevision: second.revision });
  expect((await snapshot(second.id)).run.state).toBe('cancelled');
  await waitFor(async () => (await snapshot(first.id)).run.state === 'completed');
  expect((await snapshot(second.id)).messages).toHaveLength(0);
  await client.close();
});

test('send now never interrupts a different chat sharing the workspace', async () => {
  const { client, session, start, snapshot } = await fixture();
  const first = await start('other conversation work');
  await waitFor(async () => (await snapshot(first.id)).run.state === 'model');
  const { session: other } = await client.call('session.create', { projectId: session.projectId, workspaceId: session.workspaceId, title: 'another chat' });
  const { run: queued } = await client.call('run.start', { sessionId: other.id, requestId: 'other-message', prompt: 'send here' });
  await client.call('run.sendNow', { runId: queued.id });
  expect((await snapshot(first.id)).run.state).toBe('model');
  await waitFor(async () => (await snapshot(queued.id)).run.state === 'completed');
  expect((await snapshot(first.id)).run.state).toBe('completed');
  await client.close();
});
