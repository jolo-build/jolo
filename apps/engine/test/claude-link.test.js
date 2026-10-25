import { expect, test } from 'bun:test';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventPayloadSchemas, activityPayload } from '@jolo/protocol';
import { STOP_TASK_GRACE_MS, TASK_HISTORY_LIMIT, outputFromFile, TASK_ID_MAX, TASK_PATH_MAX, TASK_TEXT_MAX, WORKFLOW_AGENTS_MAX, WORKFLOW_LABEL_MAX, WORKFLOW_MODEL_MAX, WORKFLOW_PHASES_MAX, WORKFLOW_PREVIEW_MAX, WORKFLOW_TITLE_MAX, createHostedLinks, isSubagentRequest, removeScratch, startsTurn } from '../src/agents/claude-link.js';

const FAKE = path.join(import.meta.dir, '..', '..', '..', 'tests', 'fixtures', 'fake-claude.js');
const PROTOCOL = ['--print', '--output-format', 'stream-json', '--input-format', 'stream-json', '--replay-user-messages', '--permission-prompt-tool', 'stdio'];
/** A message as the host writes it: with an id the binary echoes back when it takes the message up. */
const said = (content) => ({ type: 'user', uuid: crypto.randomUUID(), message: { role: 'user', content } });
const log = { info() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (predicate, ms = 3000) => { const until = Date.now() + ms; while (!predicate()) { if (Date.now() > until) throw new Error('timed out'); await sleep(10); } };

/** A link to the protocol fixture, with the registry's knobs shortened for a test; `env` scripts the fixture. */
const open = (registry, sessionId = 'session', env = {}) => registry.open({
  sessionId, workspaceId: 'workspace', agentId: 'claude', identity: 'fixture', cwd: process.cwd(),
  prepare: (scratchDir) => ({ argv: [process.execPath, FAKE, ...PROTOCOL], env: { PATH: process.env.PATH, TMPDIR: scratchDir, ...env } }),
});

/** One turn of the fixture: say `prompt`, collect what comes back until the result. */
async function turn(link, prompt, { signal = new AbortController().signal, init = false } = {}) {
  const seen = [];
  const handle = link.beginTurn({ signal, handle: (message) => {
    seen.push(message);
    if (message.type === 'control_response' && message.response?.request_id === 'jolo-init') link.write(said(prompt));
    return message.type === 'result';
  } });
  // As Jolo declares it: Jolo stops background work itself, so Claude's interrupt spares it.
  if (init) link.write({ type: 'control_request', request_id: 'jolo-init', request: { subtype: 'initialize', perTaskStopAffordance: true } });
  else link.write(said(prompt));
  const ended = await handle.done;
  return { ended, seen, text: seen.filter((m) => m.type === 'assistant').flatMap((m) => m.message.content).filter((b) => b.type === 'text').map((b) => b.text).join('') };
}

test('a message from an idle process starts a turn only when it is the process speaking for itself', () => {
  expect(startsTurn({ type: 'assistant', message: { content: [] } })).toBe(true);
  expect(startsTurn({ type: 'stream_event', event: {} })).toBe(true);
  expect(startsTurn({ type: 'result' })).toBe(true);
  expect(startsTurn({ type: 'control_request', parent_tool_use_id: 'child' })).toBe(true); // a subagent's question still needs an answer
  expect(startsTurn({ type: 'assistant', parent_tool_use_id: 'child' })).toBe(false); // a subagent still working in the background
  expect(startsTurn({ type: 'user', message: { content: [{ type: 'tool_result' }] } })).toBe(false); // a tool from the last turn reporting back
  expect(startsTurn({ type: 'user', message: { content: '<task-notification>done</task-notification>' } })).toBe(true);
  expect(startsTurn({ type: 'system', subtype: 'init' })).toBe(true); // the main thread opens every turn with init
  expect(startsTurn({ type: 'system', subtype: 'task_notification' })).toBe(false);
  expect(startsTurn({ type: 'keep_alive' })).toBe(false);
  // A background subagent names itself when it asks; the main thread's own questions do not.
  expect(isSubagentRequest({ type: 'control_request', request: { subtype: 'can_use_tool', agent_id: 'a1' } })).toBe(true);
  expect(isSubagentRequest({ type: 'control_request', request: { subtype: 'can_use_tool' } })).toBe(false);
});

test('one process answers turn after turn and leaves when the registry closes it', async () => {
  const registry = createHostedLinks({ log });
  const link = open(registry);
  const scratch = link.scratchDir;
  expect(existsSync(scratch)).toBe(true);
  const first = await turn(link, 'hello', { init: true });
  expect(first.text).toBe('You said: hello');
  expect(first.ended.exited).toBe(false);
  const second = await turn(link, 'again');
  expect(second.text).toMatch(/^Continuing session fake-\w+: again$/);
  expect(link.alive).toBe(true);
  expect(registry.size).toBe(1);
  await registry.closeAll('test over');
  expect(link.alive).toBe(false);
  expect((await link.closed).exitCode).toBe(0); // it left on EOF, nothing had to be killed
  expect(existsSync(scratch)).toBe(false);
  expect(registry.size).toBe(0);
});

test('a turn the process starts by itself is kept until a run takes it, and asked for one once', async () => {
  const asked = [];
  const registry = createHostedLinks({ log, onUnsolicited: (link) => { asked.push(link.sessionId); return true; } });
  const link = open(registry);
  const started = await turn(link, 'background 50 finished later', { init: true });
  expect(started.text).toBe('Background work started.');
  await waitFor(() => link.pending);
  expect(asked).toEqual(['session']);
  await sleep(100); // more of that turn arrives while nobody is listening; it must not be asked for again
  expect(asked).toEqual(['session']);
  // The run that takes it sees the whole turn, from the first message to its result.
  const seen = [];
  const handle = link.beginTurn({ signal: new AbortController().signal, handle: (message) => { seen.push(message); return message.type === 'result'; } });
  await handle.done;
  expect(seen[0]).toMatchObject({ type: 'system', subtype: 'init' }); // the turn's own opening, not the notice before it
  expect(seen.filter((m) => m.type === 'assistant').flatMap((m) => m.message.content).map((b) => b.text)).toEqual(['finished later']);
  expect(link.pending).toBe(false);
  expect(link.alive).toBe(true);
  await registry.closeAll();
});

test('cancelling a turn interrupts the process; one that does not stop in time is closed', async () => {
  const registry = createHostedLinks({ log, interruptMs: 100 });
  const link = open(registry);
  await turn(link, 'hello', { init: true });
  const controller = new AbortController();
  /** @type {any[]} */
  const slowly = [];
  const slow = link.beginTurn({ signal: controller.signal, handle: (message) => { slowly.push(message); return message.type === 'result'; } });
  link.write(said('slow 5000 never'));
  await waitFor(() => slowly.some((m) => m.type === 'system' && m.subtype === 'init')); // the turn is under way
  controller.abort();
  const interrupted = await slow.done;
  expect(interrupted.exited).toBe(false); // the fixture answered the interrupt with a result
  expect(slowly.at(-1)).toMatchObject({ type: 'result', result: 'Request interrupted by user' });
  expect(link.alive).toBe(true);
  await registry.closeAll();

  // A process that ignores the interrupt is closed instead, and the turn ends with its exit.
  const deaf = createHostedLinks({ log, interruptMs: 100 });
  const stubborn = deaf.open({
    sessionId: 'deaf', workspaceId: 'workspace', agentId: 'test', identity: 'stub', cwd: process.cwd(),
    // It opens a turn (init) and then ignores everything, the interrupt included.
    prepare: () => ({ argv: [process.execPath, '--eval', 'process.stdin.resume(); setTimeout(() => process.stdout.write(JSON.stringify({ type: "system", subtype: "init" }) + "\\n"), 30); setInterval(() => {}, 1000)'], env: { PATH: process.env.PATH } }),
  });
  const aborter = new AbortController();
  /** @type {any[]} */
  const seen = [];
  const handle = stubborn.beginTurn({ signal: aborter.signal, handle: (message) => { seen.push(message); return false; } });
  stubborn.write(said('work'));
  await waitFor(() => seen.some((m) => m.subtype === 'init')); // the main thread is in a turn to stop
  aborter.abort();
  const ended = await handle.done;
  expect(ended.exited).toBe(true);
  expect(stubborn.alive).toBe(false);
  expect(deaf.size).toBe(0);
});

test('an idle process is closed after the idle time, but not while a run holds it', async () => {
  const registry = createHostedLinks({ log, idleMs: 150 });
  const link = open(registry);
  await turn(link, 'hello', { init: true });
  const held = turn(link, 'slow 400 done');
  await sleep(250); // longer than the idle time, but the turn is in progress
  expect(link.alive).toBe(true);
  expect((await held).text).toBe('done');
  await waitFor(() => registry.size === 0, 2000); // closed on its own once idle, and forgotten
  expect(link.alive).toBe(false);
});

test('closing a workspace closes only the processes working in it', async () => {
  const registry = createHostedLinks({ log });
  const one = open(registry, 'one');
  const other = registry.open({ sessionId: 'two', workspaceId: 'elsewhere', agentId: 'claude', identity: 'fixture', cwd: process.cwd(), prepare: () => ({ argv: [process.execPath, FAKE, ...PROTOCOL], env: { PATH: process.env.PATH } }) });
  await registry.closeWorkspace('workspace', 'removed');
  expect(one.alive).toBe(false);
  expect(other.alive).toBe(true);
  await registry.closeAll();
  expect(registry.size).toBe(0);
});

test('stopping a run that only answers a background subagent leaves the process and its work alone', async () => {
  const asked = [];
  const registry = createHostedLinks({ log, interruptMs: 100, onUnsolicited: (link) => { asked.push(link.sessionId); return true; } });
  const link = open(registry);
  await turn(link, 'background-permission 30 50', { init: true });
  await waitFor(() => link.pending);
  expect(link.pendingQuestionOnly).toBe(true);
  // The run takes the question and is stopped before anyone answers it: no interrupt, no kill.
  const aborter = new AbortController();
  /** @type {any} */
  let question = null;
  const handle = link.beginTurn({ signal: aborter.signal, handle: (message) => { if (message.type === 'control_request') question = message; return false; } });
  await waitFor(() => question !== null);
  aborter.abort();
  const ended = await handle.done;
  expect(ended.exited).toBe(false);
  expect(link.alive).toBe(true);
  expect(link.pending).toBe(false); // the progress notice after the question is no turn to hand on
  // Denying it lets the subagent finish, and the process reports that in a turn of its own.
  link.write({ type: 'control_response', response: { request_id: question.request_id, subtype: 'success', response: { behavior: 'deny', message: 'stopped' } } });
  await waitFor(() => link.pending);
  const seen = [];
  const report = link.beginTurn({ signal: new AbortController().signal, handle: (message) => { seen.push(message); return message.type === 'result'; } });
  await report.done;
  expect(seen.filter((m) => m.type === 'assistant').flatMap((m) => m.message.content).map((b) => b.text)).toEqual(['Background agent finished: deny']);
  await registry.closeAll();
});

test('a turn handler that refuses work after its run is stopped does not kill the process', async () => {
  const registry = createHostedLinks({ log, interruptMs: 2000 });
  const link = open(registry);
  await turn(link, 'hello', { init: true });
  const aborter = new AbortController();
  const handle = link.beginTurn({ signal: aborter.signal, handle: (message) => {
    if (aborter.signal.aborted && message.type !== 'result') throw new Error('the run is stopping'); // as a tool starting after Stop does
    return message.type === 'result';
  } });
  link.write(said('slow 300 never shown'));
  await sleep(50);
  aborter.abort();
  const ended = await handle.done;
  expect(ended.exited).toBe(false);
  expect(ended.failure).toBeUndefined();
  expect(link.alive).toBe(true);
  expect((await turn(link, 'after')).text).toMatch(/after$/);
  await registry.closeAll();
});

test('a scratch directory the agent left read-only is still removed, and never fails the close', async () => {
  const registry = createHostedLinks({ log });
  const link = open(registry);
  const locked = path.join(link.scratchDir, 'gomod', 'cache');
  mkdirSync(locked, { recursive: true });
  writeFileSync(path.join(locked, 'mod.go'), 'package x\n');
  chmodSync(locked, 0o555);
  chmodSync(path.dirname(locked), 0o555);
  await registry.closeAll('test over');
  expect(registry.size).toBe(0);
  expect(existsSync(link.scratchDir)).toBe(false);
  // One already gone is no trouble.
  const gone = mkdtempSync(path.join(tmpdir(), 'jolo-gone-'));
  const quiet = [];
  removeScratch(path.join(gone, 'missing', 'deeper'), { warn: (...args) => quiet.push(args) });
  expect(quiet).toEqual([]);
  rmSync(gone, { recursive: true, force: true });
  // And when it truly cannot go (its parent will not let it be unlinked), cleanup only warns.
  if (process.getuid?.() !== 0) {
    const parent = mkdtempSync(path.join(tmpdir(), 'jolo-stuck-'));
    const stuck = path.join(parent, 'scratch');
    mkdirSync(stuck);
    chmodSync(parent, 0o555);
    const warned = [];
    try {
      expect(() => removeScratch(stuck, { warn: (...args) => warned.push(args) }, { sessionId: 's' })).not.toThrow();
      expect(warned).toHaveLength(1);
      expect(warned[0][1]).toMatchObject({ sessionId: 's', dir: stuck });
    } finally {
      chmodSync(parent, 0o700);
      rmSync(parent, { recursive: true, force: true });
    }
  }
});

test('a turn the process began by itself while the conversation was busy is offered again once it is free', async () => {
  const asked = [];
  let free = false;
  const registry = createHostedLinks({ log, onUnsolicited: (link) => { asked.push(link.sessionId); return free; } });
  const link = open(registry);
  await turn(link, 'background 30 finished later', { init: true });
  await waitFor(() => link.pending);
  expect(asked).toEqual(['session']); // declined: a run was still settling
  free = true;
  registry.reoffer('session');
  await waitFor(() => asked.length === 2);
  expect(asked).toEqual(['session', 'session']);
  // Taken this time: a run that then fails before it takes the turn must not set off another offer, and another.
  registry.reoffer('session');
  await sleep(50);
  expect(asked).toEqual(['session', 'session']);
  await registry.closeAll();
});

test('stopping a turn between an empty result and its answer interrupts it, so the answer never comes later', async () => {
  const asked = [];
  const registry = createHostedLinks({ log, interruptMs: 1000, onUnsolicited: (link) => { asked.push(link.sessionId); return true; } });
  const link = open(registry);
  await turn(link, 'hello', { init: true });
  const aborter = new AbortController();
  /** @type {any[]} */
  const seen = [];
  // As the run does, the handler does not take an empty result for the end of the turn.
  const handle = link.beginTurn({ signal: aborter.signal, handle: (message) => { seen.push(message); return message.type === 'result' && message.num_turns > 0; } });
  link.write(said('zero-result-late 300 too late'));
  await waitFor(() => seen.some((m) => m.type === 'result'));
  aborter.abort();
  const ended = await handle.done;
  expect(ended.exited).toBe(false);
  expect(seen.at(-1)).toMatchObject({ type: 'result', result: 'Request interrupted by user' });
  await sleep(500);
  expect(asked).toEqual([]); // nothing of the stopped turn was left to come later
  expect(link.alive).toBe(true);
  await registry.closeAll();
});

test('stopping a turn that is compacting after an empty result still interrupts it, past the grace', async () => {
  const asked = [];
  const registry = createHostedLinks({ log, interruptMs: 1000, emptyGraceMs: 200, onUnsolicited: (link) => { asked.push(link.sessionId); return true; } });
  const link = open(registry);
  await turn(link, 'hello', { init: true });
  const aborter = new AbortController();
  /** @type {any[]} */
  const seen = [];
  const handle = link.beginTurn({ signal: aborter.signal, handle: (message) => { seen.push(message); return message.type === 'result' && message.num_turns > 0; } });
  link.write(said('zero-result-compact 800 too late'));
  await waitFor(() => seen.some((m) => m.type === 'result'));
  await sleep(400); // past the grace, still compacting
  aborter.abort();
  const ended = await handle.done;
  expect(seen.at(-1)).toMatchObject({ type: 'result', result: 'Request interrupted by user' });
  expect(ended.exited).toBe(false);
  await sleep(600);
  expect(asked).toEqual([]); // the answer did not come later as a turn of its own
  await registry.closeAll();
});

test('stopping a run while its message waits behind a turn the process began by itself drops the message', async () => {
  const asked = [];
  const registry = createHostedLinks({ log, interruptMs: 1000, onUnsolicited: (link) => { asked.push(link.sessionId); return true; } });
  const link = open(registry);
  await turn(link, 'background-slow 30 800 the report', { init: true });
  await waitFor(() => link.pending); // the process is in a turn of its own
  const aborter = new AbortController();
  /** @type {any[]} */
  const seen = [];
  const handle = link.beginTurn({ signal: aborter.signal, handle: (message) => { seen.push(message); return message.type === 'result'; } });
  link.write(said('never answer this')); // it waits behind that turn
  await sleep(50);
  aborter.abort();
  await handle.done;
  await sleep(1200); // long after the interrupted turn would have finished and the message been taken up
  expect(asked).toEqual(['session']); // nothing more began: the waiting message was dropped with the stop
  expect(link.pending).toBe(false);
  expect(link.alive).toBe(true);
  await registry.closeAll();
});

test('a message echoed back with its images, far past the usual line bound, does not cost the process', async () => {
  const registry = createHostedLinks({ log });
  // It echoes the message it takes up whole, as Claude does with --replay-user-messages: here 20 MB of image data.
  const echo = `process.stdin.once('data', () => { const image = 'A'.repeat(20 * 1024 * 1024); process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', user_message_uuids: [] }) + '\\n' + JSON.stringify({ type: 'user', isReplay: true, uuid: 'u1', message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: image } }] } }) + '\\n' + JSON.stringify({ type: 'result', num_turns: 1, result: 'ok' }) + '\\n'); }); setInterval(() => {}, 1000);`;
  const link = registry.open({ sessionId: 'big', workspaceId: 'workspace', agentId: 'test', identity: 'stub', cwd: process.cwd(), prepare: () => ({ argv: [process.execPath, '--eval', echo], env: { PATH: process.env.PATH } }) });
  /** @type {any[]} */
  const seen = [];
  const handle = link.beginTurn({ signal: new AbortController().signal, handle: (message) => { seen.push(message.type); return message.type === 'result'; } });
  link.write(said('look at these'));
  const ended = await handle.done;
  expect(ended.exited).toBe(false);
  expect(seen).toEqual(['system', 'user', 'result']);
  expect(link.alive).toBe(true);
  await registry.closeAll();
}, 30_000);

test('stopping a run drops its waiting message and spares the background work, which stopping background work then ends', async () => {
  const asked = [];
  const registry = createHostedLinks({ log, interruptMs: 2000, onUnsolicited: (link) => { asked.push(link.sessionId); return true; } });
  const link = open(registry);
  await turn(link, 'tasks 1 1500', { init: true });
  const aborter = new AbortController();
  const handle = link.beginTurn({ signal: aborter.signal, handle: (message) => message.type === 'result' });
  link.write(said('slow 5000 never shown'));
  const waiting = said('never answer this');
  link.write(waiting); // it waits behind the slow turn
  await sleep(200);
  aborter.abort();
  await handle.done;
  expect(link.queues(waiting.uuid)).toBe(false); // dropped with the stop
  expect(link.activity.tasks.map(t => t.status)).toEqual(['running']); // the background work goes on
  expect(link.activity.state).toBe('background');
  expect(await link.stopBackground()).toEqual({ requested: 1, stopped: 1, escalated: false });
  await sleep(1700); // long after the work would have finished and been reported
  expect(asked).toEqual([]); // nothing more began: the message was dropped, and stopped work reports nothing
  expect(link.pending).toBe(false);
  expect(link.alive).toBe(true);
  await registry.closeAll();
});

test('a long turn the process begins while the conversation is busy is kept whole, without costing the process', async () => {
  const registry = createHostedLinks({ log, onUnsolicited: () => false }); // busy: no run can take it yet
  const link = open(registry);
  await turn(link, 'background-chatty 6000', { init: true });
  await sleep(1500); // all of it arrives while nobody listens
  expect(link.alive).toBe(true);
  expect(link.pending).toBe(true);
  const seen = [];
  const handle = link.beginTurn({ signal: new AbortController().signal, handle: (message) => { seen.push(message); return message.type === 'result'; } });
  await handle.done;
  expect(seen.filter((m) => m.type === 'assistant').flatMap((m) => m.message.content).map((b) => b.text)).toEqual(['6000 pieces']);
  await registry.closeAll();
}, 30_000);

test('a subagent working inside a waiting turn is part of that turn', async () => {
  const registry = createHostedLinks({ log, onUnsolicited: () => false });
  const link = open(registry);
  await turn(link, 'background-agent-turn', { init: true });
  await waitFor(() => link.pending);
  await sleep(300);
  const seen = [];
  const handle = link.beginTurn({ signal: new AbortController().signal, handle: (message) => { seen.push(message); return message.type === 'result'; } });
  await handle.done;
  expect(seen.filter((m) => m.parent_tool_use_id === 'toolu_fg').map((m) => m.type)).toEqual(['assistant']); // its progress, for the call's row
  await registry.closeAll();
});

test('a turn no run can be started for does not keep the process forever', async () => {
  const registry = createHostedLinks({ log, idleMs: 300, onUnsolicited: () => { throw new Error('workspace is unavailable'); } });
  const link = open(registry);
  await turn(link, 'background 50 too late', { init: true });
  await waitFor(() => registry.size === 0, 3000); // closed after the idle time, though the turn was never taken
  expect(link.alive).toBe(false);
});

test('a process that is closing starts no run for what it says on its way out', async () => {
  const asked = [];
  const registry = createHostedLinks({ log, onUnsolicited: (link) => { asked.push(link.sessionId); return true; } });
  // On end of input it says one more turn's opening, then leaves.
  const parting = `process.stdin.on('end', () => { process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', user_message_uuids: [] }) + '\\n'); setTimeout(() => process.exit(0), 200); }); process.stdin.resume();`;
  registry.open({ sessionId: 'leaving', workspaceId: 'workspace', agentId: 'test', identity: 'stub', cwd: process.cwd(), prepare: () => ({ argv: [process.execPath, '--eval', parting], env: { PATH: process.env.PATH } }) });
  await registry.close('leaving', 'task archived');
  expect(asked).toEqual([]);
});

test('what a run takes over from the waiting turn is marked as replayed; what follows live is not', async () => {
  const registry = createHostedLinks({ log, onUnsolicited: () => false });
  const link = open(registry);
  await turn(link, 'background-agent-turn', { init: true });
  await waitFor(() => link.pending);
  await sleep(300); // the whole report has arrived, while nobody listened
  /** @type {any[]} */
  const seen = [];
  const handle = link.beginTurn({ signal: new AbortController().signal, handle: (message, meta) => { seen.push(meta?.replayed); return message.type === 'result'; } });
  await handle.done;
  expect(seen.length).toBeGreaterThan(2);
  expect(seen.every((replayed) => replayed === true)).toBe(true);
  // A turn taken as it happens is live.
  const live = [];
  const next = link.beginTurn({ signal: new AbortController().signal, handle: (message, meta) => { live.push(meta?.replayed); return message.type === 'result'; } });
  link.write(said('hello again'));
  await next.done;
  expect(live.every((replayed) => replayed === false)).toBe(true);
  await registry.closeAll();
});


test('stopping a run while its message waits behind a turn drops the message with one Stop and keeps the process', async () => {
  // A process in a long turn of its own, as Claude Code 2.1.304 answers a Stop: a receipt naming what it dropped.
  const script = `
    const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
    let buffered = '', waiting = null, stops = 0;
    process.stdin.on('data', (chunk) => {
      buffered += chunk;
      for (let i; (i = buffered.indexOf('\\n')) >= 0;) {
        const m = JSON.parse(buffered.slice(0, i)); buffered = buffered.slice(i + 1);
        if (m.type === 'user') waiting = m.uuid;
        else if (m.request?.subtype === 'initialize') { out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } }); out({ type: 'system', subtype: 'init', user_message_uuids: [] }); }
        else if (m.request?.subtype === 'interrupt') {
          stops += 1;
          out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { still_queued: [], cancelled: m.request.cancel_queued && waiting ? [waiting] : [] } } });
          out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'stops: ' + stops + ' cancel_queued: ' + String(m.request.cancel_queued === true) }] } });
          out({ type: 'result', num_turns: 1, result: 'Request interrupted by user' });
          waiting = null;
        } else if (m.request?.subtype === 'cancel_async_message') out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { cancelled: false } } });
      }
    });
    setInterval(() => {}, 1000);
  `;
  const asked = [];
  const registry = createHostedLinks({ log, interruptMs: 4000, onUnsolicited: (link) => { asked.push(link.sessionId); return true; } });
  const link = registry.open({ sessionId: 'stop', workspaceId: 'workspace', agentId: 'test', identity: 'stub', cwd: process.cwd(), prepare: () => ({ argv: [process.execPath, '--eval', script], env: { PATH: process.env.PATH } }) });
  const message = said('stop me');
  const aborter = new AbortController();
  /** @type {any[]} */
  const seen = [];
  const handle = link.beginTurn({ signal: aborter.signal, handle: (m) => { seen.push(m); return m.type === 'result' && !link.queues(message.uuid); } });
  link.write({ type: 'control_request', request_id: 'jolo-init', request: { subtype: 'initialize' } });
  await sleep(100);
  link.write(message); // it waits behind the process's own turn
  await sleep(100);
  const stopped = Date.now();
  aborter.abort();
  const ended = await handle.done;
  expect(ended.exited).toBe(false);
  expect(Date.now() - stopped).toBeLessThan(1000); // not the interrupt's time limit
  await sleep(500);
  expect(link.alive).toBe(true);
  expect(seen.filter((m) => m.type === 'assistant').map((m) => m.message.content[0].text)).toEqual(['stops: 1 cancel_queued: true']);
  expect(link.queues(message.uuid)).toBe(false);
  expect(asked).toEqual([]); // nothing of the stopped run starts a run of its own
  expect(link.pending).toBe(false);
  await registry.closeAll();
});

/** A link to a stub process that runs `script` (Bun, with `out(message)` writing one line) once its first input arrives. */
const openStub = (registry, sessionId, script) => registry.open({
  sessionId, workspaceId: 'workspace', agentId: 'test', identity: 'stub', cwd: process.cwd(),
  prepare: () => ({ argv: [process.execPath, '--eval', `const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n'); process.stdin.once('data', () => { ${script} }); setInterval(() => {}, 1000);`], env: { PATH: process.env.PATH } }),
});

test('background work that has just finished counts as work until the turn reporting it begins; a foreground task does not', async () => {
  // A process that runs a foreground task inside a run's turn and then a background one; each finishes, and the
  // background one is reported later.
  const script = `
      out({ type: 'control_response', response: { subtype: 'success', request_id: 'jolo-init', response: {} } });
      out({ type: 'system', subtype: 'init', user_message_uuids: [] });
      out({ type: 'system', subtype: 'task_started', task_id: 'fg', tool_use_id: 'call-fg', is_backgrounded: false });
      out({ type: 'system', subtype: 'task_notification', task_id: 'fg', tool_use_id: 'call-fg', status: 'completed' });
      out({ type: 'result', num_turns: 1, result: 'done' });
      setTimeout(() => out({ type: 'system', subtype: 'task_started', task_id: 'bg', tool_use_id: 'call-bg', is_backgrounded: true }), 300);
      setTimeout(() => out({ type: 'system', subtype: 'task_notification', task_id: 'bg', tool_use_id: 'call-bg', status: 'completed' }), 400);
      setTimeout(() => { out({ type: 'system', subtype: 'init', user_message_uuids: [] }); out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'it finished' }] } }); out({ type: 'result', num_turns: 1, result: 'it finished' }); }, 1400);
  `;
  const registry = createHostedLinks({ log, onUnsolicited: () => false });
  const link = openStub(registry, 'report', script);
  const held = link.beginTurn({ signal: new AbortController().signal, handle: (message) => message.type === 'result' });
  link.write({ type: 'control_request', request_id: 'jolo-init', request: { subtype: 'initialize' } });
  await held.done;
  await sleep(150);
  expect(link.working).toBe(false); // a foreground task that finished is reported in the turn that ran it
  await sleep(500); // the background task finished at 400 ms; its report begins at 1400 ms
  expect(link.working).toBe(true);
  await waitFor(() => link.pending, 3000); // the report is a turn waiting for a run
  expect(link.working).toBe(true);
  await registry.closeAll();
});

test('a task that ends while no turn runs is followed by Claude\'s report, whatever its flag', async () => {
  // A task flagged foreground (an MCP call the binary moved off the turn, say) ends with the main thread idle.
  const script = `
      out({ type: 'control_response', response: { subtype: 'success', request_id: 'jolo-init', response: {} } });
      out({ type: 'system', subtype: 'task_started', task_id: 'mcp', tool_use_id: 'call-mcp', is_backgrounded: false });
      setTimeout(() => out({ type: 'system', subtype: 'task_notification', task_id: 'mcp', tool_use_id: 'call-mcp', status: 'completed' }), 100);
      setTimeout(() => { out({ type: 'system', subtype: 'init', user_message_uuids: [] }); out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'it finished' }] } }); out({ type: 'result', num_turns: 1, result: 'it finished' }); }, 1200);
  `;
  const registry = createHostedLinks({ log, onUnsolicited: () => false });
  const link = openStub(registry, 'idle-end', script);
  link.write({ type: 'control_request', request_id: 'jolo-init', request: { subtype: 'initialize' } });
  await waitFor(() => link.activity.tasks[0]?.status === 'completed');
  expect(link.activity.state).toBe('idle');
  expect(link.pending).toBe(false);
  expect(link.working).toBe(true); // its report is due
  await waitFor(() => link.pending, 3000);
  await registry.closeAll();
});

test('a task the binary moves to the background later is recorded as background work', async () => {
  const script = `
      out({ type: 'control_response', response: { subtype: 'success', request_id: 'jolo-init', response: {} } });
      out({ type: 'system', subtype: 'init', user_message_uuids: [] });
      out({ type: 'system', subtype: 'task_started', task_id: 'moved', tool_use_id: 'call-moved', is_backgrounded: false });
      out({ type: 'system', subtype: 'task_started', task_id: 'kept', tool_use_id: 'call-kept', is_backgrounded: false });
      out({ type: 'system', subtype: 'task_updated', task_id: 'moved', patch: { is_backgrounded: true } });
      out({ type: 'system', subtype: 'task_updated', task_id: 'kept', patch: { is_backgrounded: 'yes' } });
      out({ type: 'result', num_turns: 1, result: 'done' });
  `;
  const registry = createHostedLinks({ log });
  const link = openStub(registry, 'moved', script);
  const held = link.beginTurn({ signal: new AbortController().signal, handle: (message) => message.type === 'result' });
  link.write({ type: 'control_request', request_id: 'jolo-init', request: { subtype: 'initialize' } });
  await held.done;
  expect(link.activity.tasks.map(t => [t.taskId, t.backgrounded])).toEqual([['moved', true], ['kept', false]]); // a flag that is not a boolean leaves it
  await registry.closeAll();
});

test('a workflow is one background task with its type and name, and is work until the turn reporting it begins', async () => {
  // The fixture's `workflow x 1500` reports a workflow as Claude Code 2.1.304 does: one local_workflow task carrying its
  // name and a run id of its own, with no is_backgrounded field; a moment after it completes, a turn reports it.
  const registry = createHostedLinks({ log, onUnsolicited: () => false });
  const link = open(registry);
  expect((await turn(link, 'workflow x 1500', { init: true })).text).toBe('Workflow started.');
  await waitFor(() => link.activity.tasks.length === 1);
  expect(link.activity.tasks[0]).toMatchObject({ taskId: 'wf-1', runId: 'wf-1-run', toolUseId: 'toolu_wf_1', taskType: 'local_workflow', workflowName: 'x', description: 'Workflow x', backgrounded: true, status: 'running' });
  expect(link.activity.state).toBe('background');
  await waitFor(() => link.activity.tasks[0].status === 'completed', 4000);
  expect(link.activity.tasks[0].usage.totalTokens).toBe(40_776);
  // Completed, and its report has not begun: the process keeps its work until it does.
  for (const until = Date.now() + 3000; !link.pending; await sleep(10)) {
    expect(link.working).toBe(true);
    if (Date.now() > until) throw new Error('the report never began');
  }
  const seen = [];
  await link.beginTurn({ signal: new AbortController().signal, handle: (message) => { seen.push(message); return message.type === 'result'; } }).done;
  expect(seen.filter((m) => m.type === 'assistant').flatMap((m) => m.message.content).map((b) => b.text)).toEqual(['Workflow x done.']);
  await registry.closeAll();
});

test('a workflow keeps a summary of its agents and phases from its progress reports, and the description it started with', async () => {
  // The fixture's `workflow x 1500` reports the workflow's phases and agents on every progress tick, as Claude Code 2.1.304
  // does: both agents of phase Say start at once, the first is done halfway, both are done at the end.
  const registry = createHostedLinks({ log, onUnsolicited: () => false });
  const link = open(registry);
  await turn(link, 'workflow x 1500', { init: true });
  await waitFor(() => link.activity.tasks[0]?.workflow != null);
  // Each agent as the last report named it: its phase, its model from the start, its tokens, tool calls, duration and result once done.
  const started = (index) => ({ label: `say:${index}`, phase: 'Say', phaseIndex: 1, state: 'running', model: 'claude-fable-5-1', tokens: null, toolCalls: null, durationMs: null, resultPreview: null });
  const done = (index) => ({ ...started(index), state: 'done', tokens: 20388, toolCalls: 0, durationMs: 750, resultPreview: `agent ${index} ok` });
  expect(link.activity.tasks[0].workflow).toEqual({ phases: [{ index: 1, title: 'Say', agents: 2, done: 0, running: 2, failed: 0 }], agents: { total: 2, running: 2, done: 0, failed: 0, list: [started(1), started(2)] }, current: 'Say: say:1' });
  expect(link.activity.tasks[0].usage.totalTokens).toBe(0); // the first tick says 0 tokens, as the real binary does; the engine keeps what it said
  // What it does now is its progress line and the tool (for a workflow, the agent) it last named; nothing has ended yet.
  expect(link.activity.tasks[0]).toMatchObject({ description: 'Workflow x', progress: 'Say: say:1', lastTool: 'say:1', summary: null, outputFile: null });
  await waitFor(() => link.activity.tasks[0].workflow.agents.done === 1);
  expect(link.activity.tasks[0]).toMatchObject({ description: 'Workflow x', usage: { totalTokens: 20388 } });
  // say:2 is at work halfway (Claude Code's `progress` state, with its tokens and tool calls so far): it runs, it has not failed.
  expect(link.activity.tasks[0].workflow).toEqual({ phases: [{ index: 1, title: 'Say', agents: 2, done: 1, running: 1, failed: 0 }], agents: { total: 2, running: 1, done: 1, failed: 0, list: [done(1), { ...started(2), tokens: 8000, toolCalls: 1 }] }, current: 'Say: say:1' });
  await waitFor(() => link.activity.tasks[0].status === 'completed', 4000);
  // How it ended is its notification's summary and output file; the description stays the one it started with.
  expect(link.activity.tasks[0]).toMatchObject({ description: 'Workflow x', usage: { totalTokens: 40776 }, progress: 'Say: say:2', lastTool: 'say:2', summary: 'Dynamic workflow "Workflow x" completed', outputFile: '/tmp/x.output' });
  expect(link.activity.tasks[0].workflow).toEqual({ phases: [{ index: 1, title: 'Say', agents: 2, done: 2, running: 0, failed: 0 }], agents: { total: 2, running: 0, done: 2, failed: 0, list: [done(1), done(2)] }, current: 'Say: say:2' });
  expect(EventPayloadSchemas['session.activity'].safeParse(activityPayload(link.activity)).success).toBe(true);
  await registry.closeAll();
});

test('a workflow lists its latest agents by index, at most WORKFLOW_AGENTS_MAX, each bounded, and counts them all', async () => {
  // 250 agents listed last first, in each state Claude Code's schema names (start, progress, done, error; and one it does
  // not); the newest carries a label, phase, model and result far too long, and counts that are not counts. An agent with
  // no label is listed with an empty one.
  const script = `
      out({ type: 'control_response', response: { subtype: 'success', request_id: 'jolo-init', response: {} } });
      out({ type: 'system', subtype: 'task_started', task_id: 'wf', task_type: 'local_workflow', workflow_name: 'wide', description: 'many agents' });
      const agent = (index) => ({ type: 'workflow_agent', index, label: 'a' + index, phaseIndex: 1, phaseTitle: 'Fan out', model: 'claude-fable-5-1', state: index === 150 ? 'cancelled' : index % 50 === 0 ? 'error' : index % 4 === 1 ? 'start' : index % 2 ? 'progress' : 'done', tokens: 100, toolCalls: 1, durationMs: 1000, resultPreview: 'ok ' + index });
      const newest = { ...agent(250), label: 'l'.repeat(1000), phaseTitle: 'p'.repeat(1000), model: 'm'.repeat(300), resultPreview: 'r'.repeat(1000), tokens: -1, toolCalls: 2.7, durationMs: 'soon', state: 'done' };
      const unlabelled = { ...agent(249), label: { text: 'x' } };
      const agents = [newest, unlabelled, ...Array.from({ length: 248 }, (_, i) => agent(248 - i))];
      out({ type: 'system', subtype: 'task_progress', task_id: 'wf', description: 'Fan out: a1', usage: { total_tokens: 25000 }, workflow_progress: [{ type: 'workflow_phase', index: 1, title: 'Fan out' }, ...agents] });
      out({ type: 'system', subtype: 'task_notification', task_id: 'wf', status: 'completed' });
  `;
  const registry = createHostedLinks({ log });
  const link = openStub(registry, 'wide-workflow', script);
  link.write({ type: 'control_request', request_id: 'jolo-init', request: { subtype: 'initialize' } });
  await waitFor(() => link.activity.tasks[0]?.status === 'completed');
  const { agents } = link.activity.tasks[0].workflow;
  expect(WORKFLOW_AGENTS_MAX).toBe(200);
  expect(agents.total).toBe(250);
  expect(agents.list).toHaveLength(WORKFLOW_AGENTS_MAX);
  expect(agents.list.slice(0, 2).map(a => a.label)).toEqual(['a51', 'a52']); // the oldest fifty dropped, the rest in index order
  expect(agents.list[0]).toEqual({ label: 'a51', phase: 'Fan out', phaseIndex: 1, state: 'running', model: 'claude-fable-5-1', tokens: 100, toolCalls: 1, durationMs: 1000, resultPreview: 'ok 51' }); // at work (progress)
  expect(agents.list.map(a => a.state).slice(48, 52)).toEqual(['running', 'failed', 'running', 'done']); // a99 (progress), a100 (error), a101 (start), a102
  expect(agents.list[99].state).toBe('failed'); // a150, in a state Claude Code does not name
  expect(agents.list.at(-2)).toMatchObject({ label: '', state: 'running' });
  expect(agents.list.at(-1)).toEqual({ label: 'l'.repeat(WORKFLOW_LABEL_MAX), phase: 'p'.repeat(WORKFLOW_TITLE_MAX), phaseIndex: 1, state: 'done', model: 'm'.repeat(WORKFLOW_MODEL_MAX), tokens: null, toolCalls: 2, durationMs: null, resultPreview: 'r'.repeat(WORKFLOW_PREVIEW_MAX) });
  expect([agents.total, agents.running, agents.done, agents.failed]).toEqual([250, 125, 121, 4]); // the newest is done
  expect(EventPayloadSchemas['session.activity'].safeParse(activityPayload(link.activity)).success).toBe(true);
  await registry.closeAll();
});

test('a task keeps its latest progress line and tool apart from its description, and its notification\'s summary once it ends', async () => {
  // The fixture's `tasks 2 300` moves each task to "task <i>, reviewing" halfway, with a progress line "Running task <i>"
  // and the tool Bash, and ends each with the summary "task <i>".
  const registry = createHostedLinks({ log, onUnsolicited: () => false });
  const link = open(registry);
  await turn(link, 'tasks 2 300', { init: true });
  await waitFor(() => link.activity.tasks.length === 2);
  expect(link.activity.tasks[0]).toMatchObject({ description: 'task 1', progress: null, lastTool: null, summary: null, outputFile: null, parentTaskId: null, spawnDepth: null });
  await waitFor(() => link.activity.tasks.every(t => t.progress !== null));
  expect(link.activity.tasks.map(t => [t.description, t.progress, t.lastTool, t.summary])).toEqual([['task 1, reviewing', 'Running task 1', 'Bash', null], ['task 2, reviewing', 'Running task 2', 'Bash', null]]);
  await waitFor(() => link.activity.tasks.every(t => t.status === 'completed'), 4000);
  expect(link.activity.tasks.map(t => [t.description, t.progress, t.summary, t.outputFile])).toEqual([['task 1, reviewing', 'Running task 1', 'task 1', null], ['task 2, reviewing', 'Running task 2', 'task 2', null]]);
  await registry.closeAll();
});

test('a subagent\'s own command names the subagent as its parent, and the subagent its depth', async () => {
  // The fixture's `nested-agent 300` runs a background subagent agent-1 whose command cmd-1 it owns; both end at 300 ms.
  const registry = createHostedLinks({ log, onUnsolicited: () => false });
  const link = open(registry);
  await turn(link, 'nested-agent 300', { init: true });
  await waitFor(() => link.activity.tasks.length === 2 && link.activity.tasks[0].progress !== null && link.activity.tasks[0].model !== null);
  const [agent, command] = link.activity.tasks;
  expect(agent).toMatchObject({ taskId: 'agent-1', taskType: 'local_agent', subagentType: 'general-purpose', spawnDepth: 1, parentTaskId: null, backgrounded: true, description: 'Run the checks', progress: 'Running Run the checks', lastTool: 'Bash', model: 'claude-opus-5-5' });
  expect(command).toMatchObject({ taskId: 'cmd-1', taskType: 'local_bash', parentTaskId: 'agent-1', spawnDepth: null, backgrounded: false, description: 'Run the checks command', model: null });
  await waitFor(() => link.activity.tasks.every(t => t.status === 'completed'), 4000);
  // Claude Code 2.1.304 summed each up with its description; the command wrote no output file (its notice says "").
  expect(link.activity.tasks.map(t => [t.taskId, t.summary])).toEqual([['agent-1', 'Run the checks'], ['cmd-1', 'Run the checks command']]);
  expect(link.activity.tasks[1].outputFile).toBeNull();
  // The subagent's output file is a link to its transcript (JSON lines), as Claude Code 2.1.304 keeps it; its report is the
  // text of the transcript's last assistant message.
  const report = link.activity.tasks[0].outputFile;
  expect(report.startsWith(link.scratchDir) && report.endsWith(path.join('tasks', 'agent-1.output'))).toBe(true);
  expect(lstatSync(report).isSymbolicLink() && readlinkSync(report).endsWith(path.join('subagents', 'agent-agent-1.jsonl'))).toBe(true);
  expect(readFileSync(report, 'utf8').trim().split('\n').map((line) => JSON.parse(line).type)).toEqual(['user', 'assistant', 'user', 'assistant']);
  expect(outputFromFile(report, 'agent-1', { agent: true })).toEqual({ output: 'The checks pass: 12 tests, no failures.', totalBytes: 39, truncated: false, source: 'file' });
  // Claude Code serves a command's output, never an agent's: it answers an agent's with an error.
  await expect(link.taskOutput('agent-1')).rejects.toThrow('get_task_output: no shell or Monitor task with that task_id in this session');
  expect(EventPayloadSchemas['session.activity'].safeParse(activityPayload(link.activity)).success).toBe(true);
  await registry.closeAll();
});

test('a subagent stopped with stop_task is killed: its command stops first, and it ends as stopped', async () => {
  const registry = createHostedLinks({ log, onUnsolicited: () => false });
  const link = open(registry);
  await turn(link, 'nested-agent 5000', { init: true });
  await waitFor(() => link.activity.tasks.length === 2);
  expect(await link.stopTask('agent-1')).toMatchObject({ ok: true });
  await waitFor(() => link.activity.tasks.every(t => t.status !== 'running'));
  expect(link.activity.tasks.map(t => [t.taskId, t.status])).toEqual([['agent-1', 'stopped'], ['cmd-1', 'stopped']]);
  expect(link.activity.state).toBe('idle');
  await registry.closeAll();
});

test('an update that says a subagent was killed ends it as stopped, before any notice of its end', async () => {
  // Claude Code 2.1.304 marks a subagent an interrupt killed with task_updated patch.status "killed"; here no notice follows.
  const script = `
      out({ type: 'control_response', response: { subtype: 'success', request_id: 'jolo-init', response: {} } });
      out({ type: 'system', subtype: 'task_started', task_id: 'sub', task_type: 'local_agent', description: 'a subagent', is_backgrounded: true, spawn_depth: 1 });
      out({ type: 'system', subtype: 'task_updated', task_id: 'sub', patch: { status: 'killed', end_time: 1792813178394 } });
  `;
  const registry = createHostedLinks({ log });
  const link = openStub(registry, 'killed', script);
  link.write({ type: 'control_request', request_id: 'jolo-init', request: { subtype: 'initialize' } });
  await waitFor(() => link.activity.tasks.length === 1 && link.activity.tasks[0].status !== 'running');
  expect(link.activity.tasks[0]).toMatchObject({ taskId: 'sub', status: 'stopped', endedAt: expect.any(String), spawnDepth: 1 });
  expect(link.activity.state).toBe('idle');
  await registry.closeAll();
});

test('what Claude says of where a task sits, what it does now and how it ended is bounded and of the right type', async () => {
  const script = `
      out({ type: 'control_response', response: { subtype: 'success', request_id: 'jolo-init', response: {} } });
      out({ type: 'system', subtype: 'task_started', task_id: 'long', parent_task_id: 'p'.repeat(300), spawn_depth: 2.5, description: 'long' });
      out({ type: 'system', subtype: 'task_progress', task_id: 'long', last_tool_name: 'b'.repeat(300), description: 'd'.repeat(1000) });
      out({ type: 'system', subtype: 'task_notification', task_id: 'long', status: 'completed', summary: 's'.repeat(1000), output_file: '/' + 'f'.repeat(2000) });
      out({ type: 'system', subtype: 'task_started', task_id: 'odd', parent_task_id: { id: 'x' }, spawn_depth: -1, description: 'odd' });
      out({ type: 'system', subtype: 'task_progress', task_id: 'odd', last_tool_name: 'Bash', description: 'Running odd' });
      out({ type: 'system', subtype: 'task_progress', task_id: 'odd', last_tool_name: ['Read'], description: { text: 'x' } });
      out({ type: 'system', subtype: 'task_notification', task_id: 'odd', status: 'stopped', summary: { text: 'x' }, output_file: '' });
  `;
  const registry = createHostedLinks({ log });
  const link = openStub(registry, 'bounded-detail', script);
  link.write({ type: 'control_request', request_id: 'jolo-init', request: { subtype: 'initialize' } });
  await waitFor(() => link.activity.tasks.length === 2 && link.activity.tasks.every(t => t.status !== 'running'));
  const [long, odd] = link.activity.tasks;
  expect(long).toMatchObject({ parentTaskId: 'p'.repeat(TASK_ID_MAX), spawnDepth: 2, lastTool: 'b'.repeat(TASK_ID_MAX), progress: 'd'.repeat(TASK_TEXT_MAX), summary: 's'.repeat(TASK_TEXT_MAX), description: 'long' });
  expect(long.outputFile).toBe('/' + 'f'.repeat(TASK_PATH_MAX - 1));
  // A progress whose tool and line are not text leaves what the last one said; an empty output file is none.
  expect(odd).toMatchObject({ parentTaskId: null, spawnDepth: null, lastTool: 'Bash', progress: 'Running odd', summary: null, outputFile: null, status: 'stopped' });
  expect(EventPayloadSchemas['session.activity'].safeParse(activityPayload(link.activity)).success).toBe(true);
  await registry.closeAll();
});

test('a workflow summary is bounded: an agent in an unknown state counts as failed, a repeated one once, and phases past the cap are cut', async () => {
  // 150 phases listed last first, the first with a title far too long; agents in a state Claude Code 2.1.304 was not seen
  // to send, one listed twice, and two whose phase is cut or unknown; a description without a current agent. Then a
  // progress whose workflow_progress is not a list, and a task that reports none.
  const script = `
      out({ type: 'control_response', response: { subtype: 'success', request_id: 'jolo-init', response: {} } });
      out({ type: 'system', subtype: 'task_started', task_id: 'wf', task_type: 'local_workflow', workflow_name: 'big', description: 'many phases' });
      const phases = Array.from({ length: 150 }, (_, i) => ({ type: 'workflow_phase', index: 150 - i, title: i === 149 ? 't'.repeat(1000) : 'Phase ' + (150 - i) }));
      const agent = (index, phaseIndex, state) => ({ type: 'workflow_agent', index, label: 'a' + index, phaseIndex, phaseTitle: 'Phase ' + phaseIndex, model: 'm', state, promptPreview: 'p' });
      const agents = [agent(1, 1, 'start'), agent(2, 2, 'cancelled'), agent(3, 2, 'start'), agent(4, 120, 'done'), agent(5, 999, 'start'), agent(1, 1, 'done')];
      out({ type: 'system', subtype: 'task_progress', task_id: 'wf', description: 'working', usage: { total_tokens: 10 }, workflow_progress: [...phases, ...agents] });
      out({ type: 'system', subtype: 'task_progress', task_id: 'wf', description: 'Phase 1: a1', usage: { total_tokens: 20 }, workflow_progress: { phases: 'not a list' } });
      out({ type: 'system', subtype: 'task_started', task_id: 'plain', task_type: 'local_bash', description: 'a command', is_backgrounded: true });
      out({ type: 'system', subtype: 'task_progress', task_id: 'plain', description: 'Build: compile', usage: { total_tokens: 5 } });
  `;
  const registry = createHostedLinks({ log });
  const link = openStub(registry, 'bounded-workflow', script);
  link.write({ type: 'control_request', request_id: 'jolo-init', request: { subtype: 'initialize' } });
  await waitFor(() => link.activity.tasks.find(t => t.taskId === 'plain')?.usage.totalTokens === 5);
  const [flow, plain] = link.activity.tasks;
  expect(flow.description).toBe('many phases');
  expect(flow.usage.totalTokens).toBe(20); // the second progress is read for its usage; its odd workflow_progress leaves the summary
  expect(flow.workflow.phases).toHaveLength(WORKFLOW_PHASES_MAX);
  expect(WORKFLOW_PHASES_MAX).toBe(100);
  expect(flow.workflow.phases.map(p => p.title)).toEqual(['t'.repeat(WORKFLOW_TITLE_MAX), ...Array.from({ length: 99 }, (_, i) => `Phase ${i + 2}`)]);
  expect(flow.workflow.phases.slice(0, 3)).toEqual([
    { index: 1, title: 't'.repeat(WORKFLOW_TITLE_MAX), agents: 1, done: 1, running: 0, failed: 0 },
    { index: 2, title: 'Phase 2', agents: 2, done: 0, running: 1, failed: 1 },
    { index: 3, title: 'Phase 3', agents: 0, done: 0, running: 0, failed: 0 },
  ]);
  expect(flow.workflow.agents).toMatchObject({ total: 5, running: 2, done: 2, failed: 1 }); // agents of a cut or unknown phase count here only
  // Every agent is listed once, in index order, the last entry winning, with the title of its phase whether or not it is listed.
  expect(flow.workflow.agents.list.map(a => [a.label, a.phase, a.phaseIndex, a.state])).toEqual([['a1', 'Phase 1', 1, 'done'], ['a2', 'Phase 2', 2, 'failed'], ['a3', 'Phase 2', 2, 'running'], ['a4', 'Phase 120', 120, 'done'], ['a5', 'Phase 999', 999, 'running']]);
  expect(flow.workflow.current).toBeNull();
  expect(plain.workflow).toBeNull();
  expect(EventPayloadSchemas['session.activity'].safeParse(activityPayload(link.activity)).success).toBe(true);
  await registry.closeAll();
});

test('the link keeps a record of each background task with its usage and reports activity as it changes', async () => {
  const seen = [];
  const registry = createHostedLinks({ log, onActivity: (sessionId, activity) => seen.push({ sessionId, ...activity }) });
  const link = open(registry);
  await turn(link, 'tasks 2 300', { init: true });
  await waitFor(() => link.activity.state === 'background');
  expect(link.activity.tasks.map(t => [t.taskId, t.status, t.backgrounded, t.runId, t.taskType, t.workflowName])).toEqual([['task-1', 'running', true, 'task-1-run', 'local_bash', null], ['task-2', 'running', true, 'task-2-run', 'local_bash', null]]);
  await waitFor(() => link.activity.tasks.every(t => t.usage.totalTokens !== null));
  expect(link.activity.tasks[1].usage).toEqual({ totalTokens: 2000, toolUses: 2, durationMs: 150 });
  await waitFor(() => link.activity.tasks.every(t => t.phase !== null));
  expect(link.activity.tasks.map(t => [t.phase, t.description, t.status])).toEqual([['review', 'task 1, reviewing', 'running'], ['review', 'task 2, reviewing', 'running']]);
  await waitFor(() => link.activity.state === 'idle', 5000);
  expect(link.activity.tasks.map(t => t.status)).toEqual(['completed', 'completed']);
  expect(link.activity.tasks[0].endedAt).not.toBeNull();
  expect(seen.map(a => a.state)).toContain('background');
  expect(seen.at(-1)).toMatchObject({ sessionId: 'session', state: 'idle' });
  await registry.closeAll();
});

test('each activity report says why it was made: a new state, a task started or ended, or only progress', async () => {
  const seen = [];
  const registry = createHostedLinks({ log, onActivity: (sessionId, activity, reason) => seen.push({ reason, activity }) });
  const link = open(registry);
  // Usage and phases come halfway through, more than a coalescing window before the tasks end.
  await turn(link, 'tasks 2 1000', { init: true });
  await waitFor(() => link.activity.state === 'idle', 5000);
  const statuses = (activity) => activity.tasks.map(t => [t.taskId, t.status]);
  expect(seen.find(r => r.activity.state === 'background')?.reason).toBe('state');
  expect(seen.some(r => r.reason === 'progress' && r.activity.tasks.every(t => t.usage.totalTokens !== null))).toBe(true);
  expect(seen.at(-1)).toMatchObject({ reason: 'state', activity: { state: 'idle' } });
  seen.forEach(({ reason, activity }, i) => {
    const before = seen[i - 1]?.activity ?? { state: 'idle', tasks: [] };
    expect(reason === 'state').toBe(activity.state !== before.state);
    if (reason === 'progress') expect(statuses(activity)).toEqual(statuses(before)); // no task started or ended
  });
  await registry.closeAll();
});

test('a task ending while others run is reported as a change of tasks', async () => {
  const seen = [];
  const registry = createHostedLinks({ log, onActivity: (sessionId, activity, reason) => seen.push({ reason, activity }) });
  const link = open(registry);
  await turn(link, 'tasks 2 5000', { init: true });
  await waitFor(() => link.activity.state === 'background');
  await link.stopTask('task-1');
  await waitFor(() => seen.some(r => r.activity.tasks.some(t => t.taskId === 'task-1' && t.status === 'stopped')));
  expect(seen.at(-1)).toMatchObject({ reason: 'tasks', activity: { state: 'background' } });
  await registry.closeAll();
});

test('a task that ends without ever having been seen to start is still recorded', async () => {
  // The fixture's `notify-unknown` ends a task "ghost" it never started, then answers.
  const registry = createHostedLinks({ log });
  const link = open(registry);
  await turn(link, 'notify-unknown', { init: true });
  expect(link.activity.tasks.find(t => t.taskId === 'ghost')).toMatchObject({ status: 'failed', startedAt: expect.any(String), description: '' });
  await registry.closeAll();
});

test('what Claude says about a task is bounded and of the right type, and a notice naming no task is ignored and logged once', async () => {
  // The fixture's `tasks-malformed` sends fields of the wrong type or far too long, and two task notices with no usable id.
  const warnings = [];
  const reports = [];
  const registry = createHostedLinks({ log: { ...log, warn: (text, context) => warnings.push({ text, context }) }, onActivity: (sessionId, activity) => reports.push(activity) });
  const link = open(registry);
  await turn(link, 'tasks-malformed', { init: true });
  const [odd, long] = link.activity.tasks;
  expect(link.activity.tasks.map(t => t.taskId)).toEqual(['odd', 'long']);
  expect(odd).toMatchObject({ description: '42', runId: '7', subagentType: null, taskType: null, workflowName: null, usage: { totalTokens: null, toolUses: 2, durationMs: null } });
  expect(odd.toolUseId).toHaveLength(TASK_ID_MAX);
  expect(long.description).toBe('d'.repeat(TASK_TEXT_MAX)); // the update's description was not text, so it is kept
  expect(long.phase).toBe('p'.repeat(TASK_TEXT_MAX));
  expect(warnings.filter(w => w.text.includes('name no task'))).toHaveLength(1);
  // What the engine keeps of each report still parses as a durable event.
  for (const activity of [...reports, link.activity]) expect(EventPayloadSchemas['session.activity'].safeParse(activityPayload(activity)).success).toBe(true);
  await registry.closeAll();
});

test('an update that says a task was stopped ends it, before any notice of its end', async () => {
  const registry = createHostedLinks({ log });
  const link = open(registry);
  await turn(link, 'task-updated-stop', { init: true });
  expect(link.activity.tasks).toEqual([expect.objectContaining({ taskId: 'patched', phase: 'build', status: 'stopped', endedAt: expect.any(String) })]);
  expect(link.activity.state).toBe('idle');
  await registry.closeAll();
});

test('finished tasks past the history limit are forgotten oldest first, running ones never, and reports are coalesced', async () => {
  const seen = [];
  const registry = createHostedLinks({ log, onActivity: (sessionId, activity) => seen.push(activity) });
  const link = open(registry);
  await turn(link, `tasks ${TASK_HISTORY_LIMIT + 2} 400`, { init: true });
  expect(link.activity.tasks.filter(t => t.status === 'running')).toHaveLength(TASK_HISTORY_LIMIT + 2);
  await waitFor(() => link.activity.state === 'idle', 5000);
  expect(link.activity.tasks).toHaveLength(TASK_HISTORY_LIMIT);
  expect([link.activity.tasks[0].taskId, link.activity.tasks.at(-1).taskId]).toEqual(['task-3', `task-${TASK_HISTORY_LIMIT + 2}`]);
  expect(seen.length).toBeLessThan(10); // hundreds of starts, progress notes and ends, but not one report each
  await registry.closeAll();
});

test('tasks still running when the process ends are recorded as failed', async () => {
  const registry = createHostedLinks({ log });
  const link = open(registry);
  await turn(link, 'tasks 2 5000', { init: true });
  expect(link.working).toBe(true);
  await registry.close('session', 'test', { graceful: false }); // a graceful close would stop them first
  expect(link.activity.state).toBe('idle');
  expect(link.activity.tasks.map(t => [t.status, t.endedAt !== null])).toEqual([['failed', true], ['failed', true]]);
});

test('stopping one background task ends it and leaves the others and the process', async () => {
  const registry = createHostedLinks({ log });
  const link = open(registry);
  await turn(link, 'tasks 2 5000', { init: true });
  await waitFor(() => link.activity.tasks.length === 2);
  expect(await link.stopTask('task-1')).toEqual({ ok: true, error: null });
  await waitFor(() => link.activity.tasks.find(t => t.taskId === 'task-1').status === 'stopped');
  expect(link.activity.tasks.find(t => t.taskId === 'task-2').status).toBe('running');
  expect(link.alive).toBe(true);
  expect(await link.stopTask('nope')).toMatchObject({ ok: false, error: expect.stringContaining('unknown task') });
  await registry.closeAll();
  expect(await link.stopTask('task-2')).toEqual({ ok: false, error: 'process ended' });
});

test('stopping all background work ends every task without escalating when they comply', async () => {
  const registry = createHostedLinks({ log });
  const link = open(registry);
  await turn(link, 'tasks 3 5000', { init: true });
  await waitFor(() => link.activity.tasks.length === 3);
  expect(await link.stopBackground()).toEqual({ requested: 3, stopped: 3, escalated: false });
  expect(link.activity.state).toBe('idle');
  const next = await turn(link, 'still here?');
  expect(next.text).toMatch(/still here\?$/); // the process stayed
  await registry.closeAll();
});

test('background work that ignores stop_task is reported not stopped and left running, and the turn under way goes on', async () => {
  const stopGraceMs = 300;
  const registry = createHostedLinks({ log, stopGraceMs });
  const link = open(registry);
  await turn(link, 'tasks-stubborn 2', { init: true });
  await waitFor(() => link.activity.tasks.length === 2);
  const live = turn(link, 'slow 1000 still answered'); // the person's own turn, under way meanwhile
  await sleep(100);
  const asked = Date.now();
  expect(await link.stopBackground()).toEqual({ requested: 2, stopped: 0, escalated: false });
  const took = Date.now() - asked;
  expect(took).toBeGreaterThanOrEqual(stopGraceMs - 20); // the tasks were given the grace
  expect(took).toBeLessThan(stopGraceMs + 500);
  expect((await live).text).toBe('still answered'); // no Stop reached it
  expect(link.activity.tasks.map(t => t.status)).toEqual(['running', 'running']);
  expect(link.alive).toBe(true);
  await registry.closeAll();
});

test('a stop_task Claude never answers gives up after the grace, and the process stays', async () => {
  const stopGraceMs = 300;
  const registry = createHostedLinks({ log, stopGraceMs });
  const link = open(registry, 'session', { FAKE_CLAUDE_SILENT_STOP_TASK: '1' });
  await turn(link, 'tasks 2 5000', { init: true });
  await waitFor(() => link.activity.tasks.length === 2);
  const asked = Date.now();
  expect(await link.stopTask('task-1')).toEqual({ ok: false, error: 'no answer' });
  const took = Date.now() - asked;
  expect(took).toBeGreaterThanOrEqual(stopGraceMs - 20);
  expect(took).toBeLessThan(stopGraceMs + 500);
  expect(link.activity.tasks.map(t => t.status)).toEqual(['running', 'running']);
  expect(link.alive).toBe(true);
  expect((await turn(link, 'still here?')).text).toMatch(/still here\?$/);
  await registry.closeAll();
});

test('stopping background work on a Claude Code that cannot stop tasks interrupts it at once', async () => {
  const registry = createHostedLinks({ log });
  const link = open(registry, 'session', { FAKE_CLAUDE_NO_STOP_TASK: '1' });
  await turn(link, 'tasks 2 5000', { init: true });
  await waitFor(() => link.activity.tasks.length === 2);
  const asked = Date.now();
  expect(await link.stopBackground()).toEqual({ requested: 2, stopped: 0, escalated: true });
  expect(Date.now() - asked).toBeLessThan(STOP_TASK_GRACE_MS); // no grace waited out for tasks it cannot stop
  await waitFor(() => link.activity.tasks.every(t => t.status === 'stopped')); // the interrupt ended them
  expect(link.alive).toBe(true);
  await registry.closeAll();
});

test('stopping background work Claude says is already over reports it not stopped and never interrupts', async () => {
  // Claude no longer knows the task (it finished a moment ago, its notice still on the way); an interrupt would end the process.
  const script = `
    const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
    let buffered = '';
    process.stdin.on('data', (chunk) => {
      buffered += chunk;
      for (let i; (i = buffered.indexOf('\\n')) >= 0;) {
        const m = JSON.parse(buffered.slice(0, i)); buffered = buffered.slice(i + 1);
        if (m.request?.subtype === 'initialize') { out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } }); out({ type: 'system', subtype: 'task_started', task_id: 'over', is_backgrounded: true }); }
        else if (m.request?.subtype === 'stop_task') out({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: 'stop_task: unknown task' } });
        else if (m.request?.subtype === 'interrupt') process.exit(9);
      }
    });
    setInterval(() => {}, 1000);
  `;
  const stopGraceMs = 300;
  const registry = createHostedLinks({ log, stopGraceMs });
  const link = registry.open({ sessionId: 'over', workspaceId: 'workspace', agentId: 'test', identity: 'stub', cwd: process.cwd(), prepare: () => ({ argv: [process.execPath, '--eval', script], env: { PATH: process.env.PATH } }) });
  link.write({ type: 'control_request', request_id: 'jolo-init', request: { subtype: 'initialize' } });
  await waitFor(() => link.activity.state === 'background');
  const asked = Date.now();
  expect(await link.stopBackground()).toEqual({ requested: 1, stopped: 0, escalated: false });
  expect(Date.now() - asked).toBeLessThan(stopGraceMs); // nothing to wait for once Claude has answered
  await sleep(stopGraceMs + 200); // and nothing sent once the grace would have passed
  expect(link.alive).toBe(true);
  expect(link.activity.tasks.map(t => t.status)).toEqual(['running']); // listed as Claude last told it, until its notice comes
  await registry.closeAll();
});

test('closing a process with background work stops the tasks first, then the process leaves', async () => {
  const registry = createHostedLinks({ log });
  const link = open(registry);
  await turn(link, 'tasks 2 20000', { init: true });
  await waitFor(() => link.activity.tasks.length === 2);
  await link.close({ reason: 'test' });
  expect(link.activity.tasks.map(t => t.status)).toEqual(['stopped', 'stopped']);
  expect(link.alive).toBe(false);
});

/** A finished or running task as a stored activity carries it. */
const storedTask = (taskId, status, fields = {}) => ({
  taskId, runId: null, toolUseId: null, description: `task ${taskId}`, subagentType: null, taskType: 'local_bash', workflowName: null, phase: null, backgrounded: true, status,
  startedAt: '2026-10-24T10:00:00.000Z', endedAt: status === 'running' ? null : '2026-10-24T10:01:00.000Z', usage: { totalTokens: null, toolUses: null, durationMs: null },
  workflow: null, parentTaskId: null, spawnDepth: null, lastTool: null, progress: null, summary: null, outputFile: null, ...fields,
});
const stored = (tasks) => ({ state: 'background', tasks, truncated: false, updatedAt: '2026-10-24T10:02:00.000Z' });

test('a new process starts from the conversation\'s stored tasks: finished ones as they were, one left running stopped, and says so', async () => {
  const reports = [];
  const registry = createHostedLinks({ log, history: (sessionId) => (sessionId === 'session' ? stored([storedTask('a', 'completed', { summary: 'done' }), storedTask('b', 'running')]) : null), onActivity: (sessionId, activity, reason) => reports.push({ sessionId, activity, reason }) });
  const link = open(registry);
  expect(link.activity.state).toBe('idle');
  expect(link.activity.tasks.map((t) => [t.taskId, t.status, t.endedAt, t.summary])).toEqual([
    ['a', 'completed', '2026-10-24T10:01:00.000Z', 'done'],
    ['b', 'stopped', '2026-10-24T10:02:00.000Z', 'The process ended before it finished'],
  ]);
  // The stopped task is reported, so the conversation's stored activity no longer has it running.
  await waitFor(() => reports.length > 0);
  expect(reports[0]).toMatchObject({ sessionId: 'session', reason: 'tasks' });
  expect(reports[0].activity.tasks.map((t) => t.status)).toEqual(['completed', 'stopped']);
  // One with no history, or only finished tasks, starts as before and reports nothing.
  const quiet = [];
  const other = createHostedLinks({ log, history: () => stored([storedTask('a', 'completed')]), onActivity: (...args) => quiet.push(args) });
  const plain = open(other, 'plain');
  expect(plain.activity.tasks.map((t) => t.taskId)).toEqual(['a']);
  await sleep(400);
  expect(quiet).toEqual([]);
  const none = createHostedLinks({ log });
  expect(open(none, 'bare').activity.tasks).toEqual([]);
  await registry.closeAll(); await other.closeAll(); await none.closeAll();
});

test('a seeded history keeps the newest finished tasks within the limit, and a later notice about one updates it in place', async () => {
  const many = Array.from({ length: TASK_HISTORY_LIMIT + 5 }, (_, i) => storedTask(`old-${i}`, 'completed'));
  const capped = open(createHostedLinks({ log, history: () => stored(many) }), 'capped');
  expect(capped.activity.tasks).toHaveLength(TASK_HISTORY_LIMIT);
  expect(capped.activity.tasks[0].taskId).toBe('old-5');
  // Claude re-reports a task of an earlier process (the fixture's `notify-unknown` ends "ghost" it never started here).
  const registry = createHostedLinks({ log, history: () => stored([storedTask('ghost', 'running')]) });
  const link = open(registry);
  await turn(link, 'notify-unknown', { init: true });
  expect(link.activity.tasks.map((t) => [t.taskId, t.status])).toEqual([['ghost', 'failed']]);
  // The row is the seeded one, updated: what the earlier process knew of it is still there.
  expect(link.activity.tasks[0]).toMatchObject({ description: 'task ghost', startedAt: '2026-10-24T10:00:00.000Z', endedAt: '2026-10-24T10:02:00.000Z', summary: 'The process ended before it finished' });
  await capped.close({ reason: 'test' }); await registry.closeAll();
});

test('clearing a live process\'s finished tasks drops them from its ledger, keeps the running ones, and reports it', async () => {
  const reports = [];
  const registry = createHostedLinks({ log, history: () => stored([storedTask('a', 'completed'), storedTask('b', 'failed')]), onActivity: (sessionId, activity, reason) => reports.push({ activity, reason }) });
  const link = open(registry);
  await turn(link, 'tasks 1 20000', { init: true });
  await waitFor(() => link.activity.tasks.some((t) => t.taskId === 'task-1' && t.status === 'running'));
  const before = reports.length;
  expect(link.clearFinished()).toBe(2);
  expect(link.activity.tasks.map((t) => [t.taskId, t.status])).toEqual([['task-1', 'running']]);
  await waitFor(() => reports.length > before);
  expect(reports.at(-1).activity.tasks.map((t) => t.taskId)).toEqual(['task-1']);
  expect(link.clearFinished()).toBe(0);
  await registry.closeAll();
});

test('a clear is stored at once, so a process that ends right after cannot leave the cleared tasks for the next one', async () => {
  const store = new Map();
  const registry = createHostedLinks({ log, history: (sessionId) => store.get(sessionId) ?? null, onActivity: (sessionId, activity, reason) => { if (reason !== 'progress') store.set(sessionId, activityPayload(activity)); } });
  store.set('session', stored([storedTask('a', 'completed'), storedTask('b', 'failed')]));
  const link = open(registry);
  await turn(link, 'hello', { init: true });
  expect(link.clearFinished()).toBe(2);
  expect(store.get('session').tasks).toEqual([]); // stored before anything else can happen
  await link.close({ reason: 'test', graceful: false });
  const next = open(registry);
  expect(next.activity.tasks).toEqual([]);
  await sleep(400); // past the coalescing: no late report of the old process brings them back
  expect(store.get('session').tasks).toEqual([]);
  await registry.closeAll();
});

test('a change still waiting to be reported when the process ends is reported before the link is forgotten', async () => {
  // A process that, once initialized, reports a task of an earlier process as ended and leaves at once.
  const script = `
    process.stdin.setEncoding('utf8');
    let pending = '';
    process.stdin.on('data', (chunk) => {
      pending += chunk;
      if (!pending.includes('\\n')) return;
      process.stdout.write(JSON.stringify({ type: 'system', subtype: 'task_notification', task_id: 'old', status: 'completed', summary: 'done before' }) + '\\n', () => process.exit(0));
    });
  `;
  const reports = [];
  let reportsWhenClosed = null;
  const registry = createHostedLinks({ log, onActivity: (sessionId, activity, reason) => reports.push({ activity, reason }) });
  const link = registry.open({ sessionId: 'leaving', workspaceId: 'workspace', agentId: 'test', identity: 'stub', cwd: process.cwd(), prepare: () => ({ argv: [process.execPath, '--eval', script], env: { PATH: process.env.PATH } }), onClosed: () => { reportsWhenClosed = reports.length; } });
  link.write({ type: 'control_request', request_id: 'jolo-init', request: { subtype: 'initialize' } });
  await link.closed;
  expect(reportsWhenClosed).toBe(1);
  expect(reports[0].activity.tasks.map((t) => [t.taskId, t.status])).toEqual([['old', 'completed']]);
  await sleep(400);
  expect(reports).toHaveLength(1); // and not again after it
});

test('a background agent\'s model is learned from its own messages, kept bounded, reported as progress, and stays once it ended', async () => {
  // Claude names a subagent's model only on the subagent's own messages: agent_id and the call it runs under on the envelope.
  // The messages come a moment after the tasks start, and the end later still, so each is reported on its own.
  const script = `
    out({ type: 'control_response', response: { subtype: 'success', request_id: 'jolo-init', response: {} } });
    out({ type: 'system', subtype: 'task_started', task_id: 'agent-1', tool_use_id: 'toolu_a', task_type: 'local_agent', subagent_type: 'Explore', description: 'Explore the repo', is_backgrounded: true });
    out({ type: 'system', subtype: 'task_started', task_id: 'agent-2', tool_use_id: 'toolu_b', task_type: 'local_agent', description: 'Long names', is_backgrounded: true });
    out({ type: 'system', subtype: 'task_started', task_id: 'cmd-1', tool_use_id: 'toolu_c', task_type: 'local_bash', description: 'A command', is_backgrounded: true });
    setTimeout(() => {
      out({ type: 'assistant', agent_id: 'a1', parent_tool_use_id: 'toolu_a', message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Looking.' }] } });
      out({ type: 'assistant', agent_id: 'ax', parent_tool_use_id: 'toolu_unknown', message: { role: 'assistant', model: 'claude-haiku-5-5', content: [] } });
      out({ type: 'assistant', agent_id: 'a2', parent_tool_use_id: 'toolu_b', message: { role: 'assistant', model: 'm'.repeat(200), content: [] } });
      out({ type: 'assistant', agent_id: 'a2', parent_tool_use_id: 'toolu_b', message: { role: 'assistant', model: 7, content: [] } });
      out({ type: 'assistant', agent_id: 'a1', parent_tool_use_id: 'toolu_a', message: { role: 'assistant', model: '<synthetic>', content: [] } });
      out({ type: 'assistant', agent_id: 'c1', parent_tool_use_id: 'toolu_c', message: { role: 'assistant', model: 'claude-sonnet-5-5', content: [] } });
    }, 700); // well past the 250 ms coalesced tasks report, so the model change is a report of its own
    setTimeout(() => out({ type: 'system', subtype: 'task_notification', task_id: 'agent-1', status: 'completed', summary: 'Explored' }), 1600);
  `;
  const reports = [];
  const registry = createHostedLinks({ log, onActivity: (sessionId, activity, reason) => reports.push({ activity, reason }) });
  const link = openStub(registry, 'models', script);
  link.write({ type: 'control_request', request_id: 'jolo-init', request: { subtype: 'initialize' } });
  await waitFor(() => link.activity.tasks.length === 3 && link.activity.tasks[0].status === 'completed' && link.activity.tasks[1].model !== null);
  const [explore, other, command] = link.activity.tasks;
  expect(explore).toMatchObject({ taskId: 'agent-1', subagentType: 'Explore', model: 'claude-opus-5-5', status: 'completed' }); // kept past its end; Claude's synthetic messages name no model
  expect(other.model).toBe('m'.repeat(64)); // a long one is cut to WORKFLOW_MODEL_MAX, and a number after it is no model
  expect(command.model).toBeNull(); // only an agent has a model
  expect(link.activity.tasks.some((t) => t.model === 'claude-haiku-5-5')).toBe(false); // a call no task runs under changes nothing
  // The model went out as progress, on its own, before the agent's end.
  expect(reports.some(({ activity, reason }) => reason === 'progress' && activity.tasks[0].model === 'claude-opus-5-5' && activity.tasks[0].status === 'running')).toBe(true);
  expect(EventPayloadSchemas['session.activity'].safeParse(activityPayload(link.activity)).success).toBe(true);
  await link.close({ reason: 'test', graceful: false }); // the stub answers no stop_task, so a graceful close would wait out its grace
});

test('a task\'s output is read from the process while it runs and after it ended; a task it does not know is refused', async () => {
  const registry = createHostedLinks({ log });
  const link = open(registry);
  await turn(link, 'tasks 2 300', { init: true });
  expect(await link.taskOutput('task-1')).toEqual({ output: 'task 1\nline 1\nline 2\n', totalBytes: 21, truncated: false });
  await waitFor(() => link.activity.tasks.every((t) => t.status === 'completed'));
  expect((await link.taskOutput('task-2')).output).toBe('task 2\nline 1\nline 2\n[exited with code 0]\n');
  await expect(link.taskOutput('nope')).rejects.toThrow('no such task');
  await link.close({ reason: 'test' });
  await expect(link.taskOutput('task-1')).rejects.toMatchObject({ code: 'no_process' });
});

test('a task\'s output keeps its last 200 KiB, says so, and a process that does not answer is given up on', async () => {
  const big = 'a'.repeat(100 * 1024) + 'b'.repeat(250 * 1024) + 'END\n';
  const script = `
    process.stdin.on('data', (chunk) => {
      for (const line of String(chunk).split('\\n').filter(Boolean)) {
        const m = JSON.parse(line);
        if (m.request?.subtype === 'get_task_output' && m.request.task_id === 'big') out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { output: ${JSON.stringify(big)}, total_bytes: ${Buffer.byteLength(big)}, truncated: false } } });
        // 'silent' is never answered
      }
    });
  `;
  const registry = createHostedLinks({ log, requestTimeoutMs: 300 });
  const link = registry.open({ sessionId: 'big', workspaceId: 'workspace', agentId: 'test', identity: 'stub', cwd: process.cwd(), prepare: () => ({ argv: [process.execPath, '--eval', `const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n'); ${script} setInterval(() => {}, 1000);`], env: { PATH: process.env.PATH } }) });
  const read = await link.taskOutput('big');
  expect(Buffer.byteLength(JSON.stringify(read.output)) - 2).toBe(200 * 1024); // its size on the wire: the final newline is two bytes there
  expect(read.output.endsWith('b'.repeat(10) + 'END\n')).toBe(true);
  expect(read).toMatchObject({ totalBytes: Buffer.byteLength(big), truncated: true });
  const asked = Date.now();
  await expect(link.taskOutput('silent')).rejects.toMatchObject({ timedOut: true });
  expect(Date.now() - asked).toBeLessThan(2000);
  await link.close({ reason: 'test', graceful: false });
});

test('the MCP servers\' status is asked of the process, and the latest init\'s list is kept without asking', async () => {
  const registry = createHostedLinks({ log });
  const link = open(registry);
  expect(link.state.mcpServers ?? null).toBeNull();
  await turn(link, 'hello', { init: true });
  expect(link.state.mcpServers).toEqual([
    { name: 'probe', status: 'connected', source: 'user', error: null },
    { name: 'pencil', status: 'failed', source: 'user', error: null },
    { name: 'claude.ai Gmail', status: 'needs-auth', source: 'claudeai', error: null },
  ]);
  expect(await link.mcpStatus()).toEqual({ servers: [
    { name: 'probe', status: 'connected', source: 'user', error: null },
    { name: 'pencil', status: 'failed', source: 'user', error: 'ENOENT' },
    { name: 'claude.ai Gmail', status: 'needs-auth', source: 'claudeai', error: null },
  ] });
  await registry.closeAll();
});

test('a question pending when the process exits is answered no_process at once, not after its time runs out', async () => {
  // A process that leaves as soon as it is asked anything.
  const script = `process.stdin.on('data', () => setTimeout(() => process.exit(0), 50));`;
  const registry = createHostedLinks({ log, requestTimeoutMs: 5000 });
  const link = registry.open({ sessionId: 'leaves', workspaceId: 'workspace', agentId: 'test', identity: 'stub', cwd: process.cwd(), prepare: () => ({ argv: [process.execPath, '--eval', `${script} setInterval(() => {}, 1000);`], env: { PATH: process.env.PATH } }) });
  const asked = Date.now();
  await expect(link.taskOutput('task-1')).rejects.toMatchObject({ code: 'no_process' });
  expect(Date.now() - asked).toBeLessThan(2000);
});

test('session.mcpStatus falls back to the latest init\'s list when the process does not answer, and is null once it has ended', async () => {
  const { createRpcHandlers } = await import('../src/rpc/handlers.js');
  // A process whose turn opens with an init listing its MCP servers, which never answers mcp_status, and leaves on demand.
  const script = `
    out({ type: 'system', subtype: 'init', session_id: 'stub', mcp_servers: [{ name: 'probe', status: 'connected', source: 'user' }, { name: 'pencil', status: 'failed', source: 'user' }] });
    process.stdin.on('data', (chunk) => { if (String(chunk).includes('"leave"')) process.exit(0); });
  `;
  const infos = [];
  const quietLog = { ...log, info: (message) => infos.push(message) };
  const hostedLinks = createHostedLinks({ log: quietLog, requestTimeoutMs: 200 });
  const link = openStub(hostedLinks, 'mcp', script);
  link.write({ type: 'hello' });
  await waitFor(() => link.state.mcpServers !== null);
  const handlers = createRpcHandlers(/** @type {any} */ ({ storage: { getSession: (id) => (id === 'mcp' ? { id } : null) }, hostedLinks, log: quietLog }));
  expect(await handlers['session.mcpStatus']({ sessionId: 'mcp' })).toEqual({ servers: [
    { name: 'probe', status: 'connected', source: 'user', error: null },
    { name: 'pencil', status: 'failed', source: 'user', error: null },
  ] });
  expect(infos.some((message) => /MCP/.test(message))).toBe(true); // the fallback is logged
  // A process that ends while asked has no servers to report, not its old list.
  const asking = handlers['session.mcpStatus']({ sessionId: 'mcp' });
  link.write({ type: 'leave' });
  expect(await asking).toEqual({ servers: null });
  expect(await handlers['session.mcpStatus']({ sessionId: 'mcp' })).toEqual({ servers: null });
});

test('a task of an earlier process has no output to read from this one: no_process, without asking; one started again here is read', async () => {
  const registry = createHostedLinks({ log, history: () => stored([storedTask('old', 'completed', { outputFile: '/tmp/old.output' }), storedTask('task-1', 'completed')]) });
  const link = open(registry);
  await turn(link, 'hello', { init: true });
  await expect(link.taskOutput('old')).rejects.toMatchObject({ code: 'no_process' }); // the fixture would say "no such task" if asked
  await turn(link, 'tasks 1 20000');
  expect((await link.taskOutput('task-1')).output).toBe('task 1\nline 1\nline 2\n'); // started again in this process
  await registry.closeAll();
});

test('a notice that ends a task already ended, with its summary and output file, is a change of the tasks, so it is stored', async () => {
  // A subagent an interrupt killed (task_updated) whose notice, with how it ended, comes past the coalescing.
  const script = `
    out({ type: 'control_response', response: { subtype: 'success', request_id: 'jolo-init', response: {} } });
    out({ type: 'system', subtype: 'task_started', task_id: 'sub', task_type: 'local_agent', description: 'a subagent', is_backgrounded: true });
    setTimeout(() => out({ type: 'system', subtype: 'task_updated', task_id: 'sub', patch: { status: 'killed' } }), 50);
    setTimeout(() => out({ type: 'system', subtype: 'task_notification', task_id: 'sub', status: 'stopped', summary: 'Checked half', output_file: '/tmp/sub.output' }), 500);
  `;
  const stores = [];
  const registry = createHostedLinks({ log, onActivity: (sessionId, activity, reason) => { if (reason !== 'progress') stores.push(activity); } });
  const link = openStub(registry, 'killed-notice', script);
  link.write({ type: 'control_request', request_id: 'jolo-init', request: { subtype: 'initialize' } });
  await waitFor(() => link.activity.tasks[0]?.summary === 'Checked half');
  await waitFor(() => stores.at(-1)?.tasks[0]?.summary === 'Checked half', 1000);
  expect(stores.at(-1).tasks[0]).toMatchObject({ status: 'stopped', summary: 'Checked half', outputFile: '/tmp/sub.output' });
  await link.close({ reason: 'test', graceful: false });
});

test('a task\'s output is cut by its size once escaped for the wire, so output full of control characters still fits', async () => {
  const big = '\x1b[0m'.repeat(100_000) + 'done\n';
  const script = `
    process.stdin.on('data', (chunk) => {
      for (const line of String(chunk).split('\\n').filter(Boolean)) {
        const m = JSON.parse(line);
        if (m.request?.subtype === 'get_task_output') out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { output: ${JSON.stringify(big)}, total_bytes: ${Buffer.byteLength(big)}, truncated: false } } });
      }
    });
  `;
  const registry = createHostedLinks({ log });
  const link = registry.open({ sessionId: 'escapes', workspaceId: 'workspace', agentId: 'test', identity: 'stub', cwd: process.cwd(), prepare: () => ({ argv: [process.execPath, '--eval', `const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n'); ${script} setInterval(() => {}, 1000);`], env: { PATH: process.env.PATH } }) });
  const read = await link.taskOutput('any');
  expect(Buffer.byteLength(JSON.stringify(read.output)) - 2).toBeLessThanOrEqual(200 * 1024);
  expect(Buffer.byteLength(JSON.stringify(read.output)) - 2).toBeGreaterThan(200 * 1024 - 16);
  expect(read.output.endsWith('\x1b[0mdone\n')).toBe(true);
  expect(read.truncated).toBe(true);
  await link.close({ reason: 'test', graceful: false });
});

/** A temporary directory for a test's own files, removed after it. */
async function withTempDir(fn) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'task-output-')));
  try { return await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('session.taskOutput reads from Claude what it serves, and an agent\'s output from its file when Claude cannot serve it', async () => {
  const { createRpcHandlers } = await import('../src/rpc/handlers.js');
  await withTempDir(async (dir) => {
    const report = path.join(dir, 'tasks', 'agent-1.output'); mkdirSync(path.dirname(report)); writeFileSync(report, 'the agent\'s report\n');
    const gone = path.join(dir, 'tasks', 'agent-2.output');
    // A process with a command it serves the output of, and two agents it does not, as Claude Code answers; one agent's file is missing.
    const script = `
      out({ type: 'system', subtype: 'task_started', task_id: 'shell', task_type: 'local_bash', description: 'a command', is_backgrounded: true });
      out({ type: 'system', subtype: 'task_started', task_id: 'agent-1', task_type: 'local_agent', description: 'an agent', is_backgrounded: true });
      out({ type: 'system', subtype: 'task_started', task_id: 'agent-2', task_type: 'local_agent', description: 'another agent', is_backgrounded: true });
      out({ type: 'system', subtype: 'task_notification', task_id: 'agent-1', status: 'completed', summary: 'Reported', output_file: ${JSON.stringify(report)} });
      out({ type: 'system', subtype: 'task_progress', task_id: 'agent-2', description: 'working' });
      out({ type: 'system', subtype: 'task_notification', task_id: 'agent-2', status: 'failed', output_file: ${JSON.stringify(gone)} });
      process.stdin.on('data', (chunk) => {
        for (const line of String(chunk).split('\\n').filter(Boolean)) {
          const m = JSON.parse(line);
          if (m.request?.subtype !== 'get_task_output') continue;
          if (m.request.task_id === 'shell') out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { output: 'shell output\\n', total_bytes: 13, truncated: false } } });
          else out({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: 'get_task_output: no shell or Monitor task with that task_id in this session' } });
        }
      });
    `;
    const hostedLinks = createHostedLinks({ log });
    const link = openStub(hostedLinks, 'files', script);
    link.write({ type: 'hello' });
    await waitFor(() => link.activity.tasks.find((task) => task.taskId === 'agent-2')?.outputFile === gone);
    /** @type {any} */
    let kept = null;
    const handlers = createRpcHandlers(/** @type {any} */ ({ storage: { getSession: (id) => (id === 'files' ? { id } : null), getSessionActivity: () => kept }, hostedLinks, log }));
    const read = (taskId) => handlers['session.taskOutput']({ sessionId: 'files', taskId });
    const refusal = 'get_task_output: no shell or Monitor task with that task_id in this session';
    expect(await read('shell')).toEqual({ output: 'shell output\n', totalBytes: 13, truncated: false, source: 'process' });
    expect(await read('agent-1')).toEqual({ output: 'the agent\'s report\n', totalBytes: 19, truncated: false, source: 'file' });
    await expect(read('agent-2')).rejects.toMatchObject({ code: 'not_found', message: refusal }); // its file is missing: Claude's words, as before
    await expect(read('nope')).rejects.toMatchObject({ code: 'not_found', message: refusal });
    // Once the process is gone, its tasks are found in the conversation's stored activity.
    await link.close({ reason: 'test', graceful: false });
    kept = stored([storedTask('agent-1', 'completed', { taskType: 'local_agent', outputFile: report }), storedTask('agent-2', 'failed', { taskType: 'local_agent', outputFile: gone }), storedTask('shell', 'completed')]);
    expect(await read('agent-1')).toEqual({ output: 'the agent\'s report\n', totalBytes: 19, truncated: false, source: 'file' });
    await expect(read('agent-2')).rejects.toMatchObject({ code: 'no_process' }); // a missing file
    await expect(read('shell')).rejects.toMatchObject({ code: 'no_process' }); // no file
    kept = null;
    await expect(read('agent-1')).rejects.toMatchObject({ code: 'no_process' }); // nothing stored
  });
});

test('a task\'s output file is read only at the absolute path Claude gave, named after the task, and only when it is a regular file', async () => {
  const { createRpcHandlers } = await import('../src/rpc/handlers.js');
  await withTempDir(async (dir) => {
    const tasks = path.join(dir, 'tasks'); mkdirSync(tasks);
    for (const name of ['b7x', 'relative', 'dotted', 'other']) writeFileSync(path.join(tasks, `${name}.output`), 'report\n');
    mkdirSync(path.join(tasks, 'folder.output'));
    const paths = {
      b7x: path.join(tasks, 'b7x.output'), // as Claude names it: the task's id
      relative: path.relative(process.cwd(), path.join(tasks, 'relative.output')),
      dotted: `${tasks}/../tasks/dotted.output`,
      folder: path.join(tasks, 'folder.output'), // not a regular file
      renamed: path.join(tasks, 'other.output'), // another task's file, or a path cut short
      empty: '',
    };
    const kept = stored(Object.entries(paths).map(([taskId, outputFile]) => storedTask(taskId, 'completed', { outputFile })));
    const handlers = createRpcHandlers(/** @type {any} */ ({ storage: { getSession: (id) => ({ id }), getSessionActivity: () => kept }, hostedLinks: createHostedLinks({ log }), log }));
    const read = (taskId) => handlers['session.taskOutput']({ sessionId: 's', taskId });
    expect(await read('b7x')).toMatchObject({ output: 'report\n', source: 'file' });
    for (const taskId of ['relative', 'dotted', 'folder', 'renamed', 'empty']) await expect(read(taskId)).rejects.toMatchObject({ code: 'no_process' });
  });
});

test('a task\'s output file is read from its end: its last 200 KiB once escaped for the wire, in whole characters, and says it was cut', async () => {
  const { createRpcHandlers } = await import('../src/rpc/handlers.js');
  await withTempDir(async (dir) => {
    const files = { big: 'a'.repeat(100 * 1024) + 'b'.repeat(250 * 1024) + 'END\n', wide: '€'.repeat(150 * 1024) + 'END\n', escapes: '\x1b[0m'.repeat(100_000) + 'done\n' };
    for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, `${name}.output`), text);
    const kept = stored(Object.keys(files).map((name) => storedTask(name, 'completed', { taskType: 'local_bash', outputFile: path.join(dir, `${name}.output`) })));
    const handlers = createRpcHandlers(/** @type {any} */ ({ storage: { getSession: (id) => ({ id }), getSessionActivity: () => kept }, hostedLinks: createHostedLinks({ log }), log }));
    const wire = (text) => Buffer.byteLength(JSON.stringify(text)) - 2;
    const big = await handlers['session.taskOutput']({ sessionId: 's', taskId: 'big' });
    expect(wire(big.output)).toBe(200 * 1024);
    expect(big.output.endsWith('b'.repeat(10) + 'END\n')).toBe(true);
    expect(big).toMatchObject({ totalBytes: Buffer.byteLength(files.big), truncated: true, source: 'file' });
    // Three bytes a character: the read starts inside one, which is left out rather than shown broken.
    const wide = await handlers['session.taskOutput']({ sessionId: 's', taskId: 'wide' });
    expect(wide.output.includes('\uFFFD')).toBe(false);
    expect(wide.output.startsWith('€') && wide.output.endsWith('€END\n')).toBe(true);
    expect(wire(wide.output)).toBeLessThanOrEqual(200 * 1024);
    expect(wide).toMatchObject({ totalBytes: Buffer.byteLength(files.wide), truncated: true });
    const escapes = await handlers['session.taskOutput']({ sessionId: 's', taskId: 'escapes' });
    expect(wire(escapes.output)).toBeLessThanOrEqual(200 * 1024);
    expect(wire(escapes.output)).toBeGreaterThan(200 * 1024 - 16);
    expect(escapes.output.endsWith('\x1b[0mdone\n')).toBe(true);
    expect(escapes.truncated).toBe(true);
  });
});

