import { useId, useMemo, useState } from "react";
import { parseMermaid } from "@jolo/markdown/mermaid";
import { layoutFlowchart, layoutSequence } from "@jolo/markdown/mermaid-layout";

// Mermaid diagrams drawn as SVG. The parser and the layout are the same ones
// the terminal client uses; only the units and the drawing differ, so a diagram reads the same in both
// places. Nothing here interprets markup: every shape and every character comes from the model.

const FONT = 12;
const LINE = 16;
const PAD_X = 10;
const PAD_Y = 6;
const LANE = 14;
const MAX_LABEL = 220; // px before a label wraps
const MAX_LINES = 4;

let context; // undefined until tried, null when this environment has no canvas
/**
 * Text measured in the font it will actually be drawn in, so boxes fit their words.
 *
 * @param {string} text
 * @returns {number} width in pixels, estimated from the character count where there is no canvas
 */
function textWidth(text) {
  if (context === undefined) {
    try {
      const canvas = document.createElement("canvas");
      const found = canvas.getContext("2d");
      const family = getComputedStyle(document.documentElement).getPropertyValue("--mono").trim() || "monospace";
      if (found) found.font = `${FONT}px ${family}`;
      context = found ?? null;
    } catch { context = null; }
  }
  return context ? context.measureText(String(text)).width : String(text).length * FONT * 0.6;
}
const widest = (lines) => Math.max(0, ...lines.map((line) => textWidth(line)));

function wrapLabel(text, max = MAX_LABEL) {
  const out = [];
  for (const paragraph of String(text ?? "").split("\n")) {
    if (!paragraph) { out.push(""); continue; }
    let current = "";
    for (const word of paragraph.split(/\s+/)) {
      if (!current) current = word;
      else if (textWidth(`${current} ${word}`) <= max) current += ` ${word}`;
      else { out.push(current); current = word; }
    }
    if (current) out.push(current);
  }
  const lines = out.length ? out : [""];
  return lines.length <= MAX_LINES ? lines : [...lines.slice(0, MAX_LINES - 1), `${lines[MAX_LINES - 1]}…`];
}

const DIAMONDS = new Set(["rhombus", "hexagon"]);
const ROUNDED = new Set(["round", "stadium", "circle", "cylinder", "point"]);

/** A shape holds its words: a diamond needs half again as much room as the box that would contain them. */
const measureNode = (lines, node) => (DIAMONDS.has(node?.shape)
  ? { w: widest(lines) + PAD_X * 4, h: lines.length * LINE + PAD_Y * 4 }
  : { w: widest(lines) + PAD_X * 2, h: lines.length * LINE + PAD_Y * 2 });

// `kind` is what tells the two layouts apart downstream, so it is stated as the literal it is rather
// than being widened to a string the drawing code would have to re-check.
/** @typedef {ReturnType<typeof layoutFlowchart> & { kind: "flow" }} FlowLayout */
/** @returns {FlowLayout} */
function buildFlow(model) {
  const laid = layoutFlowchart(model, {
    vertical: model.direction === "TD" || model.direction === "TB" || model.direction === "BT",
    reversed: model.direction === "BT" || model.direction === "RL",
    wrap: (text) => wrapLabel(text),
    measure: measureNode,
    gapMinor: model.direction === "LR" || model.direction === "RL" ? 18 : 26,
    lane: LANE,
    labelRoom: (text) => textWidth(text) + 16,
    labelSpan: (text) => textWidth(text) + 16,
  });
  return { ...laid, kind: "flow" };
}

/** @returns {ReturnType<typeof layoutSequence> & { kind: "sequence" }} */
function buildSequence(model) {
  const laid = layoutSequence(model, {
    wrap: (text, room) => wrapLabel(text, room),
    measure: (lines) => ({ w: widest(lines) + PAD_X * 2, h: lines.length * LINE + PAD_Y * 2 }),
    headHeight: LINE + PAD_Y * 2 + 10,
    gapColumn: 34,
    row: 19,
    left: 6,
    labelWidth: textWidth,
    noteRoom: (span) => Math.max(120, span - 24),
  });
  return { ...laid, kind: "sequence" };
}

