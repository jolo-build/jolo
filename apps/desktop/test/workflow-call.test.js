import { expect, test } from 'bun:test';
import { parseWorkflowCall, workflowCardShown, workflowLaunched, workflowTasksFor } from '../src/renderer/workflow-call.js';

/** A Workflow call's tool message as the engine shows it: the head line, the input as JSON, then the reply. */
const call = (/** @type {Record<string, any>} */ input, reply = '') => `Workflow ${JSON.stringify(input)}\n${reply}`;
const script = (/** @type {string} */ name) => `export const meta = {\n  name: ${name},\n  description: 'Review the branch\\'s changes',\n  phases: [{ title: 'Read' }, { title: 'Review' }],\n}\nphase('Read')\nawait agent("Read the diff", { label: "read" })\n`;

test('a script run inline is named by the name of its meta literal, quoted with a single quote, a double quote or a backtick', () => {
  expect(parseWorkflowCall(call({ script: script("'review-changes'") }))).toEqual({ name: 'review-changes', reply: '' });
  // The head shows a double quote of the script as \" ; it parses back to the script.
  const doubled = call({ script: script('"review-changes"') });
  expect(doubled).toContain('name: \\"review-changes\\"');
  expect(parseWorkflowCall(doubled)?.name).toBe('review-changes');
  expect(parseWorkflowCall(call({ script: script('`review-changes`') }))?.name).toBe('review-changes');
});

test('a saved workflow is named by its input’s name, which wins over a script’s', () => {
  expect(parseWorkflowCall(call({ name: 'review-changes' }))).toEqual({ name: 'review-changes', reply: '' });
  expect(parseWorkflowCall(call({ name: 'saved', script: script("'inline'") }))?.name).toBe('saved');
});

test('a head the engine cut mid-script still gives the name, quoted either way', () => {
  for (const quoted of ["'review-changes'", '"review-changes"', '`review-changes`']) {
    const head = `Workflow ${JSON.stringify({ script: `${script(quoted)}${'await agent("more work")\n'.repeat(400)}` })}`;
    const cut = `${head.slice(0, 4096)}\nWorkflow started in the background (task wf-1).\n`;
    expect(() => JSON.parse(cut.slice('Workflow '.length, cut.indexOf('\n')))).toThrow();
    expect(parseWorkflowCall(cut)).toEqual({ name: 'review-changes', reply: 'Workflow started in the background (task wf-1).' });
  }
  // Cut within an escape: still the name.
  const head = call({ script: `${script("'cut'")}"` });
  expect(parseWorkflowCall(head.slice(0, head.lastIndexOf('\\') + 1))?.name).toBe('cut');
});

test('a re-run of a script Claude Code saved for a run is named by the saved file, cut or not', () => {
  const saved = '/Users/me/.claude/projects/-repo/646c7630/workflows/scripts/sdd-task-wf_084c7ded-94d.js';
  expect(parseWorkflowCall(call({ scriptPath: saved, args: { n: 13, name: 'not this' } }, 'Workflow launched in background. Task ID: whb4jhsf7'))).toEqual({ name: 'sdd-task', reply: 'Workflow launched in background. Task ID: whb4jhsf7' });
  expect(parseWorkflowCall(call({ scriptPath: 'C:\\Users\\me\\scripts\\review-round-2-wf_c6544024-ce7.js' }))?.name).toBe('review-round-2');
  const head = `Workflow ${JSON.stringify({ scriptPath: saved, args: { title: 'x'.repeat(5000) } })}`;
  expect(parseWorkflowCall(head.slice(0, 4096))?.name).toBe('sdd-task');
});

test('a script file, or a script without a name, is still a workflow call, with no name', () => {
  expect(parseWorkflowCall(call({ scriptPath: '/repo/.claude/workflows/review.js' }, 'Workflow started in the background (task wf-2).'))).toEqual({ name: null, reply: 'Workflow started in the background (task wf-2).' });
  expect(parseWorkflowCall(call({ script: "phase('Read')\n" }))).toEqual({ name: null, reply: '' });
  expect(parseWorkflowCall('Workflow {"script":"export const meta = {\\n  descri')).toEqual({ name: null, reply: '' });
});

test('the name is the meta literal’s own key: not a word inside a string, a nested array or object, or code after the literal', () => {
  const named = (/** @type {string} */ body) => parseWorkflowCall(call({ script: `export const meta = {\n${body}\n}\nphase('Read')\n` }))?.name;
  expect(named(`  description: 'Checks, name: "evil"',\n  name: 'real',`)).toBe('real');
  expect(named(`  phases: [{ name: 'Read' }, { title: 'Review', name: "Review" }],\n  name: 'real',`)).toBe('real');
  expect(named(`  description: 'Read, then review: each file',\n  name: 'real',`)).toBe('real');
  expect(named(`  options: { name: 'nested' },\n  // name: 'commented'\n  "name": "quoted-key",`)).toBe('quoted-key');
  // A meta without a name is not named by code after the literal.
  expect(parseWorkflowCall(call({ script: "export const meta = {\n  description: 'No name',\n}\nawait agent('x', { name: 'helper' })\n" }))?.name).toBeNull();
});

