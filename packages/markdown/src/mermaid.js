import { sanitizeText } from "./text.js";
// Mermaid diagram source → a small model.
//
// No drawing happens here: the terminal lays this out as boxes and lines, and a browser could draw the same
// model another way. Only the diagram types Jolo can actually draw are parsed — flowcharts, state diagrams
// (which are flowcharts with different words) and sequence diagrams. Anything else returns null so the
// caller can show the source it was given instead of a wrong picture.
//
// Mermaid is a large language and this is deliberately a subset: the shapes, links and statements that
// appear in everyday diagrams. Whatever is not understood is skipped rather than guessed at.

const MAX_SOURCE_CHARS = 32 * 1024;
const MAX_NODES = 120;
const MAX_EDGES = 240;
const MAX_EVENTS = 400;
const MAX_LABEL_CHARS = 200;

const SHAPES = [
  // Longest delimiters first: "[[x]]" must not be read as "[x]" with stray brackets.
  { open: "[[", close: "]]", shape: "subroutine" },
  { open: "[(", close: ")]", shape: "cylinder" },
  { open: "[/", close: "/]", shape: "parallelogram" },
  { open: "[\\", close: "\\]", shape: "parallelogram" },
  { open: "[/", close: "\\]", shape: "trapezoid" },
  { open: "[\\", close: "/]", shape: "trapezoid" },
  { open: "((", close: "))", shape: "circle" },
  { open: "([", close: "])", shape: "stadium" },
  { open: "{{", close: "}}", shape: "hexagon" },
  { open: "[", close: "]", shape: "rect" },
  { open: "(", close: ")", shape: "round" },
  { open: "{", close: "}", shape: "rhombus" },
  { open: ">", close: "]", shape: "asymmetric" },
];

/** A statement ends at a semicolon, but only one that is not inside somebody's label. */
export function splitStatements(line) {
  const out = [];
  let depth = 0;
  let quote = null;
  let current = "";
  for (const char of line) {
    if (quote) { current += char; if (char === quote) quote = null; continue; }
    if (char === '"' || char === "'") { quote = char; current += char; continue; }
    if (char === "[" || char === "(" || char === "{") depth += 1;
    else if (char === "]" || char === ")" || char === "}") depth = Math.max(0, depth - 1);
    else if (char === ";" && depth === 0) { out.push(current); current = ""; continue; }
    current += char;
  }
  out.push(current);
  return out;
}

/** A label as it should read: quotes stripped, breaks honoured, control characters and markup removed. */
export function cleanLabel(text) {
  return sanitizeText(text, { tab: "" })
    .trim()
    .replace(/^"([\s\S]*)"$/, "$1")
    .replace(/^'([\s\S]*)'$/, "$1")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/\\n/g, "\n") // mermaid treats a written-out \n in a label as a line break
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .split("\n")
    .map((part) => part.trim().replace(/^"(.*)"$/s, "$1").replace(/^'(.*)'$/s, "$1"))
    .join("\n")
    .trim()
    .slice(0, MAX_LABEL_CHARS);
}

/**
 * Hide every bracketed label, quoted string and |edge label| behind a placeholder, so link operators can be
 * found without tripping over an arrow that is really part of someone's text.
 */
function mask(line) {
  const groups = [];
  let out = "";
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"' || char === "'") {
      const end = line.indexOf(char, i + 1);
      const raw = end === -1 ? line.slice(i) : line.slice(i, end + 1);
      out += `\x00${groups.push(raw) - 1}\x00`;
      i += raw.length - 1;
      continue;
    }
    if (char === "|") {
      const end = line.indexOf("|", i + 1);
      if (end === -1) { out += char; continue; }
      out += `\x00${groups.push(line.slice(i, end + 1)) - 1}\x00`;
      i = end;
      continue;
    }
    // ">text]" is a node shape, but ">" also ends an arrow: it opens a label only after a plain name.
    if (char === ">" && !/[-=.<>\s]$/.test(out) && out && line.indexOf("]", i + 1) !== -1) {
      const end = line.indexOf("]", i + 1);
      out += `\x00${groups.push(line.slice(i, end + 1)) - 1}\x00`;
      i = end;
      continue;
    }
    if (char === "[" || char === "(" || char === "{") {
      const stack = [char];
      let end = -1;
      for (let j = i + 1; j < line.length; j += 1) {
        const inner = line[j];
        if (inner === '"' || inner === "'") { const close = line.indexOf(inner, j + 1); if (close === -1) break; j = close; continue; }
        if (inner === "[" || inner === "(" || inner === "{") stack.push(inner);
        else if (inner === "]" || inner === ")" || inner === "}") { stack.pop(); if (!stack.length) { end = j; break; } }
      }
      if (end === -1) { out += char; continue; }
      out += `\x00${groups.push(line.slice(i, end + 1)) - 1}\x00`;
      i = end;
      continue;
    }
    out += char;
  }
  return { text: out, groups };
}

