// Claude Code's own task list, as it keeps it on disk: one JSON file a task, under <config dir>/tasks/<list id>/.
// After each task call the engine reads the list back and adds it to the call's reply, so the desktop pins the list
// from the newest list it was given: earlier lines may not be loaded, may have failed, or may belong to an earlier session.
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import nodePath from "node:path";
import { CLAUDE_TASKS_MAX, CLAUDE_TASK_TEXT_MAX } from "@jolo/protocol";

/** The tool calls that change the list; reading calls (TaskGet, TaskList) change nothing to show. */
export const TASK_LIST_TOOLS = new Set(["TaskCreate", "TaskUpdate"]);
/** The reply line that carries the list after a task call, as JSON; the desktop reads it back by this prefix. */
export const TASK_LIST_LINE = "Task list: ";
/** Room for a task call's reply with its list; the list itself is held to TASK_LIST_BYTES, well inside. */
export const TASK_REPLY_MAX = 32 * 1024;
const TASK_LIST_BYTES = 24 * 1024;
// The conversation's activity carries the list too, and its schema takes no more than these.
const MAX_TASKS = CLAUDE_TASKS_MAX;
const MAX_TEXT = CLAUDE_TASK_TEXT_MAX;
const STATUSES = new Set(["pending", "in_progress", "completed"]);
/** Each list read gets the next number, so the desktop can tell the newest read when replies arrive out of order. */
let reads = 0;

const cut = (/** @type {unknown} */ value) => (typeof value === "string" && value.trim() ? value.trim().slice(0, MAX_TEXT) : null);

/**
 * The directory of a Claude session's task list, as Claude Code itself names it: its config directory (CLAUDE_CONFIG_DIR,
 * else ~/.claude), then tasks/, then the list id, which is CLAUDE_CODE_TASK_LIST_ID when set and the session id otherwise,
 * with every character other than a letter, a digit, `_` or `-` made a `-`. So the id is one plain path segment. `env`
 * must be the environment Claude runs with, not the engine's own. Null when there is no id.
 * @param {{ env?: Record<string, string | undefined>, sessionId: string | null | undefined, home?: string }} options
 */
export function taskListDirectory({ env = {}, sessionId, home = homedir() }) {
  const listId = (env.CLAUDE_CODE_TASK_LIST_ID || sessionId || "").replace(/[^a-zA-Z0-9_-]/g, "-");
  if (!listId) return null;
  return nodePath.join(env.CLAUDE_CONFIG_DIR || nodePath.join(home, ".claude"), "tasks", listId);
}

/**
 * The newest tasks in a task list directory, in the order they were made (by number): each task's id, subject, what it
 * says while in progress, and status, each text cut short. A file that does not read, or a task with another status (a
 * deleted one), is left out. At most MAX_TASKS tasks and TASK_LIST_BYTES of JSON: the oldest go first, since a long
 * conversation's list keeps every task it ever made. Null when the directory cannot be read, so a reply never claims a
 * list it did not see.
 * @param {string | null} directory
 * @returns {{ id: string, subject: string, activeForm: string | null, status: string }[] | null}
 */
export function readTaskList(directory) {
  if (!directory) return null;
  let names;
  try { names = readdirSync(directory); } catch { return null; }
  const numbered = names.filter((name) => /^\d+\.json$/.test(name)).sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
  /** @type {{ id: string, subject: string, activeForm: string | null, status: string }[]} */
  const newest = [];
  for (let at = numbered.length - 1; at >= 0 && newest.length < MAX_TASKS; at--) {
    /** @type {any} */
    let task;
    try { task = JSON.parse(readFileSync(nodePath.join(directory, numbered[at]), "utf8")); } catch { continue; }
    const subject = cut(task?.subject);
    // The id is cut like the other text; one that is blank or missing is the file's number.
    const id = cut(task?.id == null ? null : String(task.id)) ?? numbered[at].replace(/\.json$/, "");
    if (!subject || !STATUSES.has(task?.status)) continue;
    newest.push({ id, subject, activeForm: cut(task.activeForm), status: task.status });
  }
  const tasks = newest.reverse();
  while (tasks.length > 1 && Buffer.byteLength(JSON.stringify(tasks)) > TASK_LIST_BYTES) tasks.shift();
  return tasks;
}

/**
 * Whether a list read after a call agrees with what the tool said it did: a made task is in it under its number with
 * its subject, and a changed task is in it unless the call deleted it. A list that disagrees is not this session's (a
 * list id the engine cannot see, say), so it is not sent.
 * @param {{ id: string, subject: string }[]} tasks
 * @param {string} reply the tool's reply
 * @param {{ name: string, input: any }} call
 */
function agrees(tasks, reply, { name, input }) {
  const made = /^Task #(\S+) created/.exec(reply.trim());
  if (name === "TaskCreate") {
    const subject = cut(input?.subject);
    return Boolean(made && tasks.some((task) => task.id === made[1] && (!subject || task.subject === subject)));
  }
  const changed = /^Updated task #(\S+)/m.exec(reply);
  if (!changed) return input?.status === "deleted";
  return input?.status === "deleted" || tasks.some((task) => task.id === changed[1]);
}

/**
 * The list as Claude keeps it after a task call, stamped with when it was read and its read number, or null when the list
 * cannot be read or does not agree with the call.
 * @param {string} reply the tool's reply
 * @param {string | null} directory
 * @param {{ name: string, input: any }} call the task call the reply answers
 * @param {() => number} [now]
 * @returns {{ at: number, seq: number, tasks: { id: string, subject: string, activeForm: string | null, status: string }[] } | null}
 */
export function taskSnapshot(reply, directory, call, now = Date.now) {
  const tasks = readTaskList(directory);
  if (!tasks || !agrees(tasks, reply, call)) return null;
  return { at: now(), seq: ++reads, tasks };
}

/**
 * A task call's reply with the list after it on a line of its own (see taskSnapshot), or the reply as it is with no list.
 * @param {string} reply
 * @param {{ at: number, seq: number, tasks: any[] } | null} snapshot
 */
export const withTaskList = (reply, snapshot) => (snapshot ? `${reply}\n${TASK_LIST_LINE}${JSON.stringify(snapshot)}` : reply);
