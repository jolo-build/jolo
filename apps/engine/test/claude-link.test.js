import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHostedLinks, isSubagentRequest, removeScratch, startsTurn } from '../src/agents/claude-link.js';

const FAKE = path.join(import.meta.dir, '..', '..', '..', 'tests', 'fixtures', 'fake-claude.js');
const PROTOCOL = ['--print', '--output-format', 'stream-json', '--input-format', 'stream-json', '--replay-user-messages', '--permission-prompt-tool', 'stdio'];
/** A message as the host writes it: with an id the binary echoes back when it takes the message up. */
const said = (content) => ({ type: 'user', uuid: crypto.randomUUID(), message: { role: 'user', content } });
const log = { info() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (predicate, ms = 3000) => { const until = Date.now() + ms; while (!predicate()) { if (Date.now() > until) throw new Error('timed out'); await sleep(10); } };

/** A link to the protocol fixture, with the registry's knobs shortened for a test. */
const open = (registry, sessionId = 'session') => registry.open({
  sessionId, workspaceId: 'workspace', agentId: 'claude', identity: 'fixture', cwd: process.cwd(),
  prepare: (scratchDir) => ({ argv: [process.execPath, FAKE, ...PROTOCOL], env: { PATH: process.env.PATH, TMPDIR: scratchDir } }),
});

/** One turn of the fixture: say `prompt`, collect what comes back until the result. */
async function turn(link, prompt, { signal = new AbortController().signal, init = false } = {}) {
  const seen = [];
  const handle = link.beginTurn({ signal, handle: (message) => {
    seen.push(message);
    if (message.type === 'control_response' && message.response?.request_id === 'jolo-init') link.write(said(prompt));
    return message.type === 'result';
  } });
  if (init) link.write({ type: 'control_request', request_id: 'jolo-init', request: { subtype: 'initialize' } });
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

test('stopping a run drops its waiting message and ends the background work, whose notices are dropped with it', async () => {
  const asked = [];
  const registry = createHostedLinks({ log, interruptMs: 2000, onUnsolicited: (link) => { asked.push(link.sessionId); return true; } });
  const link = open(registry);
  await turn(link, 'two-background', { init: true });
  await waitFor(() => link.pending); // A's report: a turn of the process's own
  const aborter = new AbortController();
  const handle = link.beginTurn({ signal: aborter.signal, handle: (message) => message.type === 'result' });
  link.write(said('never answer this')); // it waits behind A's report
  await sleep(700); // B has finished too: its notice waits in the same queue
  aborter.abort();
  await handle.done;
  await sleep(1500); // long after B's report would have come
  expect(asked).toEqual(['session']); // nothing more began: Stop ended it all
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

test('background work that has just finished counts as work until the turn reporting it begins; a foreground task does not', async () => {
  // A process that runs a background task and a foreground one; each finishes, and the background one is reported later.
  const script = `
    const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
    process.stdin.once('data', () => {
      out({ type: 'control_response', response: { subtype: 'success', request_id: 'jolo-init', response: {} } });
      out({ type: 'system', subtype: 'task_started', task_id: 'fg', tool_use_id: 'call-fg', is_backgrounded: false });
      out({ type: 'system', subtype: 'task_notification', task_id: 'fg', tool_use_id: 'call-fg', status: 'completed' });
      setTimeout(() => out({ type: 'system', subtype: 'task_started', task_id: 'bg', tool_use_id: 'call-bg', is_backgrounded: true }), 300);
      setTimeout(() => out({ type: 'system', subtype: 'task_notification', task_id: 'bg', tool_use_id: 'call-bg', status: 'completed' }), 400);
      setTimeout(() => { out({ type: 'system', subtype: 'init', user_message_uuids: [] }); out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'it finished' }] } }); out({ type: 'result', num_turns: 1, result: 'it finished' }); }, 1400);
    });
    setInterval(() => {}, 1000);
  `;
  const registry = createHostedLinks({ log, onUnsolicited: () => false });
  const link = registry.open({ sessionId: 'report', workspaceId: 'workspace', agentId: 'test', identity: 'stub', cwd: process.cwd(), prepare: () => ({ argv: [process.execPath, '--eval', script], env: { PATH: process.env.PATH } }) });
  link.write({ type: 'control_request', request_id: 'jolo-init', request: { subtype: 'initialize' } });
  await sleep(200);
  expect(link.working).toBe(false); // a foreground task that finished is reported in the turn that ran it
  await sleep(500); // the background task finished at 400 ms; its report begins at 1400 ms
  expect(link.working).toBe(true);
  await waitFor(() => link.pending, 3000); // the report is a turn waiting for a run
  expect(link.working).toBe(true);
  await registry.closeAll();
});
