import { sanitizeText } from "@jolo/markdown/text";
// Mermaid diagrams drawn for a terminal.
//
// The shared parser turns the fence into a model and the shared layout says where everything goes, measured
// here in character cells. What is left is the drawing: a grid whose line cells remember which way they run,
// so crossings and corners come out as the right box-drawing character without anyone working them out.
//
// When a diagram cannot fit the terminal's width it falls back to a compact list of its links, rather than a
// picture the reader would have to scroll sideways to follow.
import { parseMermaid } from "@jolo/markdown/mermaid";
import { layoutFlowchart, layoutSequence, pointLabel } from "@jolo/markdown/mermaid-layout";

export const MAX_DIAGRAM_LINES = 240;
const LABEL_WIDTHS = [26, 18, 12]; // tried in turn until the diagram fits
const MIN_WIDTH = 24;
const MAX_LABEL_LINES = 4;

const U = 1, D = 2, L = 4, R = 8;
const JUNCTIONS = {
  solid: ["", "│", "│", "│", "─", "┘", "┐", "┤", "─", "└", "┌", "├", "─", "┴", "┬", "┼"],
  dotted: ["", "╎", "╎", "╎", "╌", "┘", "┐", "┤", "╌", "└", "┌", "├", "╌", "┴", "┬", "┼"],
  thick: ["", "┃", "┃", "┃", "━", "┛", "┓", "┫", "━", "┗", "┏", "┣", "━", "┻", "┳", "╋"],
};
const CORNERS = {
  square: ["┌", "┐", "└", "┘"],
  round: ["╭", "╮", "╰", "╯"],
  diamond: ["╱", "╲", "╲", "╱"],
};
const SHAPE_CORNERS = {
  rect: "square", subroutine: "square", parallelogram: "square", trapezoid: "square", asymmetric: "square",
  round: "round", stadium: "round", circle: "round", cylinder: "round", point: "round",
  rhombus: "diamond", hexagon: "diamond",
};
const ARROWS = { up: "▲", down: "▼", left: "◀", right: "▶" };

// eslint-disable-next-line no-control-regex
const safe = sanitizeText;
const widthOf = (lines) => Math.max(0, ...lines.map((text) => text.length));

/** Break a label onto as few lines as it needs, honouring the breaks the author asked for. */
function wrapLabel(text, max) {
  const out = [];
  for (const paragraph of safe(text).split("\n")) {
    if (!paragraph) { out.push(""); continue; }
    let current = "";
    for (const word of paragraph.split(/\s+/)) {
      const piece = word.length > max ? word.slice(0, max - 1) + "…" : word;
      if (!current) current = piece;
      else if (current.length + 1 + piece.length <= max) current += ` ${piece}`;
      else { out.push(current); current = piece; }
    }
    if (current) out.push(current);
  }
  const lines = out.length ? out : [""];
  if (lines.length <= MAX_LABEL_LINES) return lines;
  return [...lines.slice(0, MAX_LABEL_LINES - 1), `${lines[MAX_LABEL_LINES - 1].slice(0, Math.max(1, max - 1))}…`];
}

