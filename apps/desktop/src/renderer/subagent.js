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

const EDIT_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit)\s+(\S.*)$/;
const base = path => path.split('/').filter(Boolean).at(-1) ?? path;

/** A step as the live line shows it: the tool's verb and the file it touched, so the whole line is kept for hover. */
export function shortStep(step) {
  const match = /^([A-Za-z_]+):?\s*(.*)$/s.exec(step);
  if (!match) return step;
  const [, tool, rest] = match;
  if (tool === 'Bash' || tool === 'PowerShell') {
    const words = rest.split(/\s+/).filter(Boolean);
    if (words.length <= 3) return rest || tool;
    const file = [...words].reverse().find(word => word.includes('/'));
    return `${words[0]} …${file ? ` ${base(file)}` : ''}`;
  }
  return rest.includes('/') && !/\s/.test(rest) ? `${tool} ${base(rest)}` : rest ? `${tool} ${rest}` : tool;
}

/** The files a subagent edited, read from its steps, each once in the order it first touched them. */
export function editedFiles(steps) {
  const files = [];
  for (const step of steps) {
    const match = EDIT_TOOLS.exec(step);
    if (match && !files.includes(match[2])) files.push(match[2]);
  }
  return files;
}
