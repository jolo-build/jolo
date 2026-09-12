import { describe, expect, test } from "bun:test";
import { parseMermaid } from "../src/mermaid.js";
import { layoutFlowchart, layoutSequence } from "../src/mermaid-layout.js";

// The layout both clients share, measured here the way the desktop measures: whole numbers, boxes whose
// edges are their borders. The terminal's own units are covered by its renderer's tests.
const metrics = (model, extra = {}) => ({
  vertical: model.direction === "TD" || model.direction === "TB" || model.direction === "BT",
  reversed: model.direction === "BT" || model.direction === "RL",
  wrap: (text) => String(text ?? "").split("\n"),
  measure: (lines) => ({ w: Math.max(...lines.map((line) => line.length)) * 8 + 20, h: lines.length * 16 + 12 }),
  gapMinor: 20,
  lane: 10,
  labelRoom: (text) => text.length * 8 + 16,
  labelSpan: (text) => text.length * 8 + 16,
  ...extra,
});
const flow = (source, extra) => { const model = parseMermaid(source); return layoutFlowchart(model, metrics(model, extra)); };
const find = (laid, id) => laid.nodes.find((node) => node.id === id);
const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
/** Does an axis-aligned run of a link pass through a box it has no business being in? */
const crosses = (from, to, box) => Math.min(from.x, to.x) < box.x + box.w && Math.max(from.x, to.x) > box.x
  && Math.min(from.y, to.y) < box.y + box.h && Math.max(from.y, to.y) > box.y;