test('a task of an earlier process is read from its output file by the next process\'s conversation, which never asks Claude for it', async () => {
  const { createRpcHandlers } = await import('../src/rpc/handlers.js');
  await withTempDir(async (dir) => {
    const report = path.join(dir, 'old.output'); writeFileSync(report, 'the old report\n');
    const kept = stored([storedTask('old', 'completed', { taskType: 'local_agent', outputFile: report }), storedTask('older', 'completed')]);
    const hostedLinks = createHostedLinks({ log, history: () => kept });
    const link = open(hostedLinks, 'seeded');
    await turn(link, 'hello', { init: true });
    const handlers = createRpcHandlers(/** @type {any} */ ({ storage: { getSession: (id) => ({ id }), getSessionActivity: () => kept }, hostedLinks, log }));
    expect(await handlers['session.taskOutput']({ sessionId: 'seeded', taskId: 'old' })).toEqual({ output: 'the old report\n', totalBytes: 15, truncated: false, source: 'file' });
    await expect(handlers['session.taskOutput']({ sessionId: 'seeded', taskId: 'older' })).rejects.toMatchObject({ code: 'no_process' }); // seeded, with no file
    await hostedLinks.closeAll();
  });
});

/** A transcript line as Claude Code writes it: one message, or one content block of an assistant message, a line. */
const line = (entry) => JSON.stringify(entry) + '\n';
const assistantSaid = (id, ...blocks) => line({ type: 'assistant', message: { id, role: 'assistant', model: 'claude-opus-5-5', content: blocks } });

