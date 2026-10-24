import { expect, test } from 'bun:test';
import { delegationWords, liveDelegation, parseDelegationCall, refreshOnChildEvents, touchesChild } from '../src/renderer/delegation.js';

const head = 'mcp__jolo__delegation_status {"delegationId":"del_1","waitMs":600000}';
// A result cut mid-`output`, as the engine shows it: at most 600 characters, then `…`.
const cut = `${head}\n{"delegation":{"id":"del_1","parentRunId":"run_p","runId":"run_c","sessionId":"ses_c","title":"bg child","modelAlias":"m1","state":"completed","wakeReason":"timeout","failure":null,"execution":{"agentId":"claude","preset":null,"model":"opus","effort":null,"pinned":true},"createdAt":"2026-10-24T00:00:00.000Z","activity":"background","done":false,"partial":true,"output":"started and then a very long answer that the engine cu…`;

test('a delegation call cut off in its answer still reads back its child, state, activity and why the wait ended', () => {
  const call = parseDelegationCall(cut);
  expect(call).toMatchObject({ name: 'delegation_status', error: null });
  expect(call.args.waitMs).toBe(600000);
  expect(call.delegation).toEqual({ id: 'del_1', sessionId: 'ses_c', title: 'bg child', state: 'completed', activity: 'background', done: false, partial: true, wakeReason: 'timeout' });
});

test('a call still waiting for its result has no delegation yet; other tools and delegation_models are not delegation lines', () => {
  expect(parseDelegationCall(`${head}\n`)).toEqual({ name: 'delegation_status', args: { delegationId: 'del_1', waitMs: 600000 }, delegation: null, error: null });
  expect(parseDelegationCall(head)?.delegation).toBeNull();
  expect(parseDelegationCall('Bash {"command":"ls"}\nfile.txt')).toBeNull();
  expect(parseDelegationCall('mcp__jolo__delegation_models {}\n{"models":[]}')).toBeNull();
  expect(parseDelegationCall('')).toBeNull();
});

test('Codex spells the tool jolo/<name>; a whole result is read as JSON; a cut-off head is rescued field by field', () => {
  const whole = parseDelegationCall('jolo/delegate_task {"modelAlias":"m1","title":"Write tests","prompt":"x"}\n{"delegation":{"id":"del_2","sessionId":"ses_2","title":"Write tests","state":"queued","activity":null,"done":false,"partial":false,"output":"","truncated":false}}\n');
  expect(whole).toMatchObject({ name: 'delegate_task', args: { title: 'Write tests' }, delegation: { id: 'del_2', sessionId: 'ses_2', title: 'Write tests', state: 'queued', activity: null, done: false, partial: false }, error: null });
  expect(parseDelegationCall('mcp__jolo__delegate_task {"modelAlias":"m1","title":"Fix the \\"build\\"","prompt":"A very long prom')?.args).toEqual({ modelAlias: 'm1', title: 'Fix the "build"' });
});

test('a result that is not JSON is the error, never a throw', () => {
  expect(parseDelegationCall('mcp__jolo__delegate_task {"modelAlias":"nope","title":"x"}\nChoose an alias from delegation_models\n')).toMatchObject({ delegation: null, error: 'Choose an alias from delegation_models' });
  expect(parseDelegationCall('mcp__jolo__delegation_cancel {"delegationId":"del_1"}\n{"deleg…')).toMatchObject({ delegation: {}, error: null });
});

test('the live row wins for state, activity and done; the wake reason and a partial answer come only from the result', () => {
  const call = parseDelegationCall(cut);
  const merged = liveDelegation(call, new Map([['del_1', { id: 'del_1', state: 'completed', activity: 'idle', done: true, partial: false }]]));
  expect(merged).toMatchObject({ done: true, activity: 'idle', wakeReason: 'timeout', title: 'bg child', sessionId: 'ses_c' });
  // A done child has no partial answer, whatever the result said.
  expect(merged.partial).toBe(false);
  expect(liveDelegation(call, new Map())).toEqual(call.delegation);
  expect(liveDelegation(call, new Map([['del_1', { id: 'del_1', state: 'model', wakeReason: 'answer' }]])).wakeReason).toBe('timeout');
  // delegation.list always says partial: false (it reads no output), so it never hides the result's partial answer.
  const working = liveDelegation(call, new Map([['del_1', { id: 'del_1', state: 'completed', activity: 'background', done: false, partial: false }]]));
  expect(working.partial).toBe(true);
  expect(delegationWords(working)).toBe('Answered · background work · partial answer · woke: wait timed out');
});

