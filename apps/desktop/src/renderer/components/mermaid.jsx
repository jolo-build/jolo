import { useId, useMemo, useState, useRef, useLayoutEffect, useEffect } from "react";
import { createPortal } from "react-dom";
import { Modal } from "./modal.jsx";
import { Icon } from "./icon.jsx";
import { parseMermaid } from "@jolo/markdown/mermaid";
import { layoutFlowchart, layoutSequence } from "@jolo/markdown/mermaid-layout";

// Mermaid diagrams drawn as SVG. The parser and the layout are the same ones
// the terminal client uses; only the units and the drawing differ, so a diagram reads the same in both
// places. Nothing here interprets markup: every shape and every character comes from the model.

const FONT = 12;
const EDGE_FONT = 11;
const LINE = 16;
const PAD_X = 10;
const PAD_Y = 6;
const LANE = LINE + 6; // leave clear space between neighbouring edge-label backgrounds
const MAX_LABEL = 220; // px before a label wraps
const MAX_LINES = 4;

let context; // undefined until tried, null when this environment has no canvas
let fontFamily = "monospace";
/**
 * Text measured in the font it will actually be drawn in, so boxes fit their words.
 *
 * @param {string} text
 * @param {number} [fontSize]
 * @returns {number} width in pixels, estimated from the character count where there is no canvas
 */
function textWidth(text, fontSize = FONT) {
  if (context === undefined) {
    try {
      const canvas = document.createElement("canvas");
      const found = canvas.getContext("2d");
      fontFamily = getComputedStyle(document.documentElement).getPropertyValue("--mono").trim() || "monospace";
      context = found ?? null;
    } catch { context = null; }
  }
  if (context) context.font = `${fontSize}px ${fontFamily}`;
  return context ? context.measureText(String(text)).width : String(text).length * fontSize * 0.6;
}
const edgeLabelWidth = (text) => textWidth(text, EDGE_FONT) + 8;
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
    labelRoom: edgeLabelWidth,
    labelSpan: edgeLabelWidth,
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
      const width = edgeLabelWidth(link.label.text);
      const x = link.label.align === "end" ? link.label.x - width : link.label.x;
      return <g key={`label-${index}`}>
        <rect x={x} y={link.label.y - LINE / 2} width={width} height={LINE} rx={3} className="mermaid-label-bg" />
        <text x={x + 4} y={link.label.y} className="mermaid-edge-text" dominantBaseline="central">{link.label.text}</text>
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

function DiagramZoom({ zoom, setZoom, fit }) {
  return <div className="mermaid-zoom" role="group" aria-label="Diagram zoom">
    <button type="button" aria-label="Zoom out diagram" title="Zoom out" disabled={zoom <= .5} onClick={() => setZoom(value => Math.max(.5, value - .25))}><Icon name="zoomOut" size={15} /></button>
    <output aria-label="Diagram zoom level">{Math.round(zoom * 100)}%</output>
    <button type="button" aria-label="Zoom in diagram" title="Zoom in" disabled={zoom >= 4} onClick={() => setZoom(value => Math.min(4, value + .25))}><Icon name="zoomIn" size={15} /></button>
    <button type="button" aria-label="Fit diagram" title="Fit diagram" onClick={fit}><Icon name="restore" size={14} /></button>
  </div>;
}

function DiagramSvg({ laid, id, width }) {
  return <svg className="mermaid-svg" role="img" aria-label={`${laid.kind === 'sequence' ? 'Sequence' : 'Flow'} diagram`}
    viewBox={`-2 -2 ${laid.width + 4} ${laid.height + 4}`} width={laid.width + 4} height={laid.height + 4} style={{ width }}>
    <Markers id={id} />
    {laid.kind === 'sequence' ? <SequenceDrawing laid={laid} id={id} /> : <FlowDrawing laid={laid} id={id} />}
  </svg>;
}

