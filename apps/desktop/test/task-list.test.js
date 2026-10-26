import { expect, test } from 'bun:test';
import { parseTaskCall, taskListFrom, taskProgress, taskStatusWords } from '../src/renderer/task-list.js';

/** A task tool call's line as the engine shows it: the tool, its input as JSON, then the reply. */
const line = (/** @type {string} */ tool, /** @type {any} */ input, reply = '') => `${tool} ${JSON.stringify(input)}\n${reply}`;
/** The list line the engine adds to a task call's reply, stamped with its read time and number. @param {any[]} tasks */
const listed = (tasks, at = 1000, seq = 1) => `\nTask list: ${JSON.stringify({ at, seq, tasks })}`;
const create = (/** @type {string} */ subject, /** @type {string} */ id, after = '') => /** @type {any} */ (parseTaskCall(line('TaskCreate', { subject, activeForm: `${subject}ing` }, `Task #${id} created successfully: ${subject}${after}`)));
const update = (/** @type {string} */ taskId, /** @type {any} */ fields, after = '') => /** @type {any} */ (parseTaskCall(line('TaskUpdate', { taskId, ...fields }, `Updated task #${taskId} status${after}`)));
const shape = (/** @type {any[]} */ tasks) => tasks.map(task => [task.id, task.subject, task.status]);

test('a made task takes its id from the reply, and has none while the call is still going or when it failed', () => {
  expect(create('Read config', '1')).toEqual({ kind: 'create', id: '1', subject: 'Read config', activeForm: 'Read configing', snapshot: null, streaming: false });
  expect(parseTaskCall(line('TaskCreate', { subject: 'Run tests' }), true)).toEqual({ kind: 'create', id: null, subject: 'Run tests', activeForm: null, snapshot: null, streaming: true });
  expect(parseTaskCall(line('TaskCreate', { subject: 'Build' }, 'InputValidationError: description is missing'))).toMatchObject({ kind: 'create', id: null, streaming: false });
});

test('an update names its task and what changed, and whether the tool changed it; reads change nothing; other lines and broken input are not task calls', () => {
  expect(update('2', { status: 'in_progress' })).toEqual({ kind: 'update', id: '2', status: 'in_progress', subject: null, activeForm: null, ok: true, snapshot: null, streaming: false });
  expect(parseTaskCall(line('TaskUpdate', { taskId: '99', status: 'completed' }, 'Task not found'))).toMatchObject({ ok: false });
  expect(parseTaskCall(line('TaskUpdate', { taskId: 3, status: 'deleted' }, 'Task #3 deleted'))).toMatchObject({ id: '3', status: 'deleted', ok: true });
  expect(update('2', { subject: 'Write the code' })).toMatchObject({ status: null, subject: 'Write the code' });
  expect(parseTaskCall(line('TaskList', {}))).toEqual({ kind: 'read', snapshot: null, streaming: false });
  expect(parseTaskCall(line('TaskGet', { taskId: '1' }))).toMatchObject({ kind: 'read' });
  expect(parseTaskCall('Bash: list files\n$ ls')).toBeNull();
  expect(parseTaskCall('TaskCreate {"subject":')).toBeNull();
  expect(parseTaskCall(line('TaskCreate', { description: 'no subject' }))).toBeNull();
  expect(parseTaskCall(line('TaskUpdate', { status: 'completed' }))).toBeNull();
});