const DASH = { solid: undefined, dotted: "3 3", thick: undefined };
const STROKE = { solid: 1, dotted: 1, thick: 2 };
const path = (points) => points.map((point, index) => `${index ? "L" : "M"}${point.x} ${point.y}`).join(" ");

function Markers({ id }) {
  return <defs>
    <marker id={`${id}-arrow`} viewBox="0 0 9 8" refX="8" refY="4" markerWidth="7" markerHeight="6" orient="auto-start-reverse">
      <path d="M0,0.5 L9,4 L0,7.5 z" fill="currentColor" />
    </marker>
    <marker id={`${id}-circle`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <circle cx="4" cy="4" r="3" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </marker>
    <marker id={`${id}-cross`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M1,1 L7,7 M7,1 L1,7" stroke="currentColor" strokeWidth="1.2" fill="none" />
    </marker>
  </defs>;
}

function NodeShape({ node }) {
  const { x, y, w, h, shape } = node;
  if (DIAMONDS.has(shape)) return <polygon points={`${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}`} className="mermaid-shape" />;
  return <rect x={x} y={y} width={w} height={h} rx={ROUNDED.has(shape) ? Math.min(h / 2, 14) : 4} className="mermaid-shape" />;
}

function FlowDrawing({ laid, id }) {
  return <>
    {laid.links.map((link, index) => {
      const marker = link.head && `url(#${id}-${link.head.kind === "circle" ? "circle" : link.head.kind === "cross" ? "cross" : "arrow"})`;
      const atStart = link.head && link.points[0].x === link.head.x && link.points[0].y === link.head.y;
      const points = link.through ? [...link.points, link.through] : link.points;
      return <path
        key={index} d={path(points)} className="mermaid-link" fill="none"
        strokeDasharray={DASH[link.style]} strokeWidth={STROKE[link.style] ?? 1}
        markerEnd={marker && !atStart ? marker : undefined} markerStart={marker && atStart ? marker : undefined}
      />;
    })}
    {laid.nodes.filter((node) => !node.dummy).map((node) => <g key={node.id}>
      <NodeShape node={node} />
      {node.lines.map((line, index) => (
        <text key={index} x={node.x + node.w / 2} y={node.y + node.h / 2 + (index - (node.lines.length - 1) / 2) * LINE} className="mermaid-text" textAnchor="middle" dominantBaseline="central">{line}</text>
      ))}
    </g>)}
    {laid.loops.map((loop, index) => <text key={index} x={loop.x + 4} y={loop.y} className="mermaid-note-text" dominantBaseline="central">↺</text>)}
    {laid.links.filter((link) => link.label).map((link, index) => {
      const width = textWidth(link.label.text) + 8;
      const x = link.label.align === "end" ? link.label.x - width : link.label.x;
      return <g key={`label-${index}`}>
        <rect x={x} y={link.label.y - LINE / 2} width={width} height={LINE} rx={3} className="mermaid-label-bg" />
        <text x={x + width / 2} y={link.label.y} className="mermaid-edge-text" textAnchor="middle" dominantBaseline="central">{link.label.text}</text>
      </g>;
    })}
  </>;
}

function SequenceDrawing({ laid, id }) {
  const headHeight = LINE + PAD_Y * 2;
  return <>
    {laid.columns.map((column) => <g key={column.id}>
      <line x1={column.centre} y1={laid.lifelineTop} x2={column.centre} y2={laid.lifelineBottom} className="mermaid-lifeline" strokeDasharray="2 4" />
      <rect x={column.x} y={0} width={column.w} height={headHeight} rx={4} className="mermaid-shape" />
      <text x={column.centre} y={headHeight / 2} className="mermaid-text mermaid-participant" textAnchor="middle" dominantBaseline="central">{column.text}</text>
    </g>)}
    {laid.rails.map((rail, index) => <g key={`rail-${index}`}>
      <rect x={Math.min(rail.depth, 2) * 6} y={rail.y} width={laid.width - Math.min(rail.depth, 2) * 12} height={Math.max(LINE, rail.end - rail.y)} rx={4} className="mermaid-rail" />
      <text x={Math.min(rail.depth, 2) * 6 + 8} y={rail.y + LINE / 2} className="mermaid-edge-text mermaid-rail-label" dominantBaseline="central">{rail.label}</text>
    </g>)}
    {laid.items.map((item, index) => {
      switch (item.kind) {
        case "label":
          return <text key={index} x={item.x + item.span / 2} y={item.y + LINE / 2 - 1} className="mermaid-edge-text" textAnchor="middle" dominantBaseline="central">{item.text}</text>;
        case "message": {
          const rightwards = item.toX > item.fromX;
          const tip = item.toX + (rightwards ? -2 : 2);
          return <line
            key={index} x1={item.fromX} y1={item.y} x2={tip} y2={item.y} className="mermaid-link"
            strokeDasharray={DASH[item.style]} markerEnd={`url(#${id}-${item.arrow === "cross" ? "cross" : "arrow"})`}
          />;
        }
        case "self": {
          const right = item.x + 26;
          return <g key={index}>
            <path d={`M${item.x} ${item.y} L${right} ${item.y} L${right} ${item.y + 15} L${item.x + 3} ${item.y + 15}`} className="mermaid-link" fill="none" strokeDasharray={DASH[item.style]} markerEnd={`url(#${id}-arrow)`} />
            {item.label && <text x={right + 6} y={item.y + 7} className="mermaid-edge-text" dominantBaseline="central">{item.label}</text>}
          </g>;
        }
        case "note":
          return <g key={index}>
            <rect x={item.x} y={item.y} width={item.w} height={item.h} rx={4} className="mermaid-note" />
            {item.lines.map((line, row) => <text key={row} x={item.x + PAD_X} y={item.y + PAD_Y + LINE / 2 + row * LINE} className="mermaid-note-text" dominantBaseline="central">{line}</text>)}
          </g>;
        case "branch":
          return <text key={index} x={Math.min(item.depth, 2) * 6 + 8} y={item.y + LINE / 2} className="mermaid-edge-text" dominantBaseline="central">{item.text}</text>;
        default: return null;
      }
    })}
  </>;
}

/**
 * A mermaid fence drawn as a diagram, with its source one click away. Falls back to whatever the caller
 * would otherwise have shown when this is not a diagram Jolo draws.
 */
export function MermaidDiagram({ block, fallback }) {
  const [source, setSource] = useState(false);
  const id = useId().replace(/[^\w-]/g, "");
  const laid = useMemo(() => {
    const model = parseMermaid(block.text);
    if (!model) return null;
    try { return model.type === "sequence" ? buildSequence(model) : buildFlow(model); }
    catch { return null; }
  }, [block.text]);
  if (!laid || !(laid.width > 0 && laid.height > 0)) return fallback;
  const groups = laid.kind === "flow" ? laid.groups.filter((group) => group.nodeIds.length) : [];
  const pad = 2;
  return <div className="md-embed md-diagram">
    <div className="md-code-language">
      <span>{block.language}</span><span className="grow" />
      <button type="button" className="md-embed-toggle" aria-pressed={source} onClick={() => setSource((value) => !value)}>{source ? "Diagram" : "Source"}</button>
    </div>
    {source
      ? <pre className="md-code" data-language={block.language}><code>{block.text}</code></pre>
      : <div className="md-diagram-body">
          <svg
            className="mermaid-svg" role="img" aria-label={`${laid.kind === "sequence" ? "Sequence" : "Flow"} diagram`}
            viewBox={`${-pad} ${-pad} ${laid.width + pad * 2} ${laid.height + pad * 2}`}
            width={laid.width + pad * 2} height={laid.height + pad * 2}
          >
            <Markers id={id} />
            {laid.kind === "sequence" ? <SequenceDrawing laid={laid} id={id} /> : <FlowDrawing laid={laid} id={id} />}
          </svg>
          {/* Only a flowchart has groups, so this list is empty for a sequence diagram and the layout is that one. */}
          {groups.map((group, index) => <div key={index} className="mermaid-group">{group.label || "group"}: {group.nodeIds.map((nodeId) => /** @type {FlowLayout} */ (laid).nodes.find((node) => node.id === nodeId)).filter((node) => node && !node.dummy).map((node) => node.lines.join(" ")).join(", ")}</div>)}
        </div>}
  </div>;
}
