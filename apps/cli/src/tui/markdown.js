import { sanitizeText } from "@jolo/markdown/text";
// Terminal rendering of the shared markdown model: styled spans per line,
// width-aware wrapping, bounded output, and no control characters from model text reaching the terminal.
import { parseDocument } from "@jolo/markdown";
import { codeTokens } from "@jolo/markdown/tokens";
import { mermaidLines } from "./mermaid.js";

export const MAX_LINES = 400;
export const MAX_CODE_LINES = 160;
export const MAX_TABLE_ROWS = 60;
const MARKDOWN_LANGUAGES = new Set(["md", "markdown", "mdx"]);
const MERMAID_LANGUAGES = new Set(["mermaid", "mmd"]);
const MAX_EMBED_DEPTH = 2;

/**
 * How a run of text is drawn. Ink takes these straight as `<Text>` props, so every member is
 * optional and leaving one out means "inherit from the surrounding text".
 * @typedef {{ color?: string, bold?: boolean, dim?: boolean, italic?: boolean, underline?: boolean, code?: boolean }} SpanStyle
 */

/** @type {Array<[string[], SpanStyle]>} */
const TOKEN_STYLES = [
  [["comment", "prolog", "doctype", "cdata"], { dim: true }],
  [["keyword", "atrule", "important"], { color: "magenta" }],
  [["string", "attr-value", "char", "inserted", "code-snippet"], { color: "green" }],
  [["function", "class-name", "tag", "url"], { color: "blue" }],
  [["number", "boolean", "constant", "symbol"], { color: "yellow" }],
  [["property", "attr-name", "builtin", "variable"], { color: "cyan" }],
  [["deleted"], { color: "red" }],
  [["title", "bold"], { bold: true }],
  [["italic"], { italic: true }],
  [["operator", "punctuation"], { dim: true }],
];

/** Model and repository text must never carry terminal control sequences (§4.4). Tabs become two spaces. */
// eslint-disable-next-line no-control-regex
export const clean = sanitizeText;

export const line = (text, style = {}) => ({ spans: [{ text: clean(text) || " ", ...style }] });
export const plainTextLines = (text, width, style = {}) => clean(text).split("\n").flatMap((row) => wrapSegments([{ text: row, ...style }], width));
const blank = () => line(" ");
const styleFor = (kinds) => { for (const [names, style] of TOKEN_STYLES) if (kinds.some((kind) => names.includes(kind))) return style; return {}; };

/** Inline nodes → styled segments (no wrapping yet). */
function segments(nodes, style = {}) {
  const out = [];
  for (const node of nodes) {
    switch (node.type) {
      case 'image': out.push({ text: `[image: ${clean(node.alt)} — open in Jolo desktop]`, dim: true }); break;
      case "text": out.push({ text: clean(node.text), ...style }); break;
      case "code": out.push({ text: clean(node.text), color: "cyan", ...style, code: true }); break;
      case "strong": out.push(...segments(node.children, { ...style, bold: true })); break;
      case "em": out.push(...segments(node.children, { ...style, italic: true })); break;
      case "link": out.push(...segments(node.children, { ...style, underline: true }), { text: ` <${clean(node.href)}>`, dim: true }); break;
      default: break;
    }
  }
  return out;
}

/** Greedy word wrap that keeps each word's style; overlong words are split hard. */
function wrapSegments(list, width, { indent = "", firstIndent = indent } = {}) {
  const words = [];
  for (const segment of list) {
    const style = { ...segment }; delete style.text; delete style.code;
    // A code span the model wrapped across lines keeps every break; prose reflows to the width.
    if (segment.code && segment.text.includes("\n")) {
      for (const text of segment.text.split("\n")) {
        if (words.length && !words.at(-1).br) words.push({ br: true });
        if (text) words.push({ text, style });
      }
      continue;
    }
    for (const part of segment.text.split(/(\s+)/)) {
      if (!part) continue;
      if (/^\s+$/.test(part)) { if (words.length && !words.at(-1).space && !words.at(-1).br) words.push({ space: true }); continue; }
      words.push({ text: part, style });
    }
  }
  while (words.length && (words.at(-1).space || words.at(-1).br)) words.pop();
  const lines = [];
  let current = [];
  let length = 0;
  let pendingSpace = false;
  const usable = (first) => Math.max(8, width - (first ? firstIndent : indent).length);
  const flush = () => { const prefix = lines.length === 0 ? firstIndent : indent; lines.push({ spans: [...(prefix ? [{ text: prefix, dim: true }] : []), ...(current.length ? current : [{ text: " " }])] }); current = []; length = 0; pendingSpace = false; };
  for (const word of words) {
    if (word.br) { flush(); continue; }
    if (word.space) { pendingSpace = current.length > 0; continue; }
    let text = word.text;
    while (text.length) {
      const room = usable(lines.length === 0);
      const gap = pendingSpace ? 1 : 0;
      if (current.length && length + gap + text.length > room) { flush(); continue; }
      const take = current.length ? text.slice(0, room - length - gap) : text.slice(0, room);
      if (pendingSpace) { current.push({ text: " " }); length += 1; pendingSpace = false; }
      current.push({ text: take, ...word.style });
      length += take.length;
      text = text.slice(take.length);
      if (text.length) flush();
    }
  }
  if (current.length || lines.length === 0) flush();
  return lines;
}