test('a script names the workflow over a nested name of the input, cut or not; a top-level name names it when there is no script', () => {
  const input = { args: { name: 'argval' }, script: `${script("'real'")}${'await agent("more work")\n'.repeat(400)}` };
  const head = call(input);
  expect(parseWorkflowCall(head)?.name).toBe('real');
  const cut = head.slice(0, 4096);
  expect(() => JSON.parse(cut.slice('Workflow '.length))).toThrow();
  expect(parseWorkflowCall(cut)?.name).toBe('real');
  // No script: the input's own name, not the one nested in its arguments, cut or not.
  const saved = call({ args: { name: 'argval', notes: 'n'.repeat(5000) }, name: 'review' });
  expect(parseWorkflowCall(saved)?.name).toBe('review');
  const savedCut = `Workflow {"args":{"name":"argval","list":["x"]},"name":"review","notes":"${'n'.repeat(5000)}`.slice(0, 4096);
  expect(parseWorkflowCall(savedCut)?.name).toBe('review');
});

test('any other tool line, or plain text, is not a workflow call', () => {
  expect(parseWorkflowCall('Agent {"subagent_type":"Explore","description":"Find it","prompt":"x"}\n↳ model: claude-opus-5-5\n')).toBeNull();
  expect(parseWorkflowCall('Bash {"command":"ls"}\napp.js\n')).toBeNull();
  expect(parseWorkflowCall('Workflow started in the background (task wf-1).')).toBeNull();
  expect(parseWorkflowCall('mcp__jolo__delegate_task {"title":"Workflow"}\n')).toBeNull();
  expect(parseWorkflowCall('')).toBeNull();
});

test('the reply is the text after the head, trimmed: the tool’s answer, or its error', () => {
  expect(parseWorkflowCall(call({ name: 'demo' }, 'Workflow started in the background (task wf-1).\n'))?.reply).toBe('Workflow started in the background (task wf-1).');
  expect(parseWorkflowCall(call({ script: script("'demo'") }, '  SyntaxError: Unexpected token (3:4)\n    at line 3\n'))?.reply).toBe('SyntaxError: Unexpected token (3:4)\n    at line 3');
  expect(parseWorkflowCall(`Workflow ${JSON.stringify({ name: 'demo' })}`)?.reply).toBe('');
});

let ids = 0;
/** A workflow task as `session.activity` carries one. @param {string | null} workflowName @param {number} second @param {Record<string, any>} [options] */
const flow = (workflowName, second, options = {}) => /** @type {import('../src/renderer/activity.js').TaskRecord} */ ({
  taskId: `wf-${++ids}`, runId: null, toolUseId: null, description: `Workflow ${workflowName}`, subagentType: null, taskType: 'local_workflow', workflowName,
  phase: null, backgrounded: false, status: 'running', startedAt: new Date(Date.parse('2026-10-24T10:00:00.000Z') + second * 1000).toISOString(), endedAt: null,
  usage: { totalTokens: null, toolUses: null, durationMs: null }, ...options,
});
/** @param {import('../src/renderer/activity.js').TaskRecord[]} tasks @returns {import('../src/renderer/activity.js').Activity} */
const activity = (tasks) => ({ state: 'background', tasks, truncated: false, updatedAt: '2026-10-24T10:00:00.000Z' });

/** A run's window in seconds from the fixture's start, as the conversation builds it from the run (ms). */
const window = (/** @type {number} */ from, /** @type {number} */ to = Infinity) => ({ from: Date.parse('2026-10-24T10:00:00.000Z') + from * 1000, to: to === Infinity ? Infinity : Date.parse('2026-10-24T10:00:00.000Z') + to * 1000 });

test('cards of unknown runs take the workflow tasks of their name in transcript order, oldest task first, then none is left', () => {
  const [older, other, newer] = [flow('demo', 1), flow('quick', 2), flow('demo', 3)];
  // The snapshot lists them in any order; the claims go by when each started.
  const calls = ['demo', 'quick', 'demo', 'demo', 'quick'].map(name => ({ name, window: null }));
  expect(workflowTasksFor(calls, activity([newer, other, older]))).toEqual([older, other, newer, null, null]);
});

test('a card takes only a task that started within its own run: not an earlier process’s, nor one after its run ended', () => {
  const earlier = flow('demo', 10);
  // An earlier process ran demo (its task is the one at 10 s); this card's run started at 100 s.
  expect(workflowTasksFor([{ name: 'demo', window: window(95) }], activity([earlier]))).toEqual([null]);
  // This card's run ended at 30 s; the task started at 60 s.
  expect(workflowTasksFor([{ name: 'demo', window: window(0, 30) }], activity([flow('demo', 60)]))).toEqual([null]);
  // The card of the run that ended takes nothing of the later run; the later run's card takes its own task.
  const later = flow('demo', 101);
  expect(workflowTasksFor([{ name: 'demo', window: window(-5, 25) }, { name: 'demo', window: window(95) }], activity([later]))).toEqual([null, later]);
});