/** A character grid: literal characters win over lines, and lines merge into the junction they form. */
function createGrid() {
  const cells = new Map();
  const key = (x, y) => `${y},${x}`;
  let maxX = -1;
  let maxY = -1;
  const touch = (x, y) => { if (x > maxX) maxX = x; if (y > maxY) maxY = y; };
  const cellAt = (x, y) => {
    const existing = cells.get(key(x, y));
    if (existing) return existing;
    const made = { char: null, style: null, mask: 0, line: "solid" };
    cells.set(key(x, y), made);
    return made;
  };
  return {
    put(x, y, char, style = null, soft = false) {
      if (x < 0 || y < 0 || !char) return;
      const existing = cells.get(key(x, y));
      if (soft && char === " " && existing && (existing.char || existing.mask)) return; // padding never rubs a line out
      const cell = existing ?? cellAt(x, y);
      cell.char = char;
      cell.style = style;
      touch(x, y);
    },
    /** Write text; with `soft`, the spaces around it fill only what is still blank. */
    text(x, y, value, style = null, soft = false) { [...safe(value)].forEach((char, index) => this.put(x + index, y, char, style, soft)); },
    /** A label: the words always land, the space around them only where nothing was drawn. */
    label(x, y, value, style = null) {
      const text = safe(value);
      this.put(x, y, " ", style, true);
      this.text(x + 1, y, text, style);
      this.put(x + 1 + text.length, y, " ", style, true);
    },
    /** Add a run of line, remembering the directions it leaves the cell by. */
    run(x1, y1, x2, y2, style = "solid") {
      if (y1 === y2) {
        const [from, to] = x1 <= x2 ? [x1, x2] : [x2, x1];
        for (let x = from; x <= to; x += 1) {
          const cell = cellAt(x, y1);
          cell.mask |= (x > from ? L : 0) | (x < to ? R : 0);
          if (cell.line === "solid") cell.line = style;
          touch(x, y1);
        }
        return;
      }
      const [from, to] = y1 <= y2 ? [y1, y2] : [y2, y1];
      for (let y = from; y <= to; y += 1) {
        const cell = cellAt(x1, y);
        cell.mask |= (y > from ? U : 0) | (y < to ? D : 0);
        if (cell.line === "solid") cell.line = style;
        touch(x1, y);
      }
    },
    line(points, style) { for (let i = 1; i < points.length; i += 1) this.run(points[i - 1].x, points[i - 1].y, points[i].x, points[i].y, style); },
    box(x, y, w, h, shape, style) {
      const [tl, tr, bl, br] = CORNERS[SHAPE_CORNERS[shape] ?? "square"];
      for (let row = 1; row < h - 1; row += 1) for (let column = 1; column < w - 1; column += 1) this.put(x + column, y + row, " ", style);
      const top = h === 1 ? null : y;
      this.put(x, y, top === null ? "│" : tl, style);
      this.put(x + w - 1, y, top === null ? "│" : tr, style);
      for (let i = 1; i < w - 1; i += 1) { this.put(x + i, y, "─", style); if (h > 1) this.put(x + i, y + h - 1, "─", style); }
      if (h > 1) { this.put(x, y + h - 1, bl, style); this.put(x + w - 1, y + h - 1, br, style); }
      for (let i = 1; i < h - 1; i += 1) { this.put(x, y + i, "│", style); this.put(x + w - 1, y + i, "│", style); }
    },
    /** Styled lines, with trailing blanks dropped. */
    toLines() {
      const lines = [];
      for (let y = 0; y <= maxY; y += 1) {
        const spans = [];
        let text = "";
        let style = null;
        const flush = () => { if (text) spans.push(style ? { text, ...style } : { text }); text = ""; };
        for (let x = 0; x <= maxX; x += 1) {
          const cell = cells.get(key(x, y));
          const char = cell ? cell.char ?? (cell.mask ? JUNCTIONS[cell.line][cell.mask] : " ") : " ";
          const next = cell?.char ? cell.style : cell?.mask ? { dim: true } : null;
          if (JSON.stringify(next) !== JSON.stringify(style)) { flush(); style = next; }
          text += char;
        }
        text = text.replace(/\s+$/, "");
        flush();
        lines.push({ spans: spans.length ? spans : [{ text: " " }] });
      }
      return lines;
    },
  };
}

/** Cell measurements for the shared layout: a box is its label plus a border and a space either side. */
const cellMetrics = (model, labelWidth) => ({
  vertical: model.direction === "TD" || model.direction === "TB" || model.direction === "BT",
  reversed: model.direction === "BT" || model.direction === "RL",
  wrap: (text) => wrapLabel(text, Math.max(6, labelWidth)),
  measure: (lines) => ({ w: widthOf(lines) + 4, h: lines.length + 2 }),
  gapMinor: model.direction === "LR" || model.direction === "RL" ? 1 : 3,
  lane: 1,
  labelRoom: (text) => safe(text).length + 2,
  labelSpan: (text) => safe(text).length + 2,
  snap: Math.floor,
  inset: 1, // a box's last row is its border, not the space after it
  placeholder: 1,
});