/** Code block → one styled line per source line; long lines are cut, never wrapped, so columns stay aligned. */
function codeLines(block, width) {
  const lines = [];
  const source = clean(block.text);
  const limit = Math.max(8, width - 2);
  const current = () => { if (!lines.length) lines.push({ spans: [{ text: "  ", dim: true }], length: 0 }); return lines.at(-1); };
  const push = (text, style) => {
    let remaining = text;
    for (;;) {
      const index = remaining.indexOf("\n");
      const piece = index === -1 ? remaining : remaining.slice(0, index);
      if (piece) {
        const target = current();
        if (target.length < limit) {
          const room = limit - target.length;
          if (piece.length <= room) { target.spans.push({ text: piece, ...style }); target.length += piece.length; }
          else { target.spans.push({ text: piece.slice(0, room - 1), ...style }, { text: "…", dim: true }); target.length = limit; }
        }
      }
      if (index === -1) break;
      lines.push({ spans: [{ text: "  ", dim: true }], length: 0 });
      remaining = remaining.slice(index + 1);
    }
  };
  const walk = (nodes, style) => { for (const node of nodes) { if (typeof node === "string") push(node, style); else walk(node.children, { ...style, ...styleFor(node.kinds) }); } };
  walk(codeTokens(source, block.language), {});
  if (lines.length && lines.at(-1).length === 0 && source.endsWith("\n")) lines.pop();
  const out = lines.slice(0, MAX_CODE_LINES).map(({ spans }) => ({ spans }));
  if (lines.length > MAX_CODE_LINES) out.push(line(`  … ${lines.length - MAX_CODE_LINES} more lines`, { dim: true }));
  return [line(`  ${block.language ?? "code"}`, { dim: true }), ...out];
}

const cellText = (nodes) => segments(nodes).map((segment) => segment.text).join("").replace(/\s+/g, " ").trim();
const clip = (text, width) => (text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text);
const pad = (text, width, align) => { const gap = width - text.length; if (gap <= 0) return text; if (align === "right") return " ".repeat(gap) + text; if (align === "center") return " ".repeat(Math.floor(gap / 2)) + text + " ".repeat(gap - Math.floor(gap / 2)); return text + " ".repeat(gap); };

function tableLines(block, width) {
  const rows = [block.header, ...block.rows.slice(0, MAX_TABLE_ROWS)].map((row) => row.map(cellText));
  const columns = Math.max(...rows.map((row) => row.length));
  const natural = Array.from({ length: columns }, (_, i) => Math.max(1, ...rows.map((row) => (row[i] ?? "").length)));
  const available = Math.max(columns * 3, width - 3 * (columns - 1));
  let widths = natural.slice();
  if (widths.reduce((a, b) => a + b, 0) > available) {
    const cap = Math.max(3, Math.floor(available / columns));
    widths = natural.map((w) => Math.min(w, cap));
    let spare = available - widths.reduce((a, b) => a + b, 0);
    for (let i = 0; spare > 0 && i < columns; i += 1) { const grow = Math.min(spare, natural[i] - widths[i]); widths[i] += grow; spare -= grow; }
  }
  const render = (row, style) => ({ spans: row.length ? row.flatMap((cell, i) => [...(i ? [{ text: "   ", dim: true }] : []), { text: pad(clip(cell, widths[i]), widths[i], block.align[i]), ...style }]) : [{ text: " " }] });
  const lines = [render(rows[0].concat(Array(columns - rows[0].length).fill("")), { bold: true }), { spans: widths.flatMap((w, i) => [...(i ? [{ text: "   ", dim: true }] : []), { text: "─".repeat(w), dim: true }]) }];
  for (const row of rows.slice(1)) lines.push(render(row.concat(Array(columns - row.length).fill("")), {}));
  if (block.rows.length > MAX_TABLE_ROWS) lines.push(line(`… ${block.rows.length - MAX_TABLE_ROWS} more rows`, { dim: true }));
  return lines;
}

