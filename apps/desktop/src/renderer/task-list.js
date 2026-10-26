// Claude's own task list, rebuilt from its task tool calls as the transcript shows them, to pin under the conversation.

/** @typedef {'pending' | 'in_progress' | 'completed'} TaskStatus */
/** @typedef {{ id: string, subject: string, activeForm: string | null, status: TaskStatus }} ListedTask */
/**
 * One task tool call: a task made (its id from the tool's reply, null until the reply is in or when the call failed), a
 * task changed (`ok` once the tool said it changed it), the whole list written at once (TodoWrite, older builds), or a
 * read that changes nothing. `snapshot` is the list as Claude kept it after the call, which the engine adds to the
 * reply (see the engine's claude-tasks.js), with when the engine read it (`order`: its time and read number, null on a
 * line from before the engine stamped them); `streaming` is a call still going.
 * @typedef {{ tasks: ListedTask[], order: [number, number] | null }} TaskSnapshot
 * @typedef {{ snapshot: TaskSnapshot | null, streaming: boolean }} TaskCallBase
 * @typedef {TaskCallBase & ({ kind: 'create', id: string | null, subject: string, activeForm: string | null }
 *   | { kind: 'update', id: string, status: TaskStatus | 'deleted' | null, subject: string | null, activeForm: string | null, ok: boolean }
 *   | { kind: 'write', tasks: { subject: string, activeForm: string | null, status: TaskStatus }[] }
 *   | { kind: 'read' })} TaskCall
 */