test('the list line the engine adds is read back with its stamp, each task checked, the last such line winning', () => {
  const call = create('Write', '2', listed([{ id: '1', subject: 'Read', activeForm: 'Reading', status: 'completed' }, { id: 2, subject: 'Write', status: 'pending' }, { id: '3', status: 'pending' }, { id: '4', subject: 'Odd', status: 'deleted' }], 1500, 7));
  expect(call.snapshot).toEqual({ order: [1500, 7], tasks: [{ id: '1', subject: 'Read', activeForm: 'Reading', status: 'completed' }, { id: '2', subject: 'Write', activeForm: null, status: 'pending' }] });
  expect(create('Write', '2', '\nTask list: not json').snapshot).toBeNull();
  // A bare array is a line from before the engine stamped its reads.
  expect(create('Write', '2', `\nTask list: ${JSON.stringify([{ id: '2', subject: 'Write', status: 'pending' }])}`).snapshot).toEqual({ order: null, tasks: [{ id: '2', subject: 'Write', activeForm: null, status: 'pending' }] });
  // Two lines in one reply: the last one is the list.
  const two = create('Write', '2', `${listed([{ id: '1', subject: 'Stale', status: 'pending' }])}${listed([{ id: '1', subject: 'Fresh', status: 'pending' }])}`);
  expect(two.snapshot.tasks[0].subject).toBe('Fresh');
});

test('a subject with a line or paragraph separator still reads as a task call', () => {
  const call = parseTaskCall(`TaskCreate {"subject":"Fix\u2028parser"}\nTask #1 created successfully: Fix parser${listed([{ id: '1', subject: 'Fix parser', status: 'pending' }])}`);
  expect(call).toMatchObject({ kind: 'create', id: '1', subject: 'Fix\u2028parser' });
});

test('replies Claude ran side by side can come back out of order: the list read last is the base, whatever its place', () => {
  // A (completing #1) was slower than B (starting #2): B's reply came first and carries the older list.
  const A = update('1', { status: 'completed' }, listed([{ id: '1', subject: 'Read', status: 'completed' }, { id: '2', subject: 'Write', status: 'in_progress' }], 2000, 9));
  const B = update('2', { status: 'in_progress' }, listed([{ id: '1', subject: 'Read', status: 'in_progress' }, { id: '2', subject: 'Write', status: 'in_progress' }], 1990, 8));
  expect(shape(taskListFrom([A, B]))).toEqual([['1', 'Read', 'completed'], ['2', 'Write', 'in_progress']]);
  // A stamp beats a line from before the engine stamped its reads; two unstamped lines go by position.
  const old = update('1', { status: 'in_progress' }, `\nTask list: ${JSON.stringify([{ id: '1', subject: 'Read', status: 'in_progress' }])}`);
  expect(shape(taskListFrom([A, old]))).toEqual([['1', 'Read', 'completed'], ['2', 'Write', 'in_progress']]);
});

test('a call still going applies on top of the newest list wherever it sits, and a finished call with an older list does not', () => {
  const base = update('1', { status: 'in_progress' }, listed([{ id: '1', subject: 'Read', status: 'in_progress' }, { id: '2', subject: 'Write', status: 'pending' }], 3000, 5));
  const going = /** @type {any} */ (parseTaskCall(line('TaskUpdate', { taskId: '2', status: 'in_progress' }), true));
  expect(shape(taskListFrom([going, base]))).toEqual([['1', 'Read', 'in_progress'], ['2', 'Write', 'in_progress']]);
  const olderDone = update('1', { status: 'completed' }, listed([{ id: '1', subject: 'Read', status: 'completed' }], 2000, 4));
  expect(shape(taskListFrom([base, olderDone]))).toEqual([['1', 'Read', 'in_progress'], ['2', 'Write', 'pending']]);
});

test('without list lines, the list keeps the order tasks were made in, follows each update, and drops a deleted task', () => {
  const calls = [create('Read config', '1'), create('Write code', '2'), create('Run tests', '3'), update('1', { status: 'in_progress' }), update('1', { status: 'completed' }), update('2', { status: 'in_progress' }), parseTaskCall(line('TaskUpdate', { taskId: '3', status: 'deleted' }, 'Updated task #3 deleted')), update('9', { status: 'completed' })];
  const tasks = taskListFrom(/** @type {any} */ (calls));
  expect(shape(tasks)).toEqual([['1', 'Read config', 'completed'], ['2', 'Write code', 'in_progress']]);
  expect(taskProgress(tasks)).toEqual({ done: 1, total: 2, finished: false });
  expect(taskProgress(taskListFrom(/** @type {any} */ ([...calls, update('2', { status: 'completed' })])))).toEqual({ done: 2, total: 2, finished: true });
  expect(taskProgress([])).toEqual({ done: 0, total: 0, finished: false });
});