/**
 * @param {string} text markdown from the model
 * @param {{ width?: number, depth?: number }} [options] `depth` counts the markdown fences this
 *   render is already nested inside; only the recursive call below passes it.
 * @returns {{ lines: Array<{ spans: Array<{ text: string, color?: string, bold?: boolean, dim?: boolean, italic?: boolean, underline?: boolean }> }>, truncated: boolean }}
 */
export function renderMarkdown(text, { width = 80, depth = 0 } = {}) {
  const w = Math.max(20, width);
  const { blocks } = parseDocument(String(text ?? ""));
  const lines = [];
  for (const block of blocks) {
    if (lines.length > MAX_LINES) break;
    switch (block.type) {
      case "heading": {
        const style = block.level <= 2 ? { bold: true, underline: block.level === 1 } : { bold: true };
        lines.push(...wrapSegments(segments(block.children, style), w), blank());
        break;
      }
      case "paragraph": lines.push(...wrapSegments(segments(block.children), w), blank()); break;
      case 'visualization': lines.push(...wrapSegments([{ text: block.status === 'ready' ? `Visualization: ${block.title ? `${block.title} — ` : ''}${block.path}` : block.status === 'pending' ? 'Preparing visualization…' : 'Visualization reference is invalid.', dim: true }], w), blank()); break;
      case "code": {
        // A diagram Jolo can draw is drawn; one it cannot read stays the code it was written as.
        const diagram = block.language && MERMAID_LANGUAGES.has(block.language.toLowerCase()) ? mermaidLines(block.text, w - 2) : null;
        if (diagram) {
          lines.push(line(`  ${block.language}${diagram.compact ? " · too wide to draw here" : ""}`, { dim: true }));
          lines.push(...diagram.lines.map((entry) => ({ spans: [{ text: "  " }, ...entry.spans] })), blank());
          break;
        }
        if (block.language && MARKDOWN_LANGUAGES.has(block.language.toLowerCase()) && depth < MAX_EMBED_DEPTH) {
          // A markdown fence is a document: render it as one, set off by a gutter, with its own bounds.
          const inner = renderMarkdown(block.text, { width: w - 2, depth: depth + 1 });
          lines.push(line(`  ${block.language}`, { dim: true }), ...inner.lines.map((entry) => ({ spans: [{ text: "│ ", dim: true }, ...entry.spans] })), blank());
          break;
        }
        lines.push(...codeLines(block, w), blank());
        break;
      }
      case "quote": lines.push(...wrapSegments(segments(block.children, { italic: true }), w, { indent: "│ " }), blank()); break;
      case "rule": lines.push(line("─".repeat(Math.min(w, 40)), { dim: true }), blank()); break;
      case "list": {
        block.items.forEach((item, index) => {
          const bullet = block.ordered ? `${(block.start ?? 1) + index}. ` : "• ";
          const check = item.checked === null ? "" : item.checked ? "☑ " : "☐ ";
          const first = `${"  ".repeat(item.depth)}${bullet}${check}`;
          lines.push(...wrapSegments(segments(item.children), w, { firstIndent: first, indent: " ".repeat(first.length) }));
        });
        lines.push(blank());
        break;
      }
      case "table": lines.push(...tableLines(block, w), blank()); break;
      default: break;
    }
  }
  while (lines.length && lines.at(-1).spans.length === 1 && lines.at(-1).spans[0].text === " ") lines.pop();
  const truncated = lines.length > MAX_LINES;
  const out = truncated ? lines.slice(0, MAX_LINES) : lines;
  if (truncated) out.push(line(`… ${lines.length - MAX_LINES} more lines`, { dim: true }));
  return { lines: out, truncated };
}
