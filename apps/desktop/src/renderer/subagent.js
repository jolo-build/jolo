// The engine writes a subagent's progress into its parent call's output with this prefix; a blank line precedes the report.
const STEP = '↳ ';

/** One field of a call head whose JSON did not survive whole. */
const field = (json, name) => {
  const match = new RegExp(`"${name}":"((?:[^"\\\\]|\\\\.)*)"`).exec(json);
  if (!match) return undefined;
  try { return JSON.parse(`"${match[1]}"`); } catch { return undefined; }
};

/**
 * A tool message that is one of Claude's own subagents: what it is for, the agent kind and model running it, the
 * tools it used, and its report. Any other tool message gives null.
 * @param {string} text
 * @returns {{ type: string, description: string, model: string | null, steps: string[], report: string } | null}
 */
export function parseSubagent(text) {
  const at = text.indexOf('\n');
  const head = at < 0 ? text : text.slice(0, at);
  const match = /^(?:Agent|Task) (\{.*)$/s.exec(head);
  if (!match) return null;
  /** @type {Record<string, any>} */
  let input;
  try { input = JSON.parse(match[1]); }
  catch { input = { subagent_type: field(match[1], 'subagent_type'), description: field(match[1], 'description'), model: field(match[1], 'model'), prompt: field(match[1], 'prompt') }; }
  const description = String(input.description || String(input.prompt ?? '').trim().split('\n', 1)[0] || '');
  if (!description && !input.subagent_type) return null;
  const lines = at < 0 ? [] : text.slice(at + 1).split('\n');
  let model = typeof input.model === 'string' && input.model ? input.model : null;
  const steps = [];
  let index = 0;
  for (; index < lines.length && lines[index].startsWith(STEP); index++) {
    const line = lines[index].slice(STEP.length);
    if (line.startsWith('model: ')) model = line.slice('model: '.length);
    else steps.push(line);
  }
  return { type: String(input.subagent_type || 'Agent'), description, model, steps, report: lines.slice(index).join('\n').trim() };
}
