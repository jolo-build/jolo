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
 *   labelRoom: (text: string) => number, // room a labelled lane needs along the travel: width across, height down
 *   labelSpan: (text: string) => number, // the label's extent across the travel: the widest line it wraps to
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
  /**
   * One run of a link between two adjacent layers. A link that skips layers becomes several
   * segments joined by placeholder nodes. The lane fields are assigned later, once every segment
   * between a pair of layers is known and they can be packed into as few lanes as possible.
   * @type {Array<{
   *   edge: any,
   *   from: string,
   *   to: string,
   *   layer: number,
   *   reversedEdge: boolean,
   *   sameLayer?: boolean,
   *   headAtExit?: boolean,
   *   lane?: number | null,
   *   laneLabel?: string,
   * }>}
   */
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
  const laneSizes = [];
  for (let index = 0; index < Math.max(0, layers.length - 1); index += 1) {
    const between = segments.filter((segment) => segment.layer === index && !segment.sameLayer);
    const used = [];
    let room = 0;
    for (const segment of between) {
      const from = centre(byId.get(segment.from));
      const to = centre(byId.get(segment.to));
      const label = segment.edge.label && !byId.get(segment.from).dummy ? segment.edge.label : "";
      if (label) room = Math.max(room, labelRoom(label));
      if (from === to && !label) { segment.lane = null; segment.laneLabel = label; continue; }
      // A label centred on its run can reach past either end of it, so the lane is reserved for the run
      // and the label's wrapped span together.
      const mid = (from + to) / 2;
      const reach = label && vertical ? labelSpan(label) / 2 : 0;
      const start = Math.min(from, to, mid - reach);
      const stop = Math.max(from, to, mid + reach);
      let slot = used.findIndex((end) => end < start - 1);
      if (slot === -1) { slot = used.length; used.push(0); }
      used[slot] = stop;
      segment.lane = slot;
      segment.laneLabel = label;
    }
    // Horizontal labels occupy the run after their turn. Reserve their width for
    // each lane, including straight labelled links, so converging labels cannot overlap.
    laneSizes.push(lane + room);
    gaps.push(Math.max(1, used.length) * (lane + room) + lane);
  }

  // Along the layers: each layer is as deep as its deepest box, plus the lanes that follow it.
  const major = new Map();
  const layerExits = [];
  let majorExtent = 0;
  for (const [index, nodesInLayer] of layers.entries()) {
    const depth = Math.max(lane, ...nodesInLayer.map(majorOf));
    for (const node of nodesInLayer) {
      major.set(node.id, majorExtent);
      if (node.dummy) { if (vertical) node.h = depth; else node.w = depth; } // its line passes straight through
    }
    layerExits.push(majorExtent + depth - inset);
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
      // Neighbours in one layer, or a node pointing at itself. A self-loop is marked beside the box; a link
      // between neighbours runs between the sides that face each other, jogging where their centres differ.
      const a = place(from);
      const b = place(to);
      if (from === to) {
        const loopLabel = segment.edge.label
          ? { text: segment.edge.label, lines: wrap(segment.edge.label), x: a.x + from.w + lane, y: a.y + half(from.h), align: "start" }
          : null;
        loops.push({ id: from.id, x: a.x + from.w, y: a.y + half(from.h), label: loopLabel });
        continue;
      }
      const ahead = vertical ? b.x + half(to.w) >= a.x + half(from.w) : b.y + half(to.h) >= a.y + half(from.h);
      const aMid = vertical ? a.y + half(from.h) : a.x + half(from.w);
      const bMid = vertical ? b.y + half(to.h) : b.x + half(to.w);
      const aPort = vertical ? (ahead ? a.x + from.w : a.x) : (ahead ? a.y + from.h : a.y);
      const bPort = vertical ? (ahead ? b.x : b.x + to.w) : (ahead ? b.y : b.y + to.h);
      const jog = snap((aPort + bPort) / 2);
      const points = (vertical
        ? [{ x: aPort, y: aMid }, { x: jog, y: aMid }, { x: jog, y: bMid }, { x: bPort, y: bMid }]
        : [{ x: aMid, y: aPort }, { x: aMid, y: jog }, { x: bMid, y: jog }, { x: bMid, y: bPort }]
      ).filter((point, index, all) => index === 0 || point.x !== all[index - 1].x || point.y !== all[index - 1].y);
      // The head sits on the node the edge was written to point at — the near end for a link laid out
      // backwards, as it is everywhere else.
      const head = segment.edge.arrow === "none" ? null
        : segment.reversedEdge
          ? (vertical ? { x: aPort, y: aMid, dir: ahead ? "left" : "right" } : { x: aMid, y: aPort, dir: ahead ? "up" : "down" })
          : (vertical ? { x: bPort, y: bMid, dir: ahead ? "right" : "left" } : { x: bMid, y: bPort, dir: ahead ? "down" : "up" });
      if (head) head.kind = segment.edge.arrow;
      const label = segment.edge.label
        ? { text: segment.edge.label, lines: wrap(segment.edge.label), x: vertical ? jog : (aMid + bMid) / 2, y: vertical ? (aMid + bMid) / 2 : jog, align: "center" }
        : null;
      links.push({ edge: segment.edge, style: segment.edge.style, points, head, label, aside: true });
      continue;
    }
    const exit = port(from, "exit");
    const enter = port(to, "enter");
    const step = reversed ? -1 : 1;
    const gapLane = (segment.lane ?? 0) * laneSizes[segment.layer];
    // Reserve lanes from the whole layer's boundary. A shorter box must not pull
    // its connector (and label) back into a neighbouring box or another lane.
    const boundary = reversed ? totalMajor - layerExits[segment.layer] - inset : layerExits[segment.layer];
    const laneAt = boundary + step * (lane + gapLane);
    const points = vertical
      ? [exit, { x: exit.x, y: laneAt }, { x: enter.x, y: laneAt }, enter]
      : [exit, { x: laneAt, y: exit.y }, { x: laneAt, y: enter.y }, enter];
    const trimmed = points.filter((point, index) => index === 0 || point.x !== points[index - 1].x || point.y !== points[index - 1].y);
    // A label sits centred on its own run of the link, the way mermaid draws it, wrapped to as many
    // lines as the caller's wrap allows.
    const label = segment.laneLabel
      ? { text: segment.laneLabel, lines: wrap(segment.laneLabel),
          ...(vertical
            ? { x: (exit.x + enter.x) / 2, y: laneAt, align: "center" }
            : { x: laneAt, y: (exit.y + enter.y) / 2, align: reversed ? "end" : "start" }) }
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
    const start = label.align === "end" ? label.x - span : label.align === "center" ? label.x - span / 2 : label.x;
    left = Math.min(left, start);
    right = Math.max(right, start + span);
  }
  for (const loop of loops) {
    if (loop.label) right = Math.max(right, loop.label.x + labelSpan(loop.label.text));
  }
  const shift = (point) => point ? { ...point, x: point.x - left } : point;
  return {
    width: right - left,
    height,
    nodes: nodes.map((node) => ({ ...node, ...shift(place(node)) })),
    links: links.map((link) => ({ ...link, points: link.points.map(shift), head: shift(link.head), label: shift(link.label), through: shift(link.through) })),
    loops: loops.map((loop) => ({ ...shift(loop), label: loop.label ? shift(loop.label) : null })),
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
 *   participantRoom?: number, maxLabelWidth?: number, selfWidth?: number,
 *   snap?: (value: number) => number,
 * }} metrics
 */
