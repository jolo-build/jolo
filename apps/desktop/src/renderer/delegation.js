import { desktopRunLabel } from '@jolo/client/run-state';

// Claude names Jolo's MCP tools mcp__jolo__<tool>; Codex spells them jolo/<tool>.
const HEAD = /^(?:mcp__jolo__|jolo\/)(delegate_task|delegation_status|delegation_cancel) (\{.*)$/s;
// What the line reads from a result. The engine keeps these ahead of `output`, so they survive its 600-character cut.
const STRINGS = ['id', 'sessionId', 'title', 'state', 'activity', 'wakeReason'];
const FLAGS = ['done', 'partial'];
const FIELDS = [...STRINGS, ...FLAGS];
const ACTIVITY = { background: 'background work', working: 'working' };
const WOKE = { done: 'finished', answer: 'new answer', asking: 'needs you', parent_stopped: 'parent stopped', stopped: 'wait stopped', timeout: 'wait timed out' };

/** One string field of JSON that may be cut off, as `"key":"value"`; undefined unless the whole value is there. */
const text = (json, name) => {
  const match = new RegExp(`"${name}":"((?:[^"\\\\]|\\\\.)*)"`).exec(json);
  if (!match) return undefined;
  try { return JSON.parse(`"${match[1]}"`); } catch { return undefined; }
};
const flag = (json, name) => {
  const match = new RegExp(`"${name}":(true|false)`).exec(json);
  return match ? match[1] === 'true' : undefined;
};
const number = (json, name) => {
  const match = new RegExp(`"${name}":(-?\\d+(?:\\.\\d+)?)`).exec(json);
  return match ? Number(match[1]) : undefined;
};
const defined = entries => Object.fromEntries(entries.filter(([, value]) => value !== undefined));
const pick = (row, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]]));

/** The delegation fields of a result: the parsed object when it is whole, else whichever fields survived the cut. */
function readResult(json) {
  try {
    const value = JSON.parse(json);
    if (value && typeof value.delegation === 'object' && value.delegation) return pick(value.delegation, FIELDS);
  } catch { /* cut off: read it field by field */ }
  // `activity` may be null; a missing string field stays absent.
  const activity = /"activity":null/.test(json) ? null : text(json, 'activity');
  return defined([...STRINGS.map(name => [name, name === 'activity' ? activity : text(json, name)]), ...FLAGS.map(name => [name, flag(json, name)])]);
}

/**
 * A tool message that is one of Jolo's delegation calls: which call, its arguments, and what its result says about the
 * child, read tolerantly because the engine shows at most 600 characters of a result. Any other tool message gives null.
 * @param {string} message
 * @returns {{ name: 'delegate_task' | 'delegation_status' | 'delegation_cancel', args: Record<string, any>, delegation: Record<string, any> | null, error: string | null } | null}
 */
export function parseDelegationCall(message) {
  const at = message.indexOf('\n');
  const match = HEAD.exec(at < 0 ? message : message.slice(0, at));
  if (!match) return null;
  const name = /** @type {'delegate_task' | 'delegation_status' | 'delegation_cancel'} */ (match[1]);
  /** @type {Record<string, any>} */
  let args;
  try { args = JSON.parse(match[2]); }
  catch { args = defined([['modelAlias', text(match[2], 'modelAlias')], ['title', text(match[2], 'title')], ['delegationId', text(match[2], 'delegationId')], ['waitMs', number(match[2], 'waitMs')]]); }
  const result = at < 0 ? '' : message.slice(at + 1).trim();
  if (!result) return { name, args, delegation: null, error: null };
  if (!result.startsWith('{')) return { name, args, delegation: null, error: result };
  return { name, args, delegation: readResult(result), error: null };
}

// What a `delegation.list` row says better than a result: it reads no output, so its `partial` is always false.
const LIVE = ['id', 'sessionId', 'title', 'state', 'activity', 'done'];

/**
 * The child as the line shows it: the `delegation.list` row for the call's delegation over what the result says. The
 * live row wins for state, activity and done; why a wait ended, and a partial answer, come only from the result, and a
 * done child has no partial answer. A `delegate_task` still waiting for its result borrows the state of the newest row
 * with its title, but not its id or conversation, since a title is only a guess.
 * @param {NonNullable<ReturnType<typeof parseDelegationCall>>} call
 * @param {Map<string, any>} delegations rows as `delegation.list` sends them, newest first
 * @returns {Record<string, any>}
 */
export function liveDelegation(call, delegations) {
  const own = call.delegation ?? {};
  const id = own.id ?? (call.name === 'delegate_task' ? undefined : call.args.delegationId);
  const live = id ? delegations.get(id) : undefined;
  // A delegate_task that failed started nothing, so another child with the same title is not it.
  const guess = !live && !id && !call.error && call.name === 'delegate_task' && call.args.title ? [...delegations.values()].find(row => row.title === call.args.title) : undefined;
  const merged = { ...own, ...(live ? pick(live, LIVE) : guess ? pick(guess, LIVE.filter(key => key !== 'id' && key !== 'sessionId')) : {}) };
  if (own.partial !== undefined) merged.partial = own.partial && !merged.done;
  return merged;
}

/**
 * What a child is doing, in words: its state as the desktop says it (an answered child is `Answered`), what its process
 * is doing, a partial answer, `done` only when the engine says so, and why a wait for it ended.
 * @param {Record<string, any>} delegation
 */
export function delegationWords(delegation) {
  const state = delegation.state ? desktopRunLabel(delegation) : null;
  const woke = WOKE[delegation.wakeReason];
  const words = [state === 'Ready for review' ? 'Answered' : state, ACTIVITY[delegation.activity], delegation.partial && 'partial answer', delegation.done && 'done', woke && `woke: ${woke}`].filter(Boolean);
  // A word that repeats an earlier one (`Working · working`) is said once.
  return words.filter((word, index) => words.findIndex(other => other.toLowerCase() === word.toLowerCase()) === index).join(' · ');
}

/**
 * Whether a batch of engine events changes what a child is doing: a `run.state` or `session.activity` event of one of
 * the conversation's children.
 * @param {{ kind: string, value: any }[]} items
 * @param {Set<string>} children
 */
export function touchesChild(items, children) {
  return items.some(item => item.kind === 'event' && (item.value.type === 'run.state' || item.value.type === 'session.activity') && children.has(item.value.sessionId));
}

/**
 * A listener for engine event batches that loads the delegations once per burst of child events, `wait` ms after the
 * first, as the board refresh does; `cancel` drops a load still waiting.
 * @param {Set<string>} children
 * @param {() => void} load
 */
export function refreshOnChildEvents(children, load, wait = 400) {
  let timer = null;
  return {
    receive: (/** @type {{ kind: string, value: any }[]} */ items) => { if (!timer && touchesChild(items, children)) timer = setTimeout(() => { timer = null; load(); }, wait); },
    cancel: () => { clearTimeout(timer); timer = null; },
  };
}
