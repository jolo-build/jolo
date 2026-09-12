import { fileReference } from './file-links.js';
// Constrained markdown → document model. No HTML is ever produced or
// interpreted; renderers map blocks to React DOM elements or terminal text. Streaming callers parse
// completed segments once and re-parse only the unfinished tail.

const MAX_BLOCK_CHARS = 64 * 1024;
const LIST_ITEM = /^\s*([-*+]|\d{1,9}[.)])\s+/;
const VISUALIZE_START = 'visualize';
const VISUALIZE_END = '';
const startsVisualization = line => line.trimStart().startsWith(VISUALIZE_START) || (line.trim().startsWith('') && VISUALIZE_START.startsWith(line.trim()));

/** Split text into block segments at blank lines, keeping fenced code intact. */
export function segment(text) {
  const lines = text.split("\n");
  const segments = [];
  let current = [];
  let inFence = null;
  let inVisualization = false;
  const flush = () => { if (current.length) { segments.push(current.join("\n")); current = []; } };
  for (const line of lines) {
    if (inVisualization) {
      current.push(line);
      if (line.includes(VISUALIZE_END)) { inVisualization = false; flush(); }
      continue;
    }
    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (inFence) {
      current.push(line);
      // A closing fence carries no info string, so a nested "```js" inside a "```md" block stays inside it.
      if (fence && fence[1][0] === inFence[0] && fence[1].length >= inFence.length && /^\s{0,3}(`{3,}|~{3,})\s*$/.test(line)) { inFence = null; flush(); }
      continue;
    }
    if (startsVisualization(line)) {
      flush(); current.push(line);
      if (line.includes(VISUALIZE_END)) flush();
      else inVisualization = true;
      continue;
    }
    // A fence indented under a list item belongs to that item only when the item opened a code span mid-line
    // and this fence closes it; a fence that starts on its own line is an ordinary code block (§5.1).
    const listActive = current.length > 0 && LIST_ITEM.test(current[0]);
    const spanOpen = () => (current.join("\n").match(/`{3,}|~{3,}/g)?.length ?? 0) % 2 === 1;
    if (fence && !(listActive && /^\s/.test(line) && spanOpen())) { flush(); inFence = fence[1]; current.push(line); continue; }
    if (line.trim() === "") { flush(); continue; }
    // Headings and rules stand alone; a list item starts a new segment only after non-list text.
    if (/^\s{0,3}#{1,6}\s/.test(line) || /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); segments.push(line); continue; }
    if (LIST_ITEM.test(line) && current.length && !LIST_ITEM.test(current[0])) flush();
    current.push(line);
  }
  flush();
  return { segments, openFence: Boolean(inFence), openVisualization: inVisualization };
}

export function parseInline(text) {
  const nodes = [];
  let buffer = "";
  const push = (node) => { if (buffer) { nodes.push({ type: "text", text: buffer }); buffer = ""; } if (node) nodes.push(node); };
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    let match;
    if ((match = rest.match(/^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/))) { push({ type: "code", text: match[2] }); i += match[0].length; continue; }
    const underscoreBoundary = i === 0 || !/[\p{L}\p{N}_]/u.test(text[i - 1]);
    if ((match = rest.match(/^\*\*([^*]+?)\*\*/)) || (underscoreBoundary && (match = rest.match(/^__([^_]+?)__(?![\p{L}\p{N}_])/u)))) { push({ type: "strong", children: parseInline(match[1]) }); i += match[0].length; continue; }
    if ((match = rest.match(/^\*([^*\n]+?)\*/)) || (underscoreBoundary && (match = rest.match(/^_([^_\n]+?)_(?![\p{L}\p{N}_])/u)))) { push({ type: "em", children: parseInline(match[1]) }); i += match[0].length; continue; }
    if ((match = rest.match(/^!?\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/))) {
      const href = safeHref(match[2]);
      if (rest.startsWith("!")) push({ type: "text", text: `[image: ${match[1] || href || "image"}]` });
      else if (href) push({ type: "link", href, children: parseInline(match[1] || href) });
      else if (fileReference(match[2])) push({ type: "link", href: fileReference(match[2]), local: true, children: parseInline(match[1] || match[2]) });
      else push({ type: "text", text: match[1] });
      i += match[0].length; continue;
    }
    if ((match = rest.match(/^<(https?:\/\/[^>\s]+)>/))) { push({ type: "link", href: match[1], children: [{ type: "text", text: match[1] }] }); i += match[0].length; continue; }
    if ((match = rest.match(/^https?:\/\/[^\s<>)]+/))) { push({ type: "link", href: match[0], children: [{ type: "text", text: match[0] }] }); i += match[0].length; continue; }
    if (rest.startsWith("\\") && rest.length > 1) { buffer += rest[1]; i += 2; continue; }
    buffer += text[i];
    i += 1;
  }
  push(null);
  return nodes;
}