function drawFlow(model, width, labelWidth) {
  const metrics = cellMetrics(model, labelWidth);
  const laid = layoutFlowchart(model, metrics);
  if (laid.width > width || laid.height > MAX_DIAGRAM_LINES) return null;
  const grid = createGrid();
  for (const node of laid.nodes) {
    if (node.dummy) continue;
    grid.box(node.x, node.y, node.w, node.h, node.shape, { dim: true });
    node.lines.forEach((text, index) => grid.text(node.x + 2, node.y + 1 + index, text));
  }
  for (const loop of laid.loops) grid.put(loop.x, loop.y, "↺", { dim: true });
  for (const link of laid.links) {
    grid.line(link.points, link.style);
    if (link.through) { const last = link.points.at(-1); grid.run(last.x, last.y, link.through.x, link.through.y, link.style); }
    if (link.head) {
      // Up and down the head sits on the box's own edge, which still reads as a border; left and right it
      // has to sit outside, or it would punch a hole in the one character drawing that side.
      const glyph = link.head.kind === "circle" ? "○" : link.head.kind === "cross" ? "✗" : ARROWS[link.head.dir];
      const x = link.head.x + (link.head.dir === "right" ? -1 : link.head.dir === "left" ? 1 : 0);
      grid.put(x, link.head.y, glyph, { dim: true });
    }
    if (link.label) {
      // Down the page the label follows the end of its own run, with a space to stand clear of the corner.
      if (link.label.align === "end") grid.text(link.label.x - safe(link.label.text).length, link.label.y, link.label.text, { color: "cyan" });
      else grid.label(link.label.x + (metrics.vertical ? 1 : 0), link.label.y, link.label.text, { color: "cyan" });
    }
  }
  const lines = grid.toLines();
  for (const group of laid.groups) {
    const names = group.nodeIds.map((id) => laid.nodes.find((node) => node.id === id)).filter((node) => node && !node.dummy).map((node) => node.lines.join(" "));
    if (names.length) lines.push({ spans: [{ text: safe(`${group.label || "group"}: ${names.join(", ")}`).slice(0, width), dim: true }] });
  }
  return lines;
}

function drawSequence(model, width) {
  const laid = layoutSequence(model, {
    wrap: (text, room) => wrapLabel(text, Math.max(6, room)),
    measure: (lines) => ({ w: widthOf(lines) + 4, h: lines.length + 2 }),
    headHeight: 3, gapColumn: 3, row: 1, left: 1,
    labelWidth: (text) => safe(text).length,
    noteRoom: (span) => Math.max(8, span - 4),
    snap: Math.floor,
  });
  if (laid.width > width || laid.height > MAX_DIAGRAM_LINES) return null;
  const grid = createGrid();
  for (const column of laid.columns) {
    grid.box(column.x, 0, column.w, 3, "rect", { dim: true });
    grid.text(column.x + 2, 1, column.text, { bold: true });
  }
  // Lifelines go down before anything is written over them, so a label's padding fills only what is free.
  for (const column of laid.columns) grid.run(column.centre, laid.lifelineTop, column.centre, laid.lifelineBottom, "solid");
  for (const item of laid.items) {
    switch (item.kind) {
      case "label": {
        const text = safe(item.text);
        const centred = item.x + Math.max(1, Math.floor((item.span - text.length) / 2));
        grid.label(Math.max(0, Math.min(centred, width - text.length - 1) - 1), item.y, text, {});
        break;
      }
      case "message": {
        const rightwards = item.toX > item.fromX;
        const tip = rightwards ? item.toX - 1 : item.toX + 1;
        grid.run(item.fromX, item.y, tip, item.y, item.style);
        grid.put(tip, item.y, item.arrow === "cross" ? "✗" : rightwards ? ARROWS.right : ARROWS.left, { dim: true });
        if (item.arrow === "open") grid.put(rightwards ? item.fromX + 1 : item.fromX - 1, item.y, rightwards ? "╶" : "╴", { dim: true });
        break;
      }
      case "self": {
        // A message to itself turns around rather than going anywhere.
        const back = Math.min(item.x + 4, width - 2);
        grid.run(item.x, item.y, back, item.y, item.style);
        grid.run(back, item.y, back, item.y + 1, item.style);
        grid.run(item.x + 1, item.y + 1, back, item.y + 1, item.style);
        grid.put(item.x + 1, item.y + 1, ARROWS.left, { dim: true });
        if (item.label) grid.label(back + 1, item.y, item.label, {});
        break;
      }
      case "note":
        grid.box(item.x, item.y, item.w, item.h, "round", { dim: true });
        item.lines.forEach((text, index) => grid.text(item.x + 2, item.y + 1 + index, text, { color: "cyan" }));
        break;
      case "branch":
        grid.text(Math.min(item.depth, 2) + 2, item.y, item.text, { dim: true, italic: true });
        break;
      default: break;
    }
  }
  for (const rail of laid.rails) {
    const x = Math.min(rail.depth, 2);
    grid.run(x, rail.y, x, rail.end, "solid");
    grid.put(x, rail.y, "┌", { dim: true });
    grid.put(x + 1, rail.y, "─", { dim: true });
    grid.put(x, rail.end, "└", { dim: true });
    grid.put(x + 1, rail.end, "─", { dim: true });
    grid.text(x + 2, rail.y, ` ${rail.label} `, { dim: true, italic: true });
  }
  return grid.toLines().slice(0, laid.lifelineBottom + 1);
}

// ---- the compact form, for a diagram too wide to draw ------------------------------------------

