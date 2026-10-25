// Claude's `Workflow` tool calls as the transcript shows them, and the activity task each one's card is about.

/** @typedef {import('./activity.js').TaskRecord} TaskRecord */

// The engine shows a generic tool call as its name, then its input as JSON on the same line, cut at its display cap.
const HEAD = /^Workflow (\{.*)$/s;
// A script's `meta` literal, which comes first by the tool's own contract.
const META = /\bmeta\s*=\s*\{/;
const QUOTES = new Set(["'", '"', '`']);
const OPENS = new Set(['{', '[', '(']);
const CLOSES = new Set(['}', ']', ')']);
// Sticky, so the scans below read at a position without copying the rest of the text.
const WORD = /[\w$]+/y;
const COLON = /\s*:\s*/y;
const STRING_COLON = /\s*:\s*"/y;

/** The match of a sticky pattern at `at`, or null. @param {RegExp} pattern @param {string} text @param {number} at */
const stickAt = (pattern, text, at) => { pattern.lastIndex = at; return pattern.exec(text); };

/** The index just past the string literal that opens at `at`, or -1 when the text ends inside it. @param {string} text @param {number} at */
function pastString(text, at) {
  for (let index = at + 1; index < text.length; index++) {
    if (text[index] === '\\') index++;
    else if (text[index] === text[at]) return index + 1;
  }
  return -1;
}

/**
 * The name of a script's meta literal: its own `name` key (bare or quoted), outside every string, comment and nested
 * array, object or call, with a string value quoted with ', " or a backtick. The scan stops at the literal's closing
 * brace, so code after it names nothing; null when the literal has no such name, or the script ends first.
 * @param {string} script
 */
function metaName(script) {
  const meta = META.exec(script);
  if (!meta) return null;
  let depth = 0;
  let keyed = false; // the next token starts a key of the literal: just after its `{`, or a `,` of its own
  for (let at = meta.index + meta[0].length - 1; at < script.length;) {
    const char = script[at];
    if (/\s/.test(char)) { at++; continue; }
    if (script.startsWith('//', at) || script.startsWith('/*', at)) {
      const end = script[at + 1] === '/' ? script.indexOf('\n', at) : script.indexOf('*/', at + 2);
      if (end < 0) return null;
      at = end + (script[at + 1] === '/' ? 1 : 2);
      continue;
    }
    if (QUOTES.has(char) || /[A-Za-z_$]/.test(char)) {
      const end = QUOTES.has(char) ? pastString(script, at) : at + (stickAt(WORD, script, at)?.[0].length ?? 1);
      if (end < 0) return null;
      const token = QUOTES.has(char) ? script.slice(at + 1, end - 1) : script.slice(at, end);
      const colon = depth === 1 && keyed && token === 'name' ? stickAt(COLON, script, end) : null;
      if (colon) {
        const start = end + colon[0].length;
        const close = QUOTES.has(script[start]) ? pastString(script, start) : -1;
        return close < 0 ? null : script.slice(start + 1, close - 1) || null;
      }
      keyed = false;
      at = end;
      continue;
    }
    if (OPENS.has(char)) depth++;
    else if (CLOSES.has(char) && --depth === 0) return null;
    keyed = depth === 1 && (char === ',' || char === '{');
    at++;
  }
  return null;
}

/**
 * One string field of a JSON object at its top level, read from JSON that may be cut off: outside every string and every
 * nested object or array, so a `name` among the input's arguments is not the input's own. Null unless its value is all
 * there.
 * @param {string} json
 * @param {string} key
 */
function topLevelField(json, key) {
  let depth = 0;
  for (let at = 0; at < json.length; at++) {
    const char = json[at];
    if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') depth--;
    else if (char === '"') {
      const end = pastString(json, at);
      if (end < 0) return null;
      const colon = depth === 1 ? stickAt(STRING_COLON, json, end) : null;
      if (!colon) { at = end - 1; continue; }
      const start = end + colon[0].length - 1;
      const close = pastString(json, start);
      if (close < 0) return null;
      if (json.slice(at + 1, end - 1) === key) {
        try { return JSON.parse(json.slice(start, close)) || null; } catch { return null; }
      }
      at = close - 1;
    }
  }
  return null;
}

/**
 * The script of an input the engine cut: its JSON string decoded as far as it goes, so a `"` of the script (`\"` in the
 * head) reads as itself. An escape the cut split is left out. Null when the input has no script.
 * @param {string} json
 */
function cutScript(json) {
  const match = /"script"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(json);
  if (!match) return null;
  try { return JSON.parse(`"${match[1].replace(/\\u[0-9a-fA-F]{0,3}$/, '')}"`); } catch { return null; }
}

/**
 * The workflow an input names: its own `name` (a saved workflow), else its script's meta name. From a head the engine cut,
 * a script's meta name when it has a script, and its top-level `name` only when it has none, since a `name` the cut
 * input shows first may be one of its arguments'.
 * @param {string} json
 */
function inputName(json) {
  /** @type {any} */
  let input;
  try { input = JSON.parse(json); }
  catch {
    const script = cutScript(json);
    return script === null ? topLevelField(json, 'name') : metaName(script);
  }
  if (typeof input?.name === 'string' && input.name) return input.name;
  return typeof input?.script === 'string' ? metaName(input.script) : null;
}

/**
 * A `Workflow` tool call as the transcript shows it; null for any other tool line. Its name is the input's `name` when
 * it has one, else the `name:` of its script's `meta` literal, read from the head the engine may have cut; null when
 * neither is there (a `scriptPath` call, say). Its reply is the text after the head, trimmed: empty while the call is
 * still going, then the tool's answer or its error.
 * @param {string} text the tool message's text (head line, then the reply)
 * @returns {{ name: string | null, reply: string } | null}
 */
export function parseWorkflowCall(text) {
  const at = text.indexOf('\n');
  const match = HEAD.exec(at < 0 ? text : text.slice(0, at));
  if (!match) return null;
  return { name: inputName(match[1]), reply: at < 0 ? '' : text.slice(at + 1).trim() };
}

/**
 * A Workflow call as the cards ask for their tasks: the workflow's name (see parseWorkflowCall) and the window its task can
 * have started in, which is its run's (as the conversation builds it, in ms), or null when its run is not known.
 * @typedef {{ name: string | null, window: { from: number, to: number } | null }} WorkflowCallSlot
 */

/**
 * The task each Workflow call's card is about, in the calls' order. A transcript line does not carry its call's id, so a
 * card finds its task by the workflow's name, among the activity's workflow tasks, each name's oldest first: first every
 * call whose run is known takes the oldest unclaimed task of its name that started within its run's window (so a card
 * never takes a task of an earlier process, or one that started after its run ended), then every call whose run is not
 * known takes the oldest unclaimed task of its name of those left. A null name takes nothing.
 * @param {WorkflowCallSlot[]} calls in transcript order
 * @param {import('./activity.js').Activity | null} activity
 * @returns {(TaskRecord | null)[]}
 */
export function workflowTasksFor(calls, activity) {
  /** @type {Map<string, TaskRecord[]>} */
  const byName = new Map();
  for (const task of activity?.tasks ?? []) {
    if (task.taskType !== 'local_workflow' || !task.workflowName) continue;
    const tasks = byName.get(task.workflowName);
    if (tasks) tasks.push(task);
    else byName.set(task.workflowName, [task]);
  }
  for (const tasks of byName.values()) tasks.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  /** @type {(TaskRecord | null)[]} */
  const found = calls.map(() => null);
  /** Take the oldest unclaimed task of a name that `fits`. @param {string} name @param {(task: TaskRecord) => boolean} fits */
  const take = (name, fits) => {
    const tasks = byName.get(name);
    const at = tasks ? tasks.findIndex(fits) : -1;
    return at < 0 ? null : /** @type {TaskRecord[]} */ (tasks).splice(at, 1)[0];
  };
  calls.forEach(({ name, window }, index) => {
    if (name !== null && window) found[index] = take(name, task => Date.parse(task.startedAt) >= window.from && Date.parse(task.startedAt) <= window.to);
  });
  calls.forEach(({ name, window }, index) => {
    if (name !== null && !window) found[index] = take(name, () => true);
  });
  return found;
}
