// Where the parts of a mermaid diagram go.
//
// One layout, two renderers. The terminal measures in character cells and the desktop in pixels, so nothing
// here knows which: the caller supplies the sizes, and gets back positions and polylines in the same unit it
// measured in. That way the awkward parts — layering a graph that may contain cycles, ordering each layer so
// links cross as little as they cheaply can, giving a link that skips layers a lane of its own — are written
// once and behave the same wherever a diagram is drawn.

/** Layers by longest path, with the links that close a cycle set aside so the layering can finish. */
export function assignLayers(nodes, edges) {
  const outgoing = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) if (outgoing.has(edge.from) && outgoing.has(edge.to)) outgoing.get(edge.from).push(edge);
  const state = new Map(nodes.map((node) => [node.id, 0])); // 0 unvisited, 1 on the stack, 2 done
  const back = new Set();
  const walk = (id) => {
    state.set(id, 1);
    for (const edge of outgoing.get(id) ?? []) {
      const mark = state.get(edge.to);
      if (mark === 1) back.add(edge);
      else if (mark === 0) walk(edge.to);
    }
    state.set(id, 2);
  };
  for (const node of nodes) if (state.get(node.id) === 0) walk(node.id);

  const forward = edges.filter((edge) => !back.has(edge) && outgoing.has(edge.from) && outgoing.has(edge.to) && edge.from !== edge.to);
  const layer = new Map(nodes.map((node) => [node.id, 0]));
  for (let pass = 0; pass < nodes.length; pass += 1) {
    let moved = false;
    for (const edge of forward) {
      const wanted = layer.get(edge.from) + 1;
      if (layer.get(edge.to) < wanted) { layer.set(edge.to, wanted); moved = true; }
    }
    if (!moved) break;
  }
  return { layer, back };
}

/** Order each layer so links cross as little as they cheaply can. */
export function orderLayers(layers, edges) {
  const incoming = new Map();
  const outgoing = new Map();
  for (const edge of edges) {
    if (!incoming.has(edge.to)) incoming.set(edge.to, []);
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    incoming.get(edge.to).push(edge.from);
    outgoing.get(edge.from).push(edge.to);
  }
  const position = new Map();
  const index = () => layers.forEach((layer) => layer.forEach((node, i) => position.set(node.id, i)));
  index();
  const sweep = (neighbours) => {
    for (const layer of layers) {
      const weight = new Map(layer.map((node) => {
        const linked = (neighbours.get(node.id) ?? []).map((id) => position.get(id)).filter((value) => value !== undefined);
        return [node.id, linked.length ? linked.reduce((a, b) => a + b, 0) / linked.length : position.get(node.id)];
      }));
      layer.sort((a, b) => weight.get(a.id) - weight.get(b.id) || position.get(a.id) - position.get(b.id));
    }
    index();
  };
  for (let pass = 0; pass < 2; pass += 1) { sweep(incoming); sweep(outgoing); }
}

/** The word a start or end marker reads as, since a terminal cannot draw a filled circle in a box. */
export const pointLabel = (node) => (node.id.endsWith("start") ? "start" : "end");

/**
 * Place a flowchart's boxes and route its links.
 *
 * @param {object} model from parseMermaid
 * @param {{
 *   vertical: boolean, reversed: boolean,
 *   wrap: (text: string) => string[],
 *   measure: (lines: string[], node: object) => { w: number, h: number },
 *   gapMinor: number, lane: number,
 *   labelRoom: (text: string) => number,
 *   labelSpan: (text: string) => number,
 *   snap?: (value: number) => number,
 *   inset?: number, placeholder?: number,
 * }} metrics sizes in whatever unit the caller draws in. `inset` is 1 where a box's last row *is* its
 *   border, as in a character grid, and 0 where the border is the edge itself, as in pixels.
 */