const unmask = (text, groups) => text.replace(/\x00(\d+)\x00/g, (_all, index) => groups[Number(index)] ?? "");

/** "A[Start]" → the node it declares. A bare id keeps whatever shape and label it was first given. */
function nodeSpec(segment, groups) {
  const trimmed = segment.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^(.*?)\x00(\d+)\x00$/s);
  if (!match) {
    const id = trimmed.replace(/\x00(\d+)\x00/g, (_all, index) => cleanLabel(groups[Number(index)]));
    return id ? { id, label: null, shape: null } : null;
  }
  const id = match[1].trim();
  const raw = groups[Number(match[2])] ?? "";
  for (const { open, close, shape } of SHAPES) {
    if (raw.startsWith(open) && raw.endsWith(close) && raw.length >= open.length + close.length) {
      const label = cleanLabel(unmask(raw.slice(open.length, raw.length - close.length), groups));
      return { id: id || label, label: label || id, shape };
    }
  }
  return { id: id || cleanLabel(raw), label: cleanLabel(raw), shape: "rect" };
}

/** A link operator: how it is drawn, and which end carries the arrow. */
function linkFrom(token) {
  const style = token.includes(".") ? "dotted" : token.includes("=") ? "thick" : "solid";
  const head = token.at(-1);
  const arrow = head === ">" ? "arrow" : head === "o" ? "circle" : head === "x" ? "cross" : "none";
  return { style, arrow, both: token.startsWith("<") };
}

const IGNORED_FLOW = /^(?:style|classDef|class|click|linkStyle|linkstyle|accTitle|accDescr|graph|flowchart)\b/i;
const LINK = /(<?[-=.]{2,}[>ox]?)(?:\x00(\d+)\x00)?/g;
const HAS_LINK = /[-=.]{2,}[>ox]?/;

/**
 * "A -- yes --> B" is the same link as "A -->|yes| B". This runs on masked text, so a label that merely
 * contains dashes cannot be mistaken for a link, and the folded label joins the other masked groups.
 */
const foldInlineLabels = (text, groups) => text.replace(/(?<=^|\s)([-=.]{2,})\s+([^\n|]+?)\s+([-=.]{2,}[>ox]?)(?=\s|$)/g,
  (_all, _lead, label, tail) => `${tail}\x00${groups.push(`|${label.trim()}|`) - 1}\x00`);