test('an agent\'s output file is its transcript, through a link: what is shown is the text of its last assistant message, not JSON', async () => {
  const { createRpcHandlers } = await import('../src/rpc/handlers.js');
  await withTempDir(async (dir) => {
    mkdirSync(path.join(dir, 'tasks')); mkdirSync(path.join(dir, 'subagents'));
    /** An agent's transcript and the link Claude names as its output file. */
    const agent = (taskId, text) => {
      const transcript = path.join(dir, 'subagents', `agent-${taskId}.jsonl`); writeFileSync(transcript, text);
      const file = path.join(dir, 'tasks', `${taskId}.output`); symlinkSync(transcript, file);
      return storedTask(taskId, 'completed', { taskType: 'local_agent', outputFile: file });
    };
    const start = line({ type: 'user', message: { role: 'user', content: 'Find the big files' } })
      + assistantSaid('msg_1', { type: 'text', text: 'Let me look.' }) + assistantSaid('msg_1', { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'du -sh *' } })
      + line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '2.0G a.bin' }] } });
    // The report, one message Claude Code wrote a line per text block.
    const report = assistantSaid('msg_2', { type: 'text', text: 'Found one big file.' }) + assistantSaid('msg_2', { type: 'text', text: '- a.bin, 2.0 GB' });
    const huge = line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'x'.repeat(3 * 1024 * 1024) }] } });
    const shellFile = path.join(dir, 'tasks', 'shell.output'); writeFileSync(shellFile, line({ type: 'assistant', message: { content: [{ type: 'text', text: 'not a report' }] } }));
    const workflowFile = path.join(dir, 'tasks', 'wf.output'); writeFileSync(workflowFile, JSON.stringify({ phases: [{ title: 'Say' }] }, null, 2));
    const kept = stored([
      agent('done', start + report),
      agent('long', start + huge + report), // past what is read: the cut line it starts in is left out
      agent('working', start.split('\n').slice(0, 1).join('\n') + '\n'), // nothing said yet
      agent('plain', 'not JSON at all\n'),
      storedTask('shell', 'completed', { taskType: 'local_bash', outputFile: shellFile }),
      storedTask('wf', 'completed', { taskType: 'local_workflow', outputFile: workflowFile }),
    ]);
    const handlers = createRpcHandlers(/** @type {any} */ ({ storage: { getSession: (id) => ({ id }), getSessionActivity: () => kept }, hostedLinks: createHostedLinks({ log }), log }));
    const read = (taskId) => handlers['session.taskOutput']({ sessionId: 's', taskId });
    const words = 'Found one big file.\n\n- a.bin, 2.0 GB';
    expect(await read('done')).toEqual({ output: words, totalBytes: Buffer.byteLength(words), truncated: false, source: 'file' });
    expect(await read('long')).toEqual({ output: words, totalBytes: Buffer.byteLength(words), truncated: false, source: 'file' });
    expect(await read('working')).toEqual({ output: '', totalBytes: 0, truncated: false, source: 'file' }); // the pane says No output yet
    expect(await read('plain')).toEqual({ output: 'not JSON at all\n', totalBytes: 16, truncated: false, source: 'file' }); // not a transcript: as it is
    expect((await read('shell')).output).toContain('"not a report"'); // a command's file is its output, whatever it reads like
    expect((await read('wf')).output).toBe(JSON.stringify({ phases: [{ title: 'Say' }] }, null, 2)); // a workflow's, its JSON as written
  });
});