test('two calls of one name in two runs each get their own run’s task, whatever the transcript order', () => {
  const first = flow('demo', 10);
  const second = flow('demo', 100);
  const runA = window(5, 40), runB = window(95, 130);
  expect(workflowTasksFor([{ name: 'demo', window: runA }, { name: 'demo', window: runB }], activity([second, first]))).toEqual([first, second]);
  expect(workflowTasksFor([{ name: 'demo', window: runB }, { name: 'demo', window: runA }], activity([first, second]))).toEqual([second, first]);
  // Two calls in one run take its tasks oldest first.
  const third = flow('demo', 110);
  expect(workflowTasksFor([{ name: 'demo', window: runB }, { name: 'demo', window: runB }], activity([third, second, first]))).toEqual([second, third]);
});

test('a card of an unknown run takes only what the cards with a window left', () => {
  const inRun = flow('demo', 10);
  const other = flow('demo', 100);
  // The unknown card comes first in the transcript, and would take the oldest task; the windowed card's own run comes first.
  expect(workflowTasksFor([{ name: 'demo', window: null }, { name: 'demo', window: window(5, 40) }], activity([inRun, other]))).toEqual([other, inRun]);
  expect(workflowTasksFor([{ name: 'demo', window: null }, { name: 'demo', window: window(5, 40) }], activity([inRun]))).toEqual([null, inRun]);
});

test('no task for an unknown name, a null name, a task that is not a workflow, or no activity', () => {
  const command = flow('demo', 1, { taskType: 'local_bash' });
  const workflow = flow('demo', 2);
  expect(workflowTasksFor([{ name: 'review', window: null }, { name: null, window: null }, { name: null, window: window(0) }, { name: 'demo', window: null }, { name: 'demo', window: null }], activity([workflow, command])))
    .toEqual([null, null, null, workflow, null]); // the command named alike is not a workflow; the named card took the one workflow first
  expect(workflowTasksFor([{ name: 'demo', window: null }, { name: null, window: null }], null)).toEqual([null, null]);
  expect(workflowTasksFor([], activity([workflow]))).toEqual([]);
});

test('a card with no name takes the oldest workflow task its own run left, after the named cards took theirs', () => {
  const named = flow('demo', 10);
  const other = flow('quick', 20);
  const outside = flow('late', 200);
  expect(workflowTasksFor([{ name: null, window: window(5, 40) }, { name: 'demo', window: window(5, 40) }, { name: null, window: window(5, 40) }], activity([outside, other, named])))
    .toEqual([other, named, null]);
});

test('a card stays while its workflow runs; with no task, while the call goes on or while its run goes on after the launch', () => {
  const launched = 'Workflow launched in background. Task ID: whb4jhsf7';
  expect(workflowCardShown(flow('demo', 1), { status: 'complete', reply: launched, runGoing: false })).toBe(true);
  for (const status of ['completed', 'failed', 'stopped']) expect(workflowCardShown(flow('demo', 1, { status }), { status: 'complete', reply: launched, runGoing: true })).toBe(false);
  expect(workflowCardShown(null, { status: 'streaming', reply: '', runGoing: true })).toBe(true);
  // The launch answered and the task is a moment away: the card stays while the run goes on, and not after.
  expect(workflowCardShown(null, { status: 'complete', reply: launched, runGoing: true })).toBe(true);
  expect(workflowCardShown(null, { status: 'complete', reply: launched, runGoing: false })).toBe(false);
  // An empty, interrupted call shows nothing; nor does a reply that is not the launch.
  expect(workflowCardShown(null, { status: 'complete', reply: 'SyntaxError: Unexpected token (3:4)', runGoing: true })).toBe(false);
  expect(workflowCardShown(null, { status: 'interrupted', reply: '', runGoing: false })).toBe(false);
});

test('a reply says the workflow started in either wording the tool uses', () => {
  expect(workflowLaunched('Workflow launched in background. Task ID: whb4jhsf7')).toBe(true);
  expect(workflowLaunched('Workflow started in the background (task wf-1).')).toBe(true);
  expect(workflowLaunched('scriptPath must be a script path this tool returned')).toBe(false);
});

test('only Claude Code\'s own run id shape marks a saved script: a script of the user\'s own named alike has no name from its path', () => {
  expect(parseWorkflowCall(call({ scriptPath: '/repo/tools/sync-wf_2026-10.js' }))?.name).toBeNull();
  expect(parseWorkflowCall(call({ scriptPath: '/repo/tools/sync-wf_abcdefgh-xyz.js' }))?.name).toBeNull();
  expect(parseWorkflowCall(call({ scriptPath: '/x/workflows/scripts/nightly-sync-wf_0a1b2c3d-4e5.js' }))?.name).toBe('nightly-sync');
});