// The engine shows these calls as the tool's name, then its input as JSON on the same line; TodoWrite as `Todo list`, then its input.
const HEAD = /^(TaskCreate|TaskUpdate|TaskGet|TaskList) (\{[\s\S]*)$/;
const TODO_HEAD = 'Todo list';
const CREATED = /^Task #(\S+) created/;
const UPDATED = /^Updated task #/m;
/** The reply line the engine adds after a task call, with the list as JSON. */
const SNAPSHOT_LINE = 'Task list: ';
const STATUSES = new Set(['pending', 'in_progress', 'completed']);

/** @param {unknown} value */
const textOf = value => (typeof value === 'string' && value.trim() ? value.trim() : null);
/** @param {unknown} value @returns {TaskStatus} */
const statusOf = value => (typeof value === 'string' && STATUSES.has(value) ? /** @type {TaskStatus} */ (value) : 'pending');

/**
 * The list on a reply's snapshot line, each task checked, with when the engine read it; null when the reply has none or
 * it does not read. The line is `{ at, seq, tasks }`, or a bare array from before the engine stamped its reads.
 * @param {string} reply
 * @returns {TaskSnapshot | null}
 */
function snapshotOf(reply) {
  const line = reply.split('\n').findLast(entry => entry.startsWith(SNAPSHOT_LINE));
  if (!line) return null;
  /** @type {any} */
  let value;
  try { value = JSON.parse(line.slice(SNAPSHOT_LINE.length)); } catch { return null; }
  const stamped = !Array.isArray(value) && Number.isFinite(value?.at) && Number.isFinite(value?.seq);
  const tasks = Array.isArray(value) ? value : value?.tasks;
  if (!Array.isArray(tasks)) return null;
  return { order: stamped ? [value.at, value.seq] : null, tasks: tasks.flatMap((/** @type {any} */ task) => {
    const subject = textOf(task?.subject);
    const id = textOf(task?.id) ?? (Number.isInteger(task?.id) ? String(task.id) : null);
    return subject && id && STATUSES.has(task?.status) ? [{ id, subject, activeForm: textOf(task?.activeForm), status: statusOf(task.status) }] : [];
  }) };
}

/** Whether snapshot `a` was read after `b`: by the engine's stamps, else (or on a tie) by position. */
const newer = (/** @type {TaskSnapshot} */ a, /** @type {number} */ aAt, /** @type {TaskSnapshot} */ b, /** @type {number} */ bAt) => {
  if (a.order && b.order && (a.order[0] !== b.order[0] || a.order[1] !== b.order[1])) return a.order[0] > b.order[0] || (a.order[0] === b.order[0] && a.order[1] > b.order[1]);
  if (a.order && !b.order) return true;
  if (!a.order && b.order) return false;
  return aAt > bAt;
};

/**
 * A task tool call as the transcript shows it; null for any other line, or one whose input does not read.
 * @param {string} text the tool message's text (head line, then the reply or, for TodoWrite, its input)
 * @param {boolean} [streaming] whether the call is still going
 * @returns {TaskCall | null}
 */
export function parseTaskCall(text, streaming = false) {
  const at = text.indexOf('\n');
  const head = at < 0 ? text : text.slice(0, at);
  const rest = at < 0 ? '' : text.slice(at + 1);
  if (head === TODO_HEAD) {
    /** @type {any} */
    let input;
    try { input = JSON.parse(rest.split('\n', 1)[0]); } catch { return null; }
    if (!Array.isArray(input?.todos)) return null;
    const tasks = input.todos.flatMap((/** @type {any} */ todo) => {
      const subject = textOf(todo?.content) ?? textOf(todo?.subject);
      return subject ? [{ subject, activeForm: textOf(todo?.activeForm), status: statusOf(todo?.status) }] : [];
    });
    return { kind: 'write', tasks, snapshot: null, streaming };
  }
  const match = HEAD.exec(head);
  if (!match) return null;
  /** @type {any} */
  let input;
  try { input = JSON.parse(match[2]); } catch { return null; }
  const snapshot = snapshotOf(rest);
  if (match[1] === 'TaskGet' || match[1] === 'TaskList') return { kind: 'read', snapshot, streaming };
  if (match[1] === 'TaskCreate') {
    const subject = textOf(input?.subject);
    return subject ? { kind: 'create', id: CREATED.exec(rest.trim())?.[1] ?? null, subject, activeForm: textOf(input?.activeForm), snapshot, streaming } : null;
  }
  const id = textOf(input?.taskId) ?? (Number.isInteger(input?.taskId) ? String(input.taskId) : null);
  if (!id) return null;
  const status = input?.status === 'deleted' ? 'deleted' : typeof input?.status === 'string' && STATUSES.has(input.status) ? statusOf(input.status) : null;
  const ok = UPDATED.test(rest) || (status === 'deleted' && /\bdeleted\b/i.test(rest) && !/error/i.test(rest));
  return { kind: 'update', id, status, subject: textOf(input?.subject), activeForm: textOf(input?.activeForm), ok, snapshot, streaming };
}

/**
 * The list the calls leave. The newest list the engine read is the list as Claude keeps it, so it is the base: newest by
 * when the engine read it, since calls Claude runs side by side can answer out of order, else by position. On top of it
 * apply every call still going, wherever it sits, and every call after it with no list of its own (a transcript from
 * before the engine added lists); a finished call with an older list is already in the base. Applying a call: a
 * TodoWrite replaces the whole list; a task made joins it once the tool gave it an id, or while its call is still going
 * under a stand-in id, and a made task whose id is already listed starts a new list, since a new Claude session numbers
 * its tasks from #1 again; an update changes its task once the tool said so, or while its call is still going, and a
 * deleted task leaves. A failed call changes nothing.
 * @param {TaskCall[]} calls in transcript order
 * @returns {ListedTask[]}
 */
export function taskListFrom(calls) {
  let base = -1;
  calls.forEach((call, index) => {
    if (call.snapshot && (base < 0 || newer(call.snapshot, index, /** @type {TaskSnapshot} */ (calls[base].snapshot), base))) base = index;
  });
  /** @type {ListedTask[]} */
  let tasks = base < 0 ? [] : /** @type {TaskSnapshot} */ (calls[base].snapshot).tasks.map(task => ({ ...task }));
  calls.forEach((call, index) => {
    if (index === base || !(call.streaming || (index > base && !call.snapshot))) return;
    if (call.kind === 'write') tasks = call.tasks.map((task, at) => ({ id: `todo:${index}:${at}`, ...task }));
    else if (call.kind === 'create') {
      if (!call.id && !call.streaming) return; // the tool made no task
      if (call.id && tasks.some(task => task.id === call.id)) {
        if (call.streaming) return; // already in the list the engine read
        tasks = [];
      }
      tasks.push({ id: call.id ?? `new:${index}`, subject: call.subject, activeForm: call.activeForm, status: 'pending' });
    } else if (call.kind === 'update') {
      if (!call.ok && !call.streaming) return; // the tool changed nothing
      const at = tasks.findIndex(task => task.id === call.id);
      if (at < 0) return;
      if (call.status === 'deleted') { tasks.splice(at, 1); return; }
      const task = tasks[at];
      tasks[at] = { ...task, status: call.status ?? task.status, subject: call.subject ?? task.subject, activeForm: call.activeForm ?? task.activeForm };
    }
  });
  return tasks;
}

/** How many of the tasks are done, and whether all of them are. @param {ListedTask[]} tasks */
export function taskProgress(tasks) {
  const done = tasks.filter(task => task.status === 'completed').length;
  return { done, total: tasks.length, finished: tasks.length > 0 && done === tasks.length };
}

/** What a task's status is in words, for a screen reader: its mark says it only by sight. @param {TaskStatus} status */
export const taskStatusWords = status => (status === 'completed' ? 'done' : status === 'in_progress' ? 'in progress' : 'not started');