/** Wrap a line of plain text, so the compact form loses nothing it was asked to show. */
function wrapPlain(text, width, indent = "  ") {
  const lines = [];
  let current = "";
  const flush = () => { if (current) { lines.push(lines.length ? indent + current : current); current = ""; } };
  for (const word of safe(text).split(/\s+/).filter(Boolean)) {
    const room = Math.max(8, lines.length ? width - indent.length : width);
    const piece = word.length > room ? `${word.slice(0, room - 1)}…` : word;
    if (!current) current = piece;
    else if (current.length + 1 + piece.length <= room) current += ` ${piece}`;
    else { flush(); current = piece; }
  }
  flush();
  return lines.length ? lines : [""];
}

function compactFlow(model, width) {
  const label = new Map(model.nodes.map((node) => [node.id, node.shape === "point" ? pointLabel(node) : node.label || node.id]));
  const lines = [];
  const arrow = (edge) => (edge.arrow === "none" ? "───" : edge.style === "dotted" ? "╌╌▶" : edge.style === "thick" ? "━━▶" : "──▶");
  for (const edge of model.edges) {
    const text = `${label.get(edge.from) ?? edge.from} ${edge.label ? `${arrow(edge).slice(0, 2)} ${edge.label} ${arrow(edge)}` : arrow(edge)} ${label.get(edge.to) ?? edge.to}`;
    for (const row of wrapPlain(text, width)) lines.push({ spans: [{ text: row }] });
    if (lines.length >= MAX_DIAGRAM_LINES) break;
  }
  const linked = new Set(model.edges.flatMap((edge) => [edge.from, edge.to]));
  const alone = model.nodes.filter((node) => !linked.has(node.id)).map((node) => label.get(node.id));
  if (alone.length) for (const row of wrapPlain(alone.join(", "), width)) lines.push({ spans: [{ text: row, dim: true }] });
  return lines.slice(0, MAX_DIAGRAM_LINES);
}

function compactSequence(model, width) {
  const label = new Map(model.participants.map((participant) => [participant.id, participant.label]));
  const lines = [];
  let depth = 0;
  const push = (text, style) => { for (const row of wrapPlain(text, width, "    ")) lines.push({ spans: [{ text: row, ...style }] }); };
  for (const event of model.events) {
    if (lines.length >= MAX_DIAGRAM_LINES) break;
    const indent = "  ".repeat(Math.min(depth, 4));
    if (event.kind === "message") push(`${indent}${label.get(event.from)} ${event.style === "dotted" ? "╌╌▶" : "──▶"} ${label.get(event.to)}: ${event.label}`, {});
    else if (event.kind === "note") push(`${indent}note ${event.placement} ${event.targets.map((id) => label.get(id)).join(", ")}: ${event.text}`, { dim: true });
    else if (event.kind === "block") { push(`${indent}${event.tag} ${event.label}`.trimEnd(), { dim: true, italic: true }); depth += 1; }
    else if (event.kind === "branch") push(`${"  ".repeat(Math.max(0, Math.min(depth, 4) - 1))}${event.tag} ${event.label}`.trimEnd(), { dim: true, italic: true });
    else if (event.kind === "end") depth = Math.max(0, depth - 1);
  }
  return lines.slice(0, MAX_DIAGRAM_LINES);
}

/**
 * @param {string} source the body of a ```mermaid fence
 * @param {number} width columns available
 * @returns {{ lines: Array<{ spans: Array<object> }>, compact: boolean } | null} null when this is not a diagram Jolo draws
 */
export function mermaidLines(source, width = 80) {
  const model = parseMermaid(source);
  if (!model) return null;
  const available = Math.max(MIN_WIDTH, width);
  // Whatever the layout believed, a row wider than the terminal is not a picture anyone can read.
  const fits = (lines) => lines.every((entry) => entry.spans.reduce((total, span) => total + span.text.length, 0) <= available);
  try {
    if (model.type === "sequence") {
      const drawn = drawSequence(model, available);
      if (drawn && fits(drawn)) return { lines: drawn.slice(0, MAX_DIAGRAM_LINES), compact: false };
      return { lines: compactSequence(model, available), compact: true };
    }
    for (const labelWidth of LABEL_WIDTHS) {
      const drawn = drawFlow(model, available, labelWidth);
      if (drawn && fits(drawn)) return { lines: drawn.slice(0, MAX_DIAGRAM_LINES), compact: false };
    }
    return { lines: compactFlow(model, available), compact: true };
  } catch {
    // A diagram Jolo cannot lay out is still worth reading as a list of its links.
    return { lines: model.type === "sequence" ? compactSequence(model, available) : compactFlow(model, available), compact: true };
  }
}