export function layoutSequence(model, metrics) {
  const { wrap, measure, gapColumn, row: rowSize, left, labelWidth, noteRoom } = metrics;
  const snap = metrics.snap ?? ((value) => value);
  const half = (value) => snap(value / 2);

  const columns = model.participants.map((participant) => {
    const lines = wrap(participant.label, metrics.participantRoom ?? 18);
    const { w } = measure(lines);
    return { id: participant.id, text: lines.join(" "), lines, w };
  });
  const byId = new Map(columns.map((column) => [column.id, column]));
  const headHeight = Math.max(metrics.headHeight, ...columns.map(column => measure(column.lines).h));
  const labelLines = text => wrap(text, metrics.maxLabelWidth ?? Infinity);
  const spanOf = lines => Math.max(0, ...lines.map(labelWidth));
  const selfWidth = metrics.selfWidth ?? gapColumn;
  let at = left;
  for (const column of columns) { column.x = at; column.centre = at + half(column.w); at += column.w + gapColumn; }
  // Message labels reserve space between their participants. Process columns
  // left to right so later constraints never undo an earlier lane's spacing.
  for (let end = 1; end < columns.length; end++) {
    for (const event of model.events) {
      if (event.kind !== "message" || !event.label) continue;
      const a = columns.findIndex(column => column.id === event.from);
      const b = columns.findIndex(column => column.id === event.to);
      if (a < 0 || b < 0 || a === b || Math.max(a, b) !== end) continue;
      const first = columns[Math.min(a, b)], last = columns[end];
      const extra = spanOf(labelLines(event.label)) + gapColumn - (last.centre - first.centre);
      if (extra > 0) for (const column of columns.slice(end)) { column.x += extra; column.centre += extra; }
    }
  }
  let minX = 0, maxX = Math.max(0, ...columns.map(column => column.x + column.w)) + left;
  const include = (x, width) => { minX = Math.min(minX, x); maxX = Math.max(maxX, x + width); };

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
          const lines = event.label ? labelLines(event.label) : [];
          items.push({ kind: "self", from: from.id, x: from.centre, y, label: event.label, lines, style: event.style, arrow: event.arrow });
          include(from.centre, selfWidth + left + spanOf(lines));
          y += Math.max(2, lines.length + 1) * rowSize;
          break;
        }
        if (event.label) for (const text of labelLines(event.label)) {
          const x = Math.min(from.centre, to.centre), span = Math.abs(to.centre - from.centre);
          items.push({ kind: "label", text, from: from.id, to: to.id, x, span, y });
          include(x + span / 2 - labelWidth(text) / 2, labelWidth(text));
          y += rowSize;
        }
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
        const x = event.placement === "left" ? first - boxWidth - half(gapColumn)
          : event.placement === "right" ? last + half(gapColumn)
          : first;
        items.push({ kind: "note", x, y, w: boxWidth, h: size.h, lines });
        include(x, boxWidth);
        y += size.h;
        break;
      }
      case "block": {
        const label = `${event.tag}${event.label ? ` ${event.label}` : ""}`;
        const lines = labelLines(label);
        blocks.push({ label, lines, y, depth: blocks.length });
        include(0, spanOf(lines) + left * 2 + blocks.length * left);
        y += rowSize * lines.length;
        break;
      }
      case "branch": {
        for (const text of labelLines(`${event.tag}${event.label ? ` ${event.label}` : ""}`)) {
          const depth = blocks.at(-1)?.depth ?? 0;
          items.push({ kind: "branch", text, depth, y });
          include(0, labelWidth(text) + left * 2 + depth * left);
          y += rowSize;
        }
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
  // Notes and self-messages may reach beyond either end participant. Translate
  // everything together so the SVG viewBox contains the full diagram.
  for (const column of columns) { column.x -= minX; column.centre -= minX; }
  for (const item of items) {
    if (item.x !== undefined) item.x -= minX;
    if (item.fromX !== undefined) { item.fromX -= minX; item.toX -= minX; }
  }
  return { width: maxX - minX, height: Math.max(y, top), headHeight, row: rowSize, selfWidth, columns, items, rails: rails.reverse(), lifelineTop: top, lifelineBottom: Math.max(y, top), labelWidth };
}