test('Claude is not asked for an agent\'s or a workflow\'s output, which it never serves: their files are read at once; a command\'s is asked', async () => {
  const { createRpcHandlers } = await import('../src/rpc/handlers.js');
  await withTempDir(async (dir) => {
    mkdirSync(path.join(dir, 'tasks'));
    const files = Object.fromEntries(['agent-1', 'wf-1', 'shell'].map((taskId) => { const file = path.join(dir, 'tasks', `${taskId}.output`); writeFileSync(file, `${taskId} from its file\n`); return [taskId, file]; }));
    // A process that would answer for every task, so an answer from the file shows it was never asked.
    const script = `
      for (const [taskId, type] of [['agent-1', 'local_agent'], ['wf-1', 'local_workflow'], ['shell', 'local_bash'], ['agent-2', 'local_agent']]) {
        out({ type: 'system', subtype: 'task_started', task_id: taskId, task_type: type, description: taskId, is_backgrounded: true });
        if (taskId !== 'agent-2') out({ type: 'system', subtype: 'task_notification', task_id: taskId, status: 'completed', output_file: ${JSON.stringify(dir)} + '/tasks/' + taskId + '.output' });
      }
      process.stdin.on('data', (chunk) => {
        for (const line of String(chunk).split('\\n').filter(Boolean)) {
          const m = JSON.parse(line);
          if (m.request?.subtype === 'get_task_output') out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { output: m.request.task_id + ' from the process\\n', total_bytes: 1, truncated: false } } });
        }
      });
    `;
    const hostedLinks = createHostedLinks({ log });
    const link = openStub(hostedLinks, 'unserved', script);
    link.write({ type: 'hello' });
    await waitFor(() => link.activity.tasks.length === 4 && link.activity.tasks.filter((task) => task.outputFile).length === 3);
    const handlers = createRpcHandlers(/** @type {any} */ ({ storage: { getSession: (id) => ({ id }), getSessionActivity: () => null }, hostedLinks, log }));
    const read = (taskId) => handlers['session.taskOutput']({ sessionId: 'unserved', taskId });
    expect(await read('agent-1')).toMatchObject({ output: 'agent-1 from its file\n', source: 'file' });
    expect(await read('wf-1')).toMatchObject({ output: 'wf-1 from its file\n', source: 'file' });
    expect(await read('shell')).toMatchObject({ output: 'shell from the process\n', source: 'process' });
    // An agent with no file yet is still asked, so whatever Claude says of it stands.
    expect(await read('agent-2')).toMatchObject({ output: 'agent-2 from the process\n', source: 'process' });
    await link.close({ reason: 'test', graceful: false });
  });
});
