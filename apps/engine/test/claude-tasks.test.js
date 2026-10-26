// Claude Code's own task list read back from disk, to ride on a task call's reply and on the conversation's activity
// (see agents/claude-tasks.js).
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import { ClaudeTaskListSchema, CLAUDE_TASKS_MAX, CLAUDE_TASK_TEXT_MAX } from '@jolo/protocol';
import { readTaskList, TASK_LIST_LINE, taskListDirectory, taskSnapshot, withTaskList } from '../src/agents/claude-tasks.js';

const scratch = () => mkdtempSync(nodePath.join(tmpdir(), 'jolo-tasks-'));
/** Write task files into a directory. @param {string} dir @param {Record<string, any>} files */
const put = (dir, files) => { for (const [name, value] of Object.entries(files)) writeFileSync(nodePath.join(dir, name), typeof value === 'string' ? value : JSON.stringify(value)); };
/** The list a reply carries, parsed. @param {string} reply */
const carried = (reply) => JSON.parse(reply.split('\n').find((line) => line.startsWith(TASK_LIST_LINE)).slice(TASK_LIST_LINE.length));
const made = (/** @type {string} */ subject) => ({ name: 'TaskCreate', input: { subject } });
const moved = (/** @type {string} */ taskId, status = 'completed') => ({ name: 'TaskUpdate', input: { taskId, status } });

test('the list lives under the config directory Claude runs with, by its list id or else the session id', () => {
  expect(taskListDirectory({ env: {}, sessionId: 'abc-123', home: '/home/me' })).toBe('/home/me/.claude/tasks/abc-123');
  expect(taskListDirectory({ env: { CLAUDE_CONFIG_DIR: '/cfg' }, sessionId: 'abc-123', home: '/home/me' })).toBe('/cfg/tasks/abc-123');
  expect(taskListDirectory({ env: { CLAUDE_CODE_TASK_LIST_ID: 'team-a' }, sessionId: 'abc-123', home: '/home/me' })).toBe('/home/me/.claude/tasks/team-a');
});

test('the list id is made one plain path segment as Claude makes it, and no id gives no directory', () => {
  expect(taskListDirectory({ env: { CLAUDE_CODE_TASK_LIST_ID: 'proj.v2' }, sessionId: 's', home: '/h' })).toBe('/h/.claude/tasks/proj-v2');
  for (const sessionId of ['..', '../etc', 'a/b', 'a\\b']) expect(nodePath.dirname(/** @type {string} */ (taskListDirectory({ env: {}, sessionId, home: '/h' })))).toBe('/h/.claude/tasks');
  for (const sessionId of [null, undefined, '']) expect(taskListDirectory({ env: {}, sessionId, home: '/h' })).toBeNull();
});