function FullWindowDiagram({ laid, onClose }) {
  const [zoom, setZoom] = useState(1), [size, setSize] = useState({ width: 0, height: 0 });
  const visibleBounds = () => ({
    left: window.visualViewport?.offsetLeft ?? 0,
    top: window.visualViewport?.offsetTop ?? 0,
    width: window.visualViewport?.width ?? window.innerWidth,
    height: window.visualViewport?.height ?? window.innerHeight,
  });
  const [bounds, setBounds] = useState(visibleBounds);
  const viewport = useRef(null), drag = useRef(null);
  const gestureZoom = useRef(zoom), zoomAnchor = useRef(null);
  const id = useId().replace(/[^\w-]/g, '');
  useLayoutEffect(() => {
    // Pinch zoom changes the visible viewport without changing CSS vw/vh units.
    // Follow both its size and pan offset to keep the dialog controls on screen.
    const update = () => setBounds(visibleBounds());
    const visible = window.visualViewport;
    visible?.addEventListener('resize', update);
    visible?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    update();
    return () => {
      visible?.removeEventListener('resize', update);
      visible?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, []);
  useLayoutEffect(() => {
    const element = viewport.current;
    const measure = ({ width, height }) => {
      // clientWidth/clientHeight round up at fractional browser zoom levels. A
      // stage that is even a fraction too large creates scrollbars, which then
      // resize the canvas and cause a continuous fit/scrollbar feedback loop.
      const next = { width: Math.floor(width), height: Math.floor(height) };
      setSize(previous => previous.width === next.width && previous.height === next.height ? previous : next);
    };
    const observer = new ResizeObserver(([entry]) => measure(entry.contentRect));
    observer.observe(element);
    measure(element.getBoundingClientRect());
    return () => observer.disconnect();
  }, []);
  const scale = Math.min(Math.max(1, size.width - 48) / (laid.width + 4), Math.max(1, size.height - 48) / (laid.height + 4));
  const width = (laid.width + 4) * scale * zoom, height = (laid.height + 4) * scale * zoom;
  useLayoutEffect(() => {
    gestureZoom.current = zoom;
    const anchor = zoomAnchor.current;
    if (!anchor) return;
    zoomAnchor.current = null;
    const element = viewport.current;
    const diagram = element.querySelector('svg').getBoundingClientRect();
    // Keep the diagram point beneath the pinch stationary as the stage grows.
    element.scrollLeft += diagram.left + anchor.u * diagram.width - anchor.x;
    element.scrollTop += diagram.top + anchor.v * diagram.height - anchor.y;
  }, [zoom, width, height]);
  useEffect(() => {
    const element = viewport.current;
    const pinch = (event) => {
      // Chromium delivers macOS trackpad pinch gestures as Ctrl+wheel events.
      // Ordinary two-finger scrolling keeps the canvas's native pan behavior.
      if (!event.ctrlKey) return;
      event.preventDefault();
      event.stopPropagation();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1);
      const next = Math.max(.5, Math.min(4, gestureZoom.current * Math.exp(-delta * .01)));
      if (next === gestureZoom.current) return;
      const diagram = element.querySelector('svg').getBoundingClientRect();
      if (!diagram.width || !diagram.height) return;
      zoomAnchor.current = { x: event.clientX, y: event.clientY, u: (event.clientX - diagram.left) / diagram.width, v: (event.clientY - diagram.top) / diagram.height };
      gestureZoom.current = next;
      setZoom(next);
    };
    // React's delegated wheel listener is passive; cancellation must happen here
    // so a pinch scales the diagram without zooming the whole desktop interface.
    element.addEventListener('wheel', pinch, { passive: false });
    return () => element.removeEventListener('wheel', pinch);
  }, []);
  const fit = () => { setZoom(1); viewport.current?.scrollTo({ left: 0, top: 0 }); };
  return createPortal(<Modal label="Full-window diagram" className="mermaid-full-window" style={{ ...bounds, right: 'auto', bottom: 'auto' }} onClose={onClose}>
    <header className="mermaid-full-heading"><span>Diagram</span><button type="button" aria-label="Close diagram" title="Close diagram (Esc)" onClick={onClose}><Icon name="close" size={20} /></button></header>
    <div ref={viewport} className="mermaid-full-canvas" role="region" aria-label="Full-window diagram canvas" tabIndex={0}
      onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { x: event.clientX, y: event.clientY, left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop }; }}
      onPointerMove={event => { if (!drag.current) return; event.currentTarget.scrollLeft = drag.current.left + drag.current.x - event.clientX; event.currentTarget.scrollTop = drag.current.top + drag.current.y - event.clientY; }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
      <div className="mermaid-full-stage" style={{ width: Math.max(size.width, width + 48), height: Math.max(size.height, height + 48) }}><DiagramSvg laid={laid} id={id} width={width} /></div>
    </div>
    <footer className="mermaid-full-controls"><DiagramZoom zoom={zoom} setZoom={setZoom} fit={fit} /></footer>
  </Modal>, document.body);
}

/**
 * A mermaid fence drawn as a diagram, with its source one click away. Falls back to whatever the caller
 * would otherwise have shown when this is not a diagram Jolo draws.
 */
export function MermaidDiagram({ block, fallback }) {
  const [source, setSource] = useState(false), [expanded, setExpanded] = useState(false);
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
      {!source && <button type="button" className="mermaid-expand" aria-label="Open full-window diagram" title="Open full-window diagram" onClick={() => setExpanded(true)}><Icon name="maximize" size={15} /></button>}
      <button type="button" className="md-embed-toggle" aria-pressed={source} onClick={() => setSource((value) => !value)}>{source ? "Diagram" : "Source"}</button>
    </div>
    {source
      ? <pre className="md-code" data-language={block.language}><code>{block.text}</code></pre>
      : <div className="md-diagram-body">
          <div className="mermaid-viewport" role="region" aria-label="Diagram canvas" tabIndex={0}>
          <DiagramSvg laid={laid} id={id} width={laid.width + pad * 2} />
          </div>
          {/* Only a flowchart has groups, so this list is empty for a sequence diagram and the layout is that one. */}
          {groups.map((group, index) => <div key={index} className="mermaid-group">{group.label || "group"}: {group.nodeIds.map((nodeId) => /** @type {FlowLayout} */ (laid).nodes.find((node) => node.id === nodeId)).filter((node) => node && !node.dummy).map((node) => node.lines.join(" ")).join(", ")}</div>)}
        </div>}
    {expanded && <FullWindowDiagram laid={laid} onClose={() => setExpanded(false)} />}
  </div>;
}