test('a failed call changes nothing; a call still going counts under a stand-in until its reply is in', () => {
  const failedCreate = parseTaskCall(line('TaskCreate', { subject: 'Build' }, 'InputValidationError: description is missing'));
  const failedUpdate = parseTaskCall(line('TaskUpdate', { taskId: '1', status: 'completed' }, 'Task not found'));
  const tasks = taskListFrom(/** @type {any} */ ([failedCreate, create('Build', '1'), failedUpdate]));
  expect(shape(tasks)).toEqual([['1', 'Build', 'pending']]);
  const going = taskListFrom(/** @type {any} */ ([create('Build', '1'), parseTaskCall(line('TaskCreate', { subject: 'Test' }), true), parseTaskCall(line('TaskUpdate', { taskId: '1', status: 'in_progress' }), true)]));
  expect(shape(going)).toEqual([['1', 'Build', 'in_progress'], ['new:1', 'Test', 'pending']]);
});

test('a made task whose id is already listed starts a new list, as a new Claude session numbers from #1 again', () => {
  const calls = [create('A', '1'), update('1', { status: 'completed' }), create('C', '1'), update('1', { status: 'in_progress' })];
  expect(shape(taskListFrom(/** @type {any} */ (calls)))).toEqual([['1', 'C', 'in_progress']]);
});

test('the newest list line is the list: earlier calls, loaded or not, no longer matter, and later ones apply on top', () => {
  // Only an update was loaded (the creates are in older pages), but its reply carries the whole list.
  const latest = update('2', { status: 'in_progress' }, listed([{ id: '1', subject: 'Read', status: 'completed' }, { id: '2', subject: 'Write', activeForm: 'Writing', status: 'in_progress' }, { id: '3', subject: 'Test', status: 'pending' }]));
  expect(shape(taskListFrom([latest]))).toEqual([['1', 'Read', 'completed'], ['2', 'Write', 'in_progress'], ['3', 'Test', 'pending']]);
  // An older session's calls before it, even with clashing ids, change nothing.
  expect(shape(taskListFrom([create('Old', '2'), update('2', { status: 'completed' }), latest]))).toEqual([['1', 'Read', 'completed'], ['2', 'Write', 'in_progress'], ['3', 'Test', 'pending']]);
  // A call still going after it applies on top.
  const after = /** @type {any} */ (parseTaskCall(line('TaskUpdate', { taskId: '2', status: 'completed' }), true));
  expect(shape(taskListFrom([latest, after]))).toEqual([['1', 'Read', 'completed'], ['2', 'Write', 'completed'], ['3', 'Test', 'pending']]);
});

test("an older build's TodoWrite replaces the whole list", () => {
  const todo = parseTaskCall(`Todo list\n${JSON.stringify({ todos: [{ content: 'Plan', status: 'completed', activeForm: 'Planning' }, { content: 'Build', status: 'in_progress', activeForm: 'Building' }, { status: 'pending' }] })}`);
  expect(todo).toEqual({ kind: 'write', tasks: [{ subject: 'Plan', activeForm: 'Planning', status: 'completed' }, { subject: 'Build', activeForm: 'Building', status: 'in_progress' }], snapshot: null, streaming: false });
  const tasks = taskListFrom(/** @type {any} */ ([create('Old', '1'), todo]));
  expect(tasks.map(task => task.subject)).toEqual(['Plan', 'Build']);
});

test('each status reads in words for a screen reader', () => {
  expect(['completed', 'in_progress', 'pending'].map(status => taskStatusWords(/** @type {any} */ (status)))).toEqual(['done', 'in progress', 'not started']);
});