export function layoutFlowchart(model, metrics) {
  const { vertical, reversed, wrap, measure, gapMinor, lane, labelRoom, labelSpan } = metrics;
  const inset = metrics.inset ?? 0;
  const placeholder = metrics.placeholder ?? 0;
  const snap = metrics.snap ?? ((value) => value);
  const half = (value) => snap(value / 2);

  const nodes = model.nodes.map((node) => {
    const lines = wrap(node.shape === "point" ? pointLabel(node) : node.label);
    return { ...node, lines, ...measure(lines, node) }; // a diamond needs more room than the words alone
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges = model.edges.filter((edge) => byId.has(edge.from) && byId.has(edge.to));
  const { layer, back } = assignLayers(nodes, edges);

  // A link that skips layers gets a placeholder in each layer it passes, so its line has a lane of its own.
  const layerCount = Math.max(0, ...[...layer.values()]) + 1;
  const layers = Array.from({ length: layerCount }, () => []);
  for (const node of nodes) layers[layer.get(node.id)].push(node);
  const segments = [];
  let dummies = 0;
  for (const edge of edges) {
    const [from, to] = back.has(edge) ? [edge.to, edge.from] : [edge.from, edge.to];
    const start = layer.get(from);
    const end = layer.get(to);
    const reversedEdge = back.has(edge);
    if (from === to || start === end) { segments.push({ edge, from, to, layer: start, sameLayer: true, reversedEdge }); continue; }
    let previous = from;
    for (let step = start + 1; step < end; step += 1) {
      const passing = { id: `\x00dummy${dummies += 1}`, dummy: true, lines: [""], w: placeholder, h: placeholder };
      layers[step].push(passing);
      byId.set(passing.id, passing);
      segments.push({ edge, from: previous, to: passing.id, layer: step - 1, reversedEdge, headAtExit: reversedEdge && previous === edge.to });
      previous = passing.id;
    }
    segments.push({ edge, from: previous, to, layer: end - 1, reversedEdge, headAtExit: reversedEdge && previous === edge.to });
  }
  orderLayers(layers, segments.filter((segment) => !segment.sameLayer).map((segment) => ({ from: segment.from, to: segment.to })));

  // Across a layer: the boxes side by side, then every layer centred on the widest one.
  const minorOf = (node) => (vertical ? node.w : node.h);
  const majorOf = (node) => (vertical ? node.h : node.w);
  const minor = new Map();
  let minorExtent = 0;
  for (const nodesInLayer of layers) {
    let at = 0;
    for (const node of nodesInLayer) { minor.set(node.id, at); at += minorOf(node) + gapMinor; }
    minorExtent = Math.max(minorExtent, Math.max(0, at - gapMinor));
  }
  for (const nodesInLayer of layers) {
    const used = nodesInLayer.length ? minor.get(nodesInLayer.at(-1).id) + minorOf(nodesInLayer.at(-1)) : 0;
    const shift = half(minorExtent) - half(used);
    for (const node of nodesInLayer) minor.set(node.id, minor.get(node.id) + shift);
  }
  const centre = (node) => minor.get(node.id) + half(minorOf(node));

  // Between layers: every link that travels sideways gets a lane, sharing one where they do not overlap.
  const gaps = [];
  const labelRooms = [];
  for (let index = 0; index < Math.max(0, layers.length - 1); index += 1) {
    const between = segments.filter((segment) => segment.layer === index && !segment.sameLayer);
    const used = [];
    let room = 0;
    for (const segment of between) {
      const from = centre(byId.get(segment.from));
      const to = centre(byId.get(segment.to));
      const label = segment.edge.label && !byId.get(segment.from).dummy ? segment.edge.label : "";
      if (label && !vertical) room = Math.max(room, labelRoom(label));
      if (from === to && !(label && vertical)) { segment.lane = null; segment.laneLabel = label; continue; }
      const start = Math.min(from, to);
      const stop = Math.max(from, to) + (label && vertical ? labelSpan(label) : 0);
      let slot = used.findIndex((end) => end < start - 1);
      if (slot === -1) { slot = used.length; used.push(0); }
      used[slot] = stop;
      segment.lane = slot;
      segment.laneLabel = label;
    }
    labelRooms.push(room);
    gaps.push((Math.max(1, used.length) + 1) * lane + room);
  }

  // Along the layers: each layer is as deep as its deepest box, plus the lanes that follow it.
  const major = new Map();
  let majorExtent = 0;
  for (const [index, nodesInLayer] of layers.entries()) {
    const depth = Math.max(lane, ...nodesInLayer.map(majorOf));
    for (const node of nodesInLayer) {
      major.set(node.id, majorExtent);
      if (node.dummy) { if (vertical) node.h = depth; else node.w = depth; } // its line passes straight through
    }
    majorExtent += depth + (index < layers.length - 1 ? gaps[index] : 0);
  }
  const totalMajor = majorExtent;
  const width = vertical ? minorExtent : totalMajor;
  const height = vertical ? totalMajor : minorExtent;

  // Model coordinates → the page. Reversed directions count from the far end, so links still run with them.
  const place = (node) => {
    const majorPos = reversed ? totalMajor - major.get(node.id) - majorOf(node) : major.get(node.id);
    return vertical ? { x: minor.get(node.id), y: majorPos } : { x: majorPos, y: minor.get(node.id) };
  };
  const port = (node, side) => {
    const { x, y } = place(node);
    const far = reversed ? side === "enter" : side === "exit"; // the end the layers advance towards
    if (vertical) return { x: x + half(node.w), y: far ? y + node.h - inset : y };
    return { x: far ? x + node.w - inset : x, y: y + half(node.h) };
  };
  const direction = (side) => {
    if (vertical) return side === "enter" ? (reversed ? "up" : "down") : (reversed ? "down" : "up");
    return side === "enter" ? (reversed ? "left" : "right") : (reversed ? "right" : "left");
  };

  const links = [];
  const loops = [];
  for (const segment of segments) {
    const from = byId.get(segment.from);
    const to = byId.get(segment.to);
    if (!from || !to) continue;
    if (segment.sameLayer) {
      // Neighbours in one layer, or a node pointing at itself: marked beside the box rather than routed,
      // because a line between them would have to cross the boxes they sit in.
      const a = place(from);
      const b = place(to);
      if (from === to) { loops.push({ id: from.id, x: a.x + from.w, y: a.y + half(from.h) }); continue; }
      const points = vertical
        ? [{ x: a.x + from.w, y: a.y + half(from.h) }, { x: b.x, y: b.y + half(to.h) }]
        : [{ x: a.x + half(from.w), y: a.y + from.h }, { x: b.x + half(to.w), y: b.y }];
      links.push({ edge: segment.edge, style: segment.edge.style, points, head: null, label: null, aside: true });
      continue;
    }
    const exit = port(from, "exit");
    const enter = port(to, "enter");
    const step = reversed ? -1 : 1;
    const gapLane = (segment.lane ?? 0) * lane;
    const laneAt = (vertical ? exit.y : exit.x) + step * (lane + gapLane);
    const points = vertical
      ? [exit, { x: exit.x, y: laneAt }, { x: enter.x, y: laneAt }, enter]
      : [exit, { x: laneAt, y: exit.y }, { x: laneAt, y: enter.y }, enter];
    const trimmed = points.filter((point, index) => index === 0 || point.x !== points[index - 1].x || point.y !== points[index - 1].y);
    const label = segment.laneLabel
      ? vertical
        ? { text: segment.laneLabel, x: Math.max(exit.x, enter.x), y: laneAt, align: "start" }
        : { text: segment.laneLabel, x: laneAt, y: enter.y, align: reversed ? "end" : "start" }
      : null;
    links.push({
      edge: segment.edge,
      style: segment.edge.style,
      points: trimmed,
      // A link laid out backwards points at the node its author named, so its head sits where it left.
      head: segment.edge.arrow === "none" ? null
        : segment.headAtExit ? { x: exit.x, y: exit.y, dir: direction("exit"), kind: segment.edge.arrow }
        : to.dummy ? null
        : { x: enter.x, y: enter.y, dir: direction("enter"), kind: segment.edge.arrow },
      label,
      through: to.dummy ? port(to, "exit") : null, // the placeholder carries the line on through its layer
    });
  }

  // Edge labels can extend beyond the boxes, especially on vertical branches.
  // Include their full span and translate left-facing labels into the canvas.
  let left = 0, right = width;
  for (const { label } of links) {
    if (!label) continue;
    const span = labelSpan(label.text);
    left = Math.min(left, label.align === "end" ? label.x - span : label.x);
    right = Math.max(right, label.align === "end" ? label.x : label.x + span);
  }
  const shift = (point) => point ? { ...point, x: point.x - left } : point;
  return {
    width: right - left,
    height,
    nodes: nodes.map((node) => ({ ...node, ...shift(place(node)) })),
    links: links.map((link) => ({ ...link, points: link.points.map(shift), head: shift(link.head), label: shift(link.label), through: shift(link.through) })),
    loops: loops.map(shift),
    groups: model.groups ?? [],
  };
}

/**
 * Place a sequence diagram: a column per participant, and one item per thing that happens.
 *
 * @param {object} model from parseMermaid
 * @param {{
 *   wrap: (text: string, room: number) => string[],
 *   measure: (lines: string[]) => { w: number, h: number },
 *   headHeight: number, gapColumn: number, row: number, left: number,
 *   labelWidth: (text: string) => number,
 *   noteRoom: (span: number) => number,
 *   snap?: (value: number) => number,
 *   maxDepth: number,
 * }} metrics
 */
export function layoutSequence(model, metrics) {
  const { wrap, measure, headHeight, gapColumn, row: rowSize, left, labelWidth, noteRoom } = metrics;
  const snap = metrics.snap ?? ((value) => value);
  const half = (value) => snap(value / 2);

  const columns = model.participants.map((participant) => {
    const lines = [wrap(participant.label, 18)[0] ?? participant.id];
    const { w } = measure(lines);
    return { id: participant.id, text: lines[0], w };
  });
  const byId = new Map(columns.map((column) => [column.id, column]));
  let at = left;
  for (const column of columns) { column.x = at; column.centre = at + half(column.w); at += column.w + gapColumn; }
  const width = Math.max(0, at - gapColumn) + left;

  const items = [];
  const blocks = [];
  const rails = [];
  let y = headHeight;
  const top = y;
  for (const event of model.events) {
    switch (event.kind) {
      case "message": {
        const from = byId.get(event.from);
        const to = byId.get(event.to);
        if (!from || !to) break;
        if (from === to) {
          items.push({ kind: "self", from: from.id, x: from.centre, y, label: event.label, style: event.style, arrow: event.arrow });
          y += rowSize * 2;
          break;
        }
        if (event.label) { items.push({ kind: "label", text: event.label, from: from.id, to: to.id, x: Math.min(from.centre, to.centre), span: Math.abs(to.centre - from.centre), y }); y += rowSize; }
        items.push({ kind: "message", from: from.id, to: to.id, fromX: from.centre, toX: to.centre, y, style: event.style, arrow: event.arrow });
        y += rowSize * 2;
        break;
      }
      case "note": {
        const targets = event.targets.map((id) => byId.get(id)).filter(Boolean);
        if (!targets.length) break;
        const first = Math.min(...targets.map((column) => column.x));
        const last = Math.max(...targets.map((column) => column.x + column.w));
        const lines = wrap(event.text, noteRoom(last - first));
        const size = measure(lines);
        const boxWidth = Math.max(size.w, last - first);
        const x = event.placement === "left" ? Math.max(0, first - boxWidth - gapColumn / 2)
          : event.placement === "right" ? last + gapColumn / 2
          : first;
        items.push({ kind: "note", x: Math.min(x, Math.max(0, width - boxWidth)), y, w: boxWidth, h: size.h, lines });
        y += size.h;
        break;
      }
      case "block": {
        blocks.push({ label: `${event.tag}${event.label ? ` ${event.label}` : ""}`, y, depth: blocks.length });
        y += rowSize;
        break;
      }
      case "branch": {
        items.push({ kind: "branch", text: `${event.tag}${event.label ? ` ${event.label}` : ""}`, depth: blocks.at(-1)?.depth ?? 0, y });
        y += rowSize;
        break;
      }
      case "end": {
        const open = blocks.pop();
        if (open) rails.push({ ...open, end: y });
        y += rowSize;
        break;
      }
      default: break;
    }
  }
  for (const open of blocks) rails.push({ ...open, end: y });
  return { width, height: Math.max(y, top), columns, items, rails: rails.reverse(), lifelineTop: top, lifelineBottom: Math.max(y, top), labelWidth };
}
