import { codeTokens, grammarFor, MAX_HIGHLIGHT_CHARS } from './code-tokens.js';
import { diffLineKind } from './diff-lines.js';

export function languageForPath(path) {
  const name = String(path ?? '').split('/').at(-1).toLowerCase();
  if (/^(dockerfile|containerfile)(\.|$)/.test(name)) return 'docker';
  if (/^\.(bashrc|bash_profile|zshrc|zprofile)$/.test(name)) return 'bash';
  return grammarFor(name.split('.').at(-1))?.name ?? null;
}

function headerPath(value) {
  if (value.startsWith('"')) {
    try { value = JSON.parse(value); } catch { value = value.slice(1, -1); }
  }
  return value === '/dev/null' ? null : value.replace(/^[ab]\//, '');
}

/** Split syntax spans at line breaks, keeping multiline strings/comments styled on every line. */
function tokenLines(nodes) {
  const lines = [[]];
  const visit = (nodes, parents = []) => {
    for (const node of nodes) {
      if (typeof node !== 'string') { visit(node.children, [...parents, node.kinds]); continue; }
      node.split('\n').forEach((text, index) => {
        if (index) lines.push([]);
        if (text) lines.at(-1).push(parents.reduceRight((child, kinds) => ({ kinds, children: [child] }), text));
      });
    }
  };
  visit(nodes);
  return lines;
}

/** Highlight each side of a hunk separately: removed syntax must not affect the added code. */
export function diffTokens(text, path) {
  const lines = text.split('\n').map(text => ({ text, kind: diffLineKind(text), prefix: '', tokens: [text] }));
  let beforePath = path, afterPath = path, hunk = [], beforeLeft = 0, afterLeft = 0;
  let budget = MAX_HIGHLIGHT_CHARS * 4;
  const flush = () => {
    if (!hunk.length) return;
    for (const side of ['before', 'after']) {
      const rows = hunk.filter(line => side === 'before' ? line.kind !== 'add' : line.kind !== 'remove');
      const source = rows.map(line => line.text.slice(1)).join('\n');
      const language = languageForPath(side === 'before' ? beforePath : afterPath);
      if (language && source.length <= budget) {
        budget -= source.length;
        const tokens = tokenLines(codeTokens(source, language));
        rows.forEach((line, index) => { line.prefix = line.text[0]; line.tokens = tokens[index] ?? []; });
      }
    }
    hunk = [];
  };
  for (const line of lines) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line.text);
    if (header) {
      flush(); beforeLeft = Number(header[2] ?? 1); afterLeft = Number(header[4] ?? 1);
      continue;
    }
    if ((beforeLeft > 0 || afterLeft > 0) && /^[ +\-]/.test(line.text)) {
      line.kind = line.text[0] === '+' ? 'add' : line.text[0] === '-' ? 'remove' : 'context';
      if (line.kind !== 'add') beforeLeft--;
      if (line.kind !== 'remove') afterLeft--;
      hunk.push(line);
      continue;
    }
    if (line.text.startsWith('\\ No newline')) { line.kind = 'meta'; continue; }
    flush(); beforeLeft = afterLeft = 0;
    if (line.text.startsWith('diff --git ')) { beforePath = afterPath = path; }
    if (line.text.startsWith('--- ')) beforePath = headerPath(line.text.slice(4));
    if (line.text.startsWith('+++ ')) afterPath = headerPath(line.text.slice(4));
  }
  flush();
  return lines;
}
