import { describe, expect, test } from "bun:test";
import { mermaidLines, MAX_DIAGRAM_LINES } from "../src/tui/mermaid.js";
import { renderMarkdown } from "../src/tui/markdown.js";

const draw = (source, width = 76) => {
  const result = mermaidLines(source, width);
  return result && { ...result, text: result.lines.map((entry) => entry.spans.map((span) => span.text).join("")) };
};
const shown = (source, width) => draw(source, width).text.join("\n");

describe("drawing a mermaid diagram in a terminal", () => {
  test("a flowchart becomes boxes joined by lines that point where the author pointed them", () => {
    const picture = shown("flowchart TD\n  A[Start] --> B{Ready?}\n  B -->|yes| C[Store]\n  B -->|no| D[Stop]");
    expect(picture).toContain("│ Start │");
    expect(picture).toContain("│ Ready? │");
    expect(picture).toMatch(/╱─+▼─+╲/); // a decision is drawn as a diamond, entered from above
    expect(picture).toContain("yes");
    expect(picture).toContain("no");
    expect(picture.split("\n").every((row) => row.length <= 76)).toBe(true);
  });

  test("a label broken across lines is drawn across lines, not printed with its break showing", () => {
    const picture = shown(String.raw`flowchart TD` + "\n" + String.raw`  A["Boot menu shown\n(or timeout)"] --> B[Kernel]`);
    expect(picture).toContain("│ Boot menu shown │");
    expect(picture).toContain("│ (or timeout)    │");
    expect(picture).not.toContain(String.raw`\n`);
  });

  test("left to right puts the boxes in a row and the arrows between them", () => {
    const picture = shown("flowchart LR\n  A[Read] --> B[Parse] --> C[Render]");
    const row = picture.split("\n").find((entry) => entry.includes("Read"));
    expect(row).toBe("│ Read │─▶│ Parse │─▶│ Render │");
  });

  test("a link that closes a loop points back at the node it names", () => {
    const picture = shown("stateDiagram-v2\n  [*] --> Idle\n  Idle --> Busy: work\n  Busy --> Idle: done\n  Busy --> [*]");
    expect(picture).toContain("│ start │"); // [*] reads as a word rather than a mark the terminal cannot draw
    expect(picture).toContain("│ Idle │");
    expect(picture).toContain("▲"); // the way back is drawn pointing up
    expect(picture).toContain("work");
    expect(picture).toContain("done");
  });

  test("the line style the author chose is the line style drawn", () => {
    expect(shown("flowchart LR\n  A -.-> B")).toContain("╌");
    expect(shown("flowchart LR\n  A ==> B")).toContain("━");
    expect(shown("flowchart LR\n  A --- B")).not.toContain("▶"); // a link with no arrowhead keeps none
  });

  test("a sequence diagram becomes lifelines, with each message crossing between them", () => {
    const picture = shown(`sequenceDiagram
      participant U as User
      participant J as Jolo
      U->>J: run task
      J-->>U: needs you
      U->>U: think
      Note over U,J: waiting
      loop every minute
        U->>J: poll
      end`);
    expect(picture).toContain("│ User │");
    expect(picture).toContain("│ Jolo │");
    expect(picture).toContain("run task");
    expect(picture).toMatch(/├─+▶/); // out to Jolo
    expect(picture).toMatch(/◀╌+┤/); // and dashed on the way back
    expect(picture).toContain("waiting"); // the note
    expect(picture).toContain("loop every minute");
    expect(picture).toContain("think"); // a message to itself still says what it was
  });

  test("a diagram too wide to draw becomes a readable list instead of a picture to scroll", () => {
    const wide = draw("flowchart LR\n A[A very long label indeed] --> B[Another long one here] --> C[And a third]", 34);
    expect(wide.compact).toBe(true);
    expect(wide.text.every((row) => row.length <= 34)).toBe(true);
    expect(wide.text[0]).toContain("──▶");
    const sequence = draw("sequenceDiagram\n  Alpha->>Beta: do the thing\n  Beta->>Gamma: and another\n  Gamma-->>Alpha: finally done", 26);
    expect(sequence.compact).toBe(true);
    expect(sequence.text.join(" ").replace(/\s+/g, " ")).toContain("do the thing"); // wrapped, never cut short
    expect(sequence.text.every((row) => row.length <= 26)).toBe(true);
  });

  test("what Jolo cannot draw it does not pretend to, and what it draws stays bounded and clean", () => {
    expect(mermaidLines("classDiagram\n  A <|-- B", 80)).toBeNull();
    expect(mermaidLines("not a diagram at all", 80)).toBeNull();
    const huge = draw(`flowchart TD\n${Array.from({ length: 200 }, (_, i) => `  N${i} --> N${i + 1}`).join("\n")}`, 60);
    expect(huge.lines.length).toBeLessThanOrEqual(MAX_DIAGRAM_LINES);
    // eslint-disable-next-line no-control-regex
    expect(huge.text.join("\n")).not.toMatch(/[\x00-\x08\x0b-\x1f]/);
    const nasty = draw("flowchart TD\n  A[bell[31m] --> B", 60);
    // eslint-disable-next-line no-control-regex
    expect(nasty.text.join("\n")).not.toMatch(/[\x00-\x08\x0b-\x1f]/);
  });

  test("a mermaid fence in a reply is drawn; one Jolo cannot read stays the code it was written as", () => {
    const drawn = renderMarkdown("Flow:\n\n```mermaid\nflowchart LR\n  A[Read] --> B[Save]\n```\n", { width: 72 });
    const text = drawn.lines.map((entry) => entry.spans.map((span) => span.text).join("")).join("\n");
    expect(text).toContain("│ Read │");
    expect(text).toContain("▶");
    expect(text).not.toContain("flowchart LR"); // the source gave way to the picture

    const source = renderMarkdown("```mermaid\npie title Votes\n  \"a\" : 10\n```\n", { width: 72 });
    const sourceText = source.lines.map((entry) => entry.spans.map((span) => span.text).join("")).join("\n");
    expect(sourceText).toContain("pie title Votes");
  });
});