test('a call still waiting finds its child by the delegation it names, or by its title for delegate_task', () => {
  // delegation.list sends the newest child first.
  const rows = new Map([
    ['del_1', { id: 'del_1', sessionId: 'ses_1', title: 'Write tests', state: 'model', activity: 'working', done: false, partial: false }],
    ['del_0', { id: 'del_0', sessionId: 'ses_0', title: 'Write tests', state: 'completed', activity: 'idle', done: true, partial: false }],
  ]);
  const byTitle = liveDelegation(parseDelegationCall('mcp__jolo__delegate_task {"modelAlias":"m1","title":"Write tests","prompt":"x"}\n'), rows);
  expect(byTitle).toMatchObject({ state: 'model', activity: 'working', done: false });
  // A title is a guess: it lends the newest such child's state, never a conversation to open.
  expect(byTitle).not.toHaveProperty('sessionId');
  expect(byTitle).not.toHaveProperty('id');
  expect(liveDelegation(parseDelegationCall('mcp__jolo__delegation_status {"delegationId":"del_0","waitMs":1000}\n'), rows)).toMatchObject({ id: 'del_0', done: true });
  // A delegate_task that failed started nothing, so another child with the same title is not it.
  expect(liveDelegation(parseDelegationCall('mcp__jolo__delegate_task {"modelAlias":"m1","title":"Write tests"}\nA turn supports 4 active child tasks\n'), rows)).toEqual({});
});

test('the words say the state as the desktop does, what the process is doing, a partial answer, done, and why it woke', () => {
  expect(delegationWords(parseDelegationCall(cut).delegation)).toBe('Answered · background work · partial answer · woke: wait timed out');
  expect(delegationWords({ state: 'completed', activity: 'idle', done: true, partial: false, wakeReason: 'done' })).toBe('Answered · done · woke: finished');
  // An activity word that repeats the state word is said once.
  expect(delegationWords({ state: 'model', activity: 'working', done: false, partial: false })).toBe('Working');
  expect(delegationWords({ state: 'tools', activity: 'working' })).toBe('Using tools · working');
  expect(delegationWords({ state: 'awaiting_permission', activity: null, wakeReason: 'asking' })).toBe('Needs approval · woke: needs you');
  expect(delegationWords({ state: 'cancelled', wakeReason: 'parent_stopped' })).toBe('Stopped · woke: parent stopped');
  expect(delegationWords({ state: 'failed', wakeReason: 'stopped' })).toBe('Task failed · woke: wait stopped');
  expect(delegationWords({ state: 'completed', wakeReason: 'answer' })).toBe('Answered · woke: new answer');
  expect(delegationWords({})).toBe('');
});

test('only run.state and session.activity events of a child refresh the delegations', () => {
  const children = new Set(['ses_c']);
  const event = (/** @type {string} */ type, /** @type {string} */ sessionId) => ({ kind: 'event', value: { type, sessionId } });
  expect(touchesChild([event('run.state', 'ses_c')], children)).toBe(true);
  expect(touchesChild([event('message.delta', 'ses_c'), event('session.activity', 'ses_c')], children)).toBe(true);
  expect(touchesChild([event('run.state', 'ses_parent'), event('message.delta', 'ses_c')], children)).toBe(false);
  expect(touchesChild([{ kind: 'activity', value: { sessionId: 'ses_c', activity: null } }], children)).toBe(false);
  expect(touchesChild([], children)).toBe(false);
});

test('child events refresh the delegations once per burst, and not after the listener is gone', async () => {
  const children = new Set(['ses_c']);
  const event = { kind: 'event', value: { type: 'run.state', sessionId: 'ses_c' } };
  let loads = 0;
  const refresh = refreshOnChildEvents(children, () => { loads++; }, 5);
  refresh.receive([event]);
  refresh.receive([{ kind: 'event', value: { type: 'session.activity', sessionId: 'ses_c' } }]);
  refresh.receive([{ kind: 'event', value: { type: 'run.state', sessionId: 'ses_other' } }]);
  expect(loads).toBe(0);
  await Bun.sleep(50);
  expect(loads).toBe(1);
  refresh.receive([event]);
  refresh.cancel();
  await Bun.sleep(50);
  expect(loads).toBe(1);
});

