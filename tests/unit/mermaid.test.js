import { describe, expect, test } from "bun:test";
import { parseMermaid } from "../../packages/markdown/src/mermaid.js";

const flow = (source) => parseMermaid(source);
const edgeText = (model) => model.edges.map((edge) => `${edge.from}-${edge.label ?? ""}${edge.style[0]}${edge.arrow[0]}->${edge.to}`);

describe("reading a mermaid diagram", () => {
  test("a flowchart's shapes and links come through as the author wrote them", () => {
    const model = flow(`flowchart TD
      A[Start] --> B{Ready?}
      B -->|yes| C[(Store)]
      B -. no .-> D((Stop))
      C ==> D`);
    expect(model.direction).toBe("TD");
    expect(model.nodes).toEqual([
      { id: "A", label: "Start", shape: "rect" },
      { id: "B", label: "Ready?", shape: "rhombus" },
      { id: "C", label: "Store", shape: "cylinder" },
      { id: "D", label: "Stop", shape: "circle" },
    ]);
    expect(edgeText(model)).toEqual(["A-sa->B", "B-yessa->C", "B-nodа->D".replace("а", "a"), "C-ta->D"]);
  });

  test("every shape has a spelling, and a bare mention keeps the label it was given", () => {
    const model = flow(`graph LR
      a([stadium]) --> b[[sub]] --> c{{hex}} --> d>flag] --> e[/slanted/]
      a --> f`);
    expect(model.nodes.map((node) => `${node.id}:${node.shape}`)).toEqual(["a:stadium", "b:subroutine", "c:hexagon", "d:asymmetric", "e:parallelogram", "f:rect"]);
    expect(model.nodes.find((node) => node.id === "a").label).toBe("stadium"); // not overwritten by the later bare "a"
    expect(model.nodes.find((node) => node.id === "f").label).toBe("f");
  });

  test("an arrow inside a label is text, not a link", () => {
    const model = flow('flowchart LR\n  A["maps a --> b"] --> B\n  C[x -- y] --> D');
    expect(model.nodes.find((node) => node.id === "A").label).toBe("maps a --> b");
    expect(model.nodes.find((node) => node.id === "C").label).toBe("x -- y");
    expect(edgeText(model)).toEqual(["A-sa->B", "C-sa->D"]);
  });

  test("chains, ampersands, comments and init directives", () => {
    const model = flow(`%%{init: {"theme":"dark"}}%%
      flowchart TD
      %% a note to the reader
      A --> B --> C
      D & E --> F ; F --> G`);
    expect(edgeText(model)).toEqual(["A-sa->B", "B-sa->C", "D-sa->F", "E-sa->F", "F-sa->G"]);
  });

  test("a subgraph is remembered as a group of nodes", () => {
    const model = flow(`flowchart LR
      subgraph auth [Sign in]
        A --> B
      end
      B --> C`);
    expect(model.groups).toEqual([{ label: "Sign in", nodeIds: ["A", "B"] }]);
  });

  test("a state diagram is a flowchart whose start and end are marks rather than names", () => {
    const model = flow(`stateDiagram-v2
      [*] --> Idle
      Idle --> Busy: work
      Busy --> Idle: done
      Busy --> [*]`);
    expect(model.nodes.filter((node) => node.shape === "point")).toHaveLength(2);
    expect(model.edges.map((edge) => edge.label)).toEqual([null, "work", "done", null]);
    expect(model.nodes.map((node) => node.label)).toContain("Idle");
  });

  test("a sequence diagram keeps its cast, its messages and the blocks around them", () => {
    const model = flow(`sequenceDiagram
      participant U as User
      actor J as Jolo
      U->>J: run task
      J-->>U: needs you
      U->>U: think
      Note over U,J: waiting
      loop every minute
        U->>J: poll
      else give up
      end`);
    expect(model.participants).toEqual([{ id: "U", label: "User" }, { id: "J", label: "Jolo" }]);
    expect(model.events.map((event) => event.kind)).toEqual(["message", "message", "message", "note", "block", "message", "branch", "end"]);
    expect(model.events[0]).toMatchObject({ from: "U", to: "J", label: "run task", style: "solid", arrow: "filled" });
    expect(model.events[1]).toMatchObject({ style: "dotted", label: "needs you" });
    expect(model.events[3]).toMatchObject({ placement: "over", targets: ["U", "J"], text: "waiting" });
    expect(model.events[4]).toMatchObject({ tag: "loop", label: "every minute" });
  });

  test("a diagram Jolo cannot draw says so, rather than guessing", () => {
    expect(parseMermaid("classDiagram\n  A <|-- B")).toBeNull();
    expect(parseMermaid("erDiagram\n  A ||--o{ B : has")).toBeNull();
    expect(parseMermaid("pie title Votes\n  \"a\" : 10")).toBeNull();
    expect(parseMermaid("")).toBeNull();
    expect(parseMermaid("flowchart TD")).toBeNull(); // a header with nothing under it is not a diagram
  });

  test("labels are text, never markup or control characters, and the size is bounded", () => {
    const model = flow('flowchart TD\n  A["one<br/>two &amp; three"] --> B');
    expect(model.nodes[0].label).toBe("one\ntwo & three");
    // A label written with \n means a line break, which is how these diagrams are usually typed.
    expect(flow(String.raw`flowchart TD` + "\n" + String.raw`  A["Boot menu\n(or timeout)"] --> B`).nodes[0].label).toBe("Boot menu\n(or timeout)");
    const huge = flow(`flowchart TD\n${Array.from({ length: 400 }, (_, i) => `  N${i} --> N${i + 1}`).join("\n")}`);
    expect(huge.nodes.length).toBeLessThanOrEqual(120);
    expect(huge.edges.length).toBeLessThanOrEqual(240);
  });
});