function safeHref(raw) {
  try {
    const url = new URL(raw);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function parseTable(lines) {
  const rows = lines.map((line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim()));
  if (rows.length < 2 || !rows[1].every((cell) => /^:?-{3,}:?$/.test(cell))) return null;
  const align = rows[1].map((cell) => (cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : "left"));
  return { type: "table", align, header: rows[0].map(parseInline), rows: rows.slice(2).map((row) => row.map(parseInline)) };
}

function parseList(lines) {
  const items = [];
  let ordered = null;
  let start = 1;
  // An item's continuation lines are parsed together, so a code span the model wrapped across lines
  // (``` … ```) closes instead of showing literal backticks; newlines in prose render as spaces.
  let pending = null;
  // An opening fence's info string names the language; it is not part of the code the user reads.
  const dropInfoStrings = (raw) => {
    let open = false;
    return raw.map((text) => {
      const fence = text.match(/^(`{3,}|~{3,})\s*(\S*)\s*$/);
      if (!fence) return text;
      if (open) { open = false; return fence[1]; }
      open = true;
      return fence[1];
    });
  };
  const finish = () => { if (pending) pending.item.children = parseInline(dropInfoStrings(pending.text).join("\n")); pending = null; };
  for (const line of lines) {
    const match = line.match(/^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/);
    if (match) {
      finish();
      if (ordered === null) {
        ordered = /\d/.test(match[2]);
        // A list interrupted by a code block resumes at the number the author wrote, not at 1.
        // A list may legitimately start at zero, so only an unparseable marker falls back to one.
        const first = Number.parseInt(match[2], 10);
        if (ordered) start = Number.isFinite(first) ? Math.min(999_999_999, Math.max(0, first)) : 1;
      }
      const depth = Math.min(3, Math.floor(match[1].length / 2));
      const task = match[3].match(/^\[([ xX])\]\s+(.*)$/);
      const item = { depth, checked: task ? task[1] !== " " : null, children: [] };
      items.push(item);
      pending = { item, text: [task ? task[2] : match[3]] };
    } else if (pending) {
      pending.text.push(line.trim());
    }
  }
  finish();
  return { type: "list", ordered: Boolean(ordered), start, items };
}

/** Parse one segment into a block. */
export function parseBlock(text) {
  if (startsVisualization(text.split('\n', 1)[0])) {
    if (!text.includes(VISUALIZE_END) && text.length <= MAX_BLOCK_CHARS) return { type: 'visualization', status: 'pending' };
    try {
      const source = text.trim();
      if (source.length > MAX_BLOCK_CHARS || !source.startsWith(VISUALIZE_START) || !source.endsWith(VISUALIZE_END)) throw new Error();
      const value = JSON.parse(source.slice(VISUALIZE_START.length, -VISUALIZE_END.length));
      if (!value || typeof value.path !== 'string' || !value.path.trim() || value.path.length > 4096 || /[\x00-\x1f\x7f]/.test(value.path) || !/\.html?$/i.test(value.path)) throw new Error();
      return { type: 'visualization', status: 'ready', path: value.path, mode: value.mode === 'wide' ? 'wide' : 'inline', title: typeof value.title === 'string' ? value.title.slice(0, 250) : null };
    } catch { return { type: 'visualization', status: 'invalid' }; }
  }
  if (text.length > MAX_BLOCK_CHARS) text = `${text.slice(0, MAX_BLOCK_CHARS)}\n[block truncated]`;
  const lines = text.split("\n");
  const first = lines[0];
  let match;
  if ((match = first.match(/^( {0,3})(`{3,}|~{3,})\s*([^\s`]*)/))) {
    const body = lines.slice(1);
    if (body.length && body[body.length - 1].match(/^\s{0,3}(`{3,}|~{3,})\s*$/)) body.pop();
    // Fence indentation belongs to Markdown, not the source. Remove up to that
    // many leading spaces per line, preserving the code's own indentation.
    const indent = match[1].length;
    const code = indent ? body.map((line) => {
      let offset = 0;
      while (offset < indent && line[offset] === " ") offset++;
      return line.slice(offset);
    }) : body;
    return { type: "code", language: match[3] || null, text: code.join("\n") };
  }
  if ((match = first.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/))) return { type: "heading", level: match[1].length, children: parseInline(match[2]) };
  if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(first) && lines.length === 1) return { type: "rule" };
  if (lines.every((line) => /^\s{0,3}>/.test(line))) return { type: "quote", children: parseInline(lines.map((line) => line.replace(/^\s{0,3}>\s?/, "")).join(" ")) };
  if (lines.every((line) => line.trim().startsWith("|")) && lines.length >= 2) { const table = parseTable(lines); if (table) return table; }
  if (/^\s*([-*+]|\d{1,9}[.)])\s+/.test(first)) return parseList(lines);
  return { type: "paragraph", children: parseInline(lines.map((line) => line.trim()).join(" ")) };
}

/**
 * Parse a full document. Returns blocks plus whether the last block is still open (streaming).
 * `cache` (a Map) lets streaming callers reuse parsed blocks for unchanged segments.
 * @param {string} text
 * @param {{ cache?: Map<string, any> }} [options]
 */
export function parseDocument(text, { cache } = {}) {
  const { segments, openFence, openVisualization } = segment(text);
  const blocks = segments.map((seg, index) => {
    const last = index === segments.length - 1;
    if (cache && !last && cache.has(seg)) return cache.get(seg);
    const block = parseBlock(seg);
    if (cache && !last) cache.set(seg, block);
    return block;
  });
  return { blocks, open: openFence || openVisualization || (segments.length > 0 && !text.endsWith("\n\n")) };
}

/** Plain-text projection for terminals and previews: no ANSI, no HTML. */
export function renderPlain(blocks, { width = 80 } = {}) {
  const inline = (nodes) => nodes.map((n) => (n.type === "text" ? n.text : n.type === "code" ? `\`${n.text}\`` : n.type === "link" ? `${inline(n.children)} <${n.href}>` : inline(n.children))).join("");
  const lines = [];
  for (const block of blocks) {
    switch (block.type) {
      case "heading": lines.push(`${"#".repeat(block.level)} ${inline(block.children)}`, ""); break;
      case "paragraph": lines.push(...wrap(inline(block.children), width), ""); break;
      case 'visualization': lines.push(...wrap(block.status === 'ready' ? `Visualization: ${block.title ? `${block.title} — ` : ''}${block.path}` : block.status === 'pending' ? 'Preparing visualization…' : 'Visualization reference is invalid.', width), ''); break;
      case "code": lines.push(...block.text.split("\n").map((l) => `    ${l}`), ""); break;
      case "quote": lines.push(...wrap(inline(block.children), width - 2).map((l) => `> ${l}`), ""); break;
      case "rule": lines.push("-".repeat(Math.min(width, 40)), ""); break;
      case "list": block.items.forEach((item, i) => lines.push(`${"  ".repeat(item.depth)}${block.ordered ? `${(block.start ?? 1) + i}.` : "•"} ${item.checked === null ? "" : item.checked ? "[x] " : "[ ] "}${inline(item.children)}`)); lines.push(""); break;
      case "table": lines.push(block.header.map(inline).join(" | "), ...block.rows.map((row) => row.map(inline).join(" | ")), ""); break;
      default: break;
    }
  }
  return lines.join("\n").replace(/\n+$/, "");
}

export function wrap(text, width) {
  if (width <= 0) return [text];
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    if (line && line.length + 1 + word.length > width) { lines.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}