function parseFlow(lines, { direction, stateSyntax }) {
  const nodes = new Map();
  const edges = [];
  const groups = [];
  const stack = [];
  let points = 0;
  const define = (spec) => {
    if (!spec) return null;
    const existing = nodes.get(spec.id);
    if (existing) {
      if (spec.label && !existing.declared) { existing.label = spec.label; existing.shape = spec.shape ?? existing.shape; existing.declared = true; }
      return existing;
    }
    if (nodes.size >= MAX_NODES) return null;
    const node = { id: spec.id, label: spec.label ?? spec.id, shape: spec.shape ?? "rect", declared: Boolean(spec.label) };
    nodes.set(node.id, node);
    if (stack.length) stack.at(-1).nodeIds.push(node.id);
    return node;
  };
  /** A state diagram's [*] is a start or an end depending on which side of the arrow it sits. */
  const point = (side) => {
    const id = side === "from" ? "\x00start" : `\x00end${points}`;
    if (side === "to") points += 1;
    const existing = nodes.get(id);
    if (existing) return existing;
    if (nodes.size >= MAX_NODES) return null;
    const node = { id, label: "", shape: "point", declared: true };
    nodes.set(id, node);
    if (stack.length) stack.at(-1).nodeIds.push(id);
    return node;
  };

  for (const raw of lines) {
    const statement = raw.trim();
    if (!statement) continue;
    if (/^direction\s+(TD|TB|BT|LR|RL)\b/i.test(statement)) { direction = statement.split(/\s+/)[1].toUpperCase(); continue; }
    if (/^end\b/i.test(statement)) { const group = stack.pop(); if (group && group.nodeIds.length) groups.push(group); continue; }
    const subgraph = statement.match(/^subgraph\s+(.*)$/i) ?? (stateSyntax ? statement.match(/^state\s+(.+?)\s*\{$/i) : null);
    if (subgraph) {
      const masked = mask(subgraph[1]);
      const spec = nodeSpec(masked.text.replace(/\s*\{$/, ""), masked.groups);
      stack.push({ label: cleanLabel(spec?.label ?? spec?.id ?? ""), nodeIds: [] });
      continue;
    }
    if (IGNORED_FLOW.test(statement) || /^note\b/i.test(statement)) continue;
    if (stateSyntax) {
      // "state "Long name" as id" only renames; the arrows below carry the diagram.
      const named = statement.match(/^state\s+(".*?"|'.*?')\s+as\s+(\S+)\s*$/i);
      if (named) { const node = define({ id: named[2], label: cleanLabel(named[1]), shape: "round" }); if (node) node.declared = true; continue; }
      if (/^state\s+\S+\s*(<<\w+>>)?\s*$/i.test(statement)) { define({ id: statement.split(/\s+/)[1], label: null, shape: "round" }); continue; }
    }

    const masked = mask(statement);
    // A state transition carries its label after a colon rather than between pipes.
    let trailing = null;
    let body = foldInlineLabels(masked.text, masked.groups);
    if (stateSyntax) {
      const colon = body.match(/^(.*?):\s*([^\n]*)$/s);
      if (colon && HAS_LINK.test(colon[1])) { body = colon[1]; trailing = cleanLabel(unmask(colon[2], masked.groups)); }
    }

    const parts = [];
    const links = [];
    let index = 0;
    LINK.lastIndex = 0;
    for (let match = LINK.exec(body); match; match = LINK.exec(body)) {
      parts.push(body.slice(index, match.index));
      const label = match[2] === undefined ? null : cleanLabel(unmask((masked.groups[Number(match[2])] ?? "").replace(/^\||\|$/g, ""), masked.groups));
      links.push({ ...linkFrom(match[1]), label: label ?? trailing });
      index = match.index + match[0].length;
    }
    parts.push(body.slice(index));
    if (!links.length) { for (const piece of parts[0].split("&")) define(nodeSpec(piece, masked.groups)); continue; }

    // "A & B --> C" links every node on the left to every node on the right.
    const sides = parts.map((part) => part.split("&").map((piece) => {
      const text = unmask(piece, masked.groups).trim();
      if (stateSyntax && text === "[*]") return { point: true };
      return nodeSpec(piece, masked.groups);
    }).filter(Boolean));
    for (let i = 0; i < links.length; i += 1) {
      const from = sides[i].map((spec) => (spec.point ? point("from") : define(spec))).filter(Boolean);
      const to = sides[i + 1].map((spec) => (spec.point ? point("to") : define(spec))).filter(Boolean);
      for (const source of from) {
        for (const target of to) {
          if (edges.length >= MAX_EDGES) break;
          edges.push({ from: source.id, to: target.id, label: links[i].label ?? null, style: links[i].style, arrow: links[i].arrow, both: links[i].both });
        }
      }
    }
  }
  for (const group of stack) if (group.nodeIds.length) groups.push(group);
  if (!nodes.size) return null;
  return {
    type: "flow",
    direction,
    nodes: [...nodes.values()].map(({ id, label, shape }) => ({ id, label, shape })),
    edges,
    groups,
  };
}

const SEQUENCE_ARROW = /^(.+?)\s*(<<-->>|<<->>|--?>>|--?[>x)])\s*([^:]+?)\s*:\s*([\s\S]*)$/;
const SEQUENCE_BLOCK = /^(loop|alt|opt|par|critical|break|rect|box)\b\s*(.*)$/i;
const SEQUENCE_BRANCH = /^(else|and|option)\b\s*(.*)$/i;

function parseSequence(lines) {
  const participants = new Map();
  const events = [];
  const declare = (id, label = null) => {
    const key = cleanLabel(id);
    if (!key) return null;
    const existing = participants.get(key);
    if (existing) { if (label) existing.label = label; return existing; }
    if (participants.size >= MAX_NODES) return null;
    const entry = { id: key, label: label ?? key };
    participants.set(key, entry);
    return entry;
  };
  for (const raw of lines) {
    const statement = raw.trim();
    if (!statement || events.length >= MAX_EVENTS) continue;
    if (/^(autonumber|activate|deactivate|accTitle|accDescr|box|links?|properties|destroy)\b/i.test(statement)) {
      if (/^(activate|deactivate|destroy)\b/i.test(statement)) declare(statement.split(/\s+/).slice(1).join(" "));
      continue;
    }
    const person = statement.match(/^(participant|actor)\s+(.+)$/i);
    if (person) {
      const aliased = person[2].match(/^(.+?)\s+as\s+(.+)$/i);
      if (aliased) declare(aliased[1], cleanLabel(aliased[2]));
      else declare(person[2]);
      continue;
    }
    const note = statement.match(/^note\s+(over|left of|right of)\s+([^:]+):\s*([\s\S]*)$/i);
    if (note) {
      const targets = note[2].split(",").map((name) => declare(name.trim())).filter(Boolean).map((entry) => entry.id);
      if (targets.length) events.push({ kind: "note", placement: note[1].toLowerCase().replace(/ of$/, ""), targets, text: cleanLabel(note[3]) });
      continue;
    }
    if (/^end\b/i.test(statement)) { events.push({ kind: "end" }); continue; }
    const branch = statement.match(SEQUENCE_BRANCH);
    if (branch) { events.push({ kind: "branch", tag: branch[1].toLowerCase(), label: cleanLabel(branch[2]) }); continue; }
    const block = statement.match(SEQUENCE_BLOCK);
    if (block) { events.push({ kind: "block", tag: block[1].toLowerCase(), label: cleanLabel(block[2]) }); continue; }
    const message = statement.match(SEQUENCE_ARROW);
    if (message) {
      const from = declare(message[1]);
      const to = declare(message[3]);
      if (!from || !to) continue;
      const token = message[2];
      events.push({
        kind: "message",
        from: from.id,
        to: to.id,
        label: cleanLabel(message[4]),
        style: token.includes("--") ? "dotted" : "solid",
        arrow: token.endsWith(">>") ? "filled" : token.endsWith("x") ? "cross" : token.endsWith(")") ? "async" : "open",
        both: token.startsWith("<<"),
      });
    }
  }
  if (!participants.size) return null;
  return { type: "sequence", participants: [...participants.values()], events };
}

/**
 * @param {string} source the body of a ```mermaid fence
 * @returns {{ type: "flow" | "sequence" } & Record<string, any> | null} null when this is not a diagram Jolo draws
 */
export function parseMermaid(source) {
  const text = String(source ?? "").slice(0, MAX_SOURCE_CHARS);
  const lines = text
    .split("\n")
    .filter((line) => !/^\s*%%\{[\s\S]*\}%%\s*$/.test(line))
    .map((line) => line.replace(/(^|\s)%%.*$/, "$1"))
    .flatMap((line) => splitStatements(line))
    .filter((line) => line.trim());
  if (!lines.length) return null;
  const header = lines[0].trim();
  const flow = header.match(/^(?:flowchart|graph)\s*(TD|TB|BT|LR|RL)?\b(.*)$/i);
  if (flow) {
    const rest = flow[2].trim();
    return parseFlow([...(rest ? [rest] : []), ...lines.slice(1)], { direction: (flow[1] ?? "TD").toUpperCase(), stateSyntax: false });
  }
  if (/^stateDiagram(-v2)?\b/i.test(header)) return parseFlow(lines.slice(1), { direction: "TD", stateSyntax: true });
  if (/^sequenceDiagram\b/i.test(header)) return parseSequence(lines.slice(1));
  return null; // classDiagram, erDiagram, gantt, pie, journey and the rest: shown as source instead
}