describe("laying a diagram out", () => {
  test("a chain runs one layer per step, and the boxes never sit on top of each other", () => {
    const laid = flow("flowchart TD\n  A[one] --> B[two] --> C[three]");
    const [a, b, c] = ["A", "B", "C"].map((id) => find(laid, id));
    expect(a.y).toBeLessThan(b.y);
    expect(b.y).toBeLessThan(c.y);
    for (const [first, second] of [[a, b], [b, c], [a, c]]) expect(overlap(first, second)).toBe(false);
    expect(laid.width).toBeGreaterThan(0);
    expect(laid.height).toBeGreaterThanOrEqual(c.y + c.h);
  });

  test("a branch puts its two ends side by side in one layer, each with its own link", () => {
    const laid = flow("flowchart TD\n  A --> B\n  A --> C");
    const [b, c] = [find(laid, "B"), find(laid, "C")];
    expect(b.y).toBe(c.y); // the same layer
    expect(overlap(b, c)).toBe(false);
    expect(laid.links).toHaveLength(2);
    for (const link of laid.links) {
      expect(link.points.length).toBeGreaterThanOrEqual(2);
      expect(link.head).toMatchObject({ dir: "down" });
      // A link starts on the box it leaves and ends on the box it points at.
      const start = link.points[0];
      const end = link.points.at(-1);
      const from = find(laid, link.edge.from);
      const to = find(laid, link.edge.to);
      expect(start.y).toBe(from.y + from.h);
      expect(end.y).toBe(to.y);
      expect(end.x).toBeGreaterThanOrEqual(to.x);
      expect(end.x).toBeLessThanOrEqual(to.x + to.w);
    }
  });

  test("a link that skips a layer gets a lane of its own to travel in", () => {
    const laid = flow("flowchart TD\n  A --> B --> C\n  A --> C");
    const skipping = laid.links.filter((link) => link.edge.from === "A" && link.edge.to === "C");
    expect(skipping.length).toBeGreaterThanOrEqual(2); // one segment per layer it crosses
    expect(skipping.some((link) => link.through)).toBe(true); // a placeholder carries the line past B
    expect(skipping.filter((link) => link.head)).toHaveLength(1); // only the last segment arrives
    // The line travels beside B rather than through it, which is what the placeholder reserved room for.
    const b = find(laid, "B");
    for (const link of skipping) {
      const points = link.through ? [...link.points, link.through] : link.points;
      for (let i = 1; i < points.length; i += 1) expect(crosses(points[i - 1], points[i], b)).toBe(false);
    }
  });

  test("a loop is laid out forwards but still points at the node its author named", () => {
    const laid = flow("stateDiagram-v2\n  [*] --> Idle\n  Idle --> Busy: work\n  Busy --> Idle: done");
    const backwards = laid.links.filter((link) => link.edge.from === "Busy" && link.edge.to === "Idle");
    expect(backwards).toHaveLength(1);
    const idle = find(laid, "Idle");
    expect(backwards[0].head).toMatchObject({ dir: "up" });
    expect(backwards[0].head.y).toBe(idle.y + idle.h); // arriving at Idle's near edge, pointing back into it
    expect(laid.links.find((link) => link.edge.label === "work").label.text).toBe("work");
  });

  test("left to right is the same layout read sideways, and reversing a direction flips it end to end", () => {
    const across = flow("flowchart LR\n  A[one] --> B[two]");
    const [a, b] = [find(across, "A"), find(across, "B")];
    expect(a.x).toBeLessThan(b.x);
    expect(a.y).toBe(b.y);
    expect(across.links[0].head).toMatchObject({ dir: "right" });

    const back = flow("flowchart BT\n  A[one] --> B[two]");
    expect(find(back, "A").y).toBeGreaterThan(find(back, "B").y); // the first box sits at the bottom
    expect(back.links[0].head).toMatchObject({ dir: "up" });

    const leftwards = flow("flowchart RL\n  A[one] --> B[two]");
    expect(find(leftwards, "A").x).toBeGreaterThan(find(leftwards, "B").x);
    expect(leftwards.links[0].head).toMatchObject({ dir: "left" });
  });

  test("a node pointing at itself is marked beside its box rather than routed through it", () => {
    const laid = flow("flowchart TD\n  A --> A\n  A --> B");
    expect(laid.loops).toHaveLength(1);
    expect(laid.loops[0].id).toBe("A");
    expect(laid.links.filter((link) => link.edge.from === "A" && link.edge.to === "A")).toHaveLength(0);
  });

  test("mixed-size boxes keep connector labels in separate lanes outside the entire layer", () => {
    for (const direction of ["TD", "BT", "LR", "RL"]) {
      const laid = flow(`flowchart ${direction}
        A[Short] -->|Version-matched WebSocket routes| D[Service]
        B[General worker\\nPython / TypeScript / flows] -->|Claim and update jobs| D
        C[Protected environment\\nmode 0600\\nConfiguration] -->|Bounded, authenticated calls| D`, { lane: 22 });
      const labels = laid.links.filter(link => link.label).map(({label}) => ({
        x: label.align === "end" ? label.x - label.text.length * 8 - 16 : label.x,
        y: label.y - 8, w: label.text.length * 8 + 16, h: 16,
      }));
      expect(labels).toHaveLength(3);
      for (let i = 0; i < labels.length; i++) {
        for (const other of labels.slice(i + 1)) expect(overlap(labels[i], other)).toBe(false);
        for (const node of laid.nodes) expect(overlap(labels[i], node)).toBe(false);
      }
      for (const link of laid.links) {
        for (const node of laid.nodes.filter(node => node.id !== link.edge.from && node.id !== link.edge.to)) {
          for (let i = 1; i < link.points.length; i++) expect(crosses(link.points[i - 1], link.points[i], node)).toBe(false);
        }
      }
    }
  });

  test("a sequence diagram becomes columns and a run of things that happen down the page", () => {
    const model = parseMermaid(`sequenceDiagram
      participant U as User
      participant J as Jolo
      U->>J: run task
      J-->>U: needs you
      U->>U: think
      Note over U,J: waiting
      loop retry
        U->>J: again
      end`);
    const laid = layoutSequence(model, {
      wrap: (text) => [String(text)],
      measure: (lines) => ({ w: Math.max(...lines.map((line) => line.length)) * 8 + 20, h: lines.length * 16 + 12 }),
      headHeight: 34, gapColumn: 30, row: 18, left: 6,
      labelWidth: (text) => text.length * 8,
      noteRoom: (span) => Math.max(80, span - 20),
    });
    expect(laid.columns.map((column) => column.id)).toEqual(["U", "J"]);
    expect(laid.columns[0].centre).toBeLessThan(laid.columns[1].centre);
    expect(laid.lifelineBottom).toBeGreaterThan(laid.lifelineTop);
    expect(laid.width).toBeGreaterThanOrEqual(laid.columns[1].x + laid.columns[1].w);

    const kinds = laid.items.map((item) => item.kind);
    expect(kinds).toContain("message");
    expect(kinds).toContain("self");
    expect(kinds).toContain("note");
    // Everything happens in the order it was written, and nothing sits above the participants.
    const ys = laid.items.map((item) => item.y);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(laid.lifelineTop);
    expect(laid.rails).toHaveLength(1);
    expect(laid.rails[0]).toMatchObject({ label: "loop retry" });
    expect(laid.rails[0].end).toBeGreaterThan(laid.rails[0].y);
  });
});


test("full branch labels fit within the canvas in every flow direction", () => {
  for (const direction of ["TD", "TB", "BT", "LR", "RL"]) {
    const model = parseMermaid(`flowchart ${direction}
      A{Analysis result} -->|No threat found| B[Retain observation]
      A -->|Suspicious or inconclusive| C[Analyst review]
      A -->|Phishing confirmed| D[Take action]
      C -->|Confirmed| D`);
    const sizes = metrics(model);
    const laid = layoutFlowchart(model, sizes);
    const labels = laid.links.filter(link => link.label).map(link => link.label);
    expect(labels.some(label => label.text === "Phishing confirmed")).toBe(true);
    for (const label of labels) {
      const span = sizes.labelSpan(label.text);
      const start = label.align === "end" ? label.x - span : label.x;
      expect(start).toBeGreaterThanOrEqual(0);
      expect(start + span).toBeLessThanOrEqual(laid.width);
    }
    for (const node of laid.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.x + node.w).toBeLessThanOrEqual(laid.width);
    }
  }
});