test('the list reads in task number order, each text cut short, leaving out what does not read or is deleted', () => {
  const dir = scratch();
  try {
    put(dir, {
      '10.json': { id: '10', subject: 'Tenth', status: 'pending' },
      '2.json': { id: '2', subject: 'Second', activeForm: 'Doing the second', status: 'in_progress', description: 'x'.repeat(5000) },
      '1.json': { id: '1', subject: 'S'.repeat(500), status: 'completed' },
      '3.json': '{ broken', '4.json': { id: '4', subject: 'Gone', status: 'deleted' }, '5.json': { id: '5', status: 'pending' }, 'notes.txt': 'not a task',
    });
    mkdirSync(nodePath.join(dir, '6.json'));
    const tasks = /** @type {any[]} */ (readTaskList(dir));
    expect(tasks.map((task) => [task.id, task.status])).toEqual([['1', 'completed'], ['2', 'in_progress'], ['10', 'pending']]);
    expect(tasks[0].subject).toHaveLength(200);
    expect(tasks[1]).toEqual({ id: '2', subject: 'Second', activeForm: 'Doing the second', status: 'in_progress' });
    expect(tasks[2].activeForm).toBeNull();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a long conversation keeps its newest tasks: the oldest go first, by count and by size', () => {
  const dir = scratch();
  try {
    for (let id = 1; id <= 130; id++) put(dir, { [`${id}.json`]: { id: String(id), subject: `Task ${id} ${'s'.repeat(180)}`, activeForm: 'a'.repeat(190), status: id < 128 ? 'completed' : 'in_progress' } });
    const tasks = /** @type {any[]} */ (readTaskList(dir));
    expect(tasks.at(-1).id).toBe('130');
    expect(tasks.length).toBeLessThanOrEqual(100);
    expect(Buffer.byteLength(JSON.stringify(tasks))).toBeLessThanOrEqual(24 * 1024);
    expect(tasks.map((task) => Number(task.id))).toEqual([...tasks.map((task) => Number(task.id))].sort((a, b) => a - b));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a reply carries the list stamped with its read time and number, each read numbered after the last', () => {
  const dir = scratch();
  try {
    put(dir, { '1.json': { id: '1', subject: 'Read', status: 'pending' } });
    const read = taskSnapshot('Task #1 created successfully: Read', dir, made('Read'), () => 1000);
    const first = carried(withTaskList('Task #1 created successfully: Read', read));
    expect(first).toMatchObject({ at: 1000, tasks: [{ id: '1', subject: 'Read', activeForm: null, status: 'pending' }] });
    // The reply's line is that same read, so the activity that carries it ties with the line exactly.
    expect(first).toEqual(/** @type {any} */ (read));
    put(dir, { '1.json': { id: '1', subject: 'Read', status: 'completed' } });
    const second = /** @type {any} */ (taskSnapshot('Updated task #1 status', dir, moved('1'), () => 1000));
    expect(second.seq).toBeGreaterThan(first.seq);
    expect(second.tasks[0].status).toBe('completed');
    expect(carried(withTaskList('Updated task #1 status', second))).toEqual(second);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('with no list read, the reply stays as it is', () => {
  expect(withTaskList('Task #1 created successfully: Read', null)).toBe('Task #1 created successfully: Read');
});

test('a list that disagrees with the call is not sent: it is not this session\'s', () => {
  const dir = scratch();
  try {
    put(dir, { '1.json': { id: '1', subject: 'Unrelated CLI task', status: 'pending' } });
    expect(taskSnapshot('Task #1 created successfully: Read', dir, made('Read'))).toBeNull();
    expect(taskSnapshot('Task #2 created successfully: Read', dir, made('Read'))).toBeNull();
    expect(taskSnapshot('Updated task #7 status', dir, moved('7'))).toBeNull();
    // A deleted task is rightly gone from the list.
    expect(taskSnapshot('Updated task #7 deleted', dir, moved('7', 'deleted'))).toMatchObject({ tasks: [{ id: '1' }] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a list that cannot be read gives no list', () => {
  const dir = scratch();
  try {
    expect(taskSnapshot('Updated task #1 status', nodePath.join(dir, 'missing'), moved('1'))).toBeNull();
    expect(taskSnapshot('Updated task #1 status', null, moved('1'))).toBeNull();
    expect(readTaskList(nodePath.join(dir, 'missing'))).toBeNull();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('what the list reads stays inside the bounds the conversation\'s activity takes, its ids cut like its text', () => {
  const dir = scratch();
  try {
    for (let id = 1; id <= 150; id++) put(dir, { [`${id}.json`]: { id: String(id), subject: `Task ${id}`, status: 'pending' } });
    put(dir, {
      '148.json': { id: 'i'.repeat(1000), subject: 'S'.repeat(1000), status: 'in_progress' },
      '149.json': { id: '', subject: 'No id of its own', status: 'pending' },
      '150.json': { id: '150', subject: '   ', status: 'pending' },
    });
    const tasks = /** @type {any[]} */ (readTaskList(dir));
    expect(tasks.length).toBeLessThanOrEqual(CLAUDE_TASKS_MAX);
    const long = tasks.find((task) => task.status === 'in_progress');
    expect(long.id).toBe('i'.repeat(CLAUDE_TASK_TEXT_MAX));
    expect(long.subject).toHaveLength(CLAUDE_TASK_TEXT_MAX);
    expect(tasks.find((task) => task.subject === 'No id of its own').id).toBe('149'); // the file's number
    expect(tasks.some((task) => task.id === '150')).toBe(false); // a blank subject is no task
    const read = taskSnapshot('Task #149 created successfully: No id of its own', dir, made('No id of its own'));
    expect(read).not.toBeNull();
    expect(ClaudeTaskListSchema.safeParse({ runId: 'run-1', ...read }).success).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
