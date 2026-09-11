import { describe, expect, test } from "bun:test";
import { parseDocument } from "../src/index.js";

const text = (nodes) => nodes.map((n) => (n.type === "text" ? n.text : n.type === "code" ? `<${n.text}>` : n.type === "link" ? `[${text(n.children)}]` : text(n.children))).join("");

describe("list items with code spans that span lines", () => {
  test("a ``` span wrapped across continuation lines closes instead of leaving literal backticks", () => {
    const { blocks } = parseDocument('- Command: ```\n  python check.py -u "http://example.com/login?user=alice" -m GET\n  --verbose\n  ```\n- The script reports findings.');
    expect(blocks.map((block) => block.type)).toEqual(["list"]);
    const [command, note] = blocks[0].items;
    expect(text(command.children)).toBe('Command: <\npython check.py -u "http://example.com/login?user=alice" -m GET\n--verbose\n>');
    expect(text(command.children)).not.toContain("```");
    expect(command.children.filter((node) => node.type === "link")).toHaveLength(0); // a URL inside code is not a link
    expect(text(note.children)).toBe("The script reports findings.");
  });

  test("a fence that starts on its own line stays a code block with its language and indentation", () => {
    const { blocks } = parseDocument("1. Install:\n   ```sh\n   npm install\n     npm run build\n   ```\n2. Done");
    expect(blocks.map((block) => block.type)).toEqual(["list", "code", "list"]);
    expect(blocks[1]).toEqual({ type: "code", language: "sh", text: "npm install\n  npm run build" });
    expect(text(blocks[0].items[0].children)).toBe("Install:");
    expect(text(blocks[2].items[0].children)).toBe("Done");
  });

  test("a deeply indented own-line fence keeps its lines and drops the info string from the text", () => {
    const { blocks } = parseDocument("- Install:\n    ```sh\n    npm install\n    npm run build\n    ```");
    const code = blocks[0].items[0].children.find((node) => node.type === "code");
    expect(code.text).toBe("\nnpm install\nnpm run build\n");
    expect(code.text).not.toContain("sh");
  });

  test("prose continuation lines still reflow, and an unclosed span stays literal", () => {
    const wrapped = parseDocument("- a long item that\n  continues here\n- second").blocks[0].items;
    expect(text(wrapped[0].children)).toBe("a long item that\ncontinues here");
    expect(text(wrapped[1].children)).toBe("second");
    const unclosed = parseDocument("- start: ``` never closed\n- second").blocks[0].items;
    expect(text(unclosed[0].children)).toBe("start: ``` never closed");
    expect(text(unclosed[1].children)).toBe("second");
  });

  test("an ordered list resumes at the author's number after a code block interrupts it", () => {
    const { blocks } = parseDocument("1. Install:\n   ```sh\n   npm install\n   ```\n2. Build it\n3. Ship it");
    expect(blocks.map((block) => block.type)).toEqual(["list", "code", "list"]);
    expect(blocks[0]).toMatchObject({ ordered: true, start: 1 });
    expect(blocks[2]).toMatchObject({ ordered: true, start: 2 });
    expect(blocks[2].items.map((item) => text(item.children))).toEqual(["Build it", "Ship it"]);
    expect(parseDocument("- a\n- b").blocks[0]).toMatchObject({ ordered: false, start: 1 });
    expect(parseDocument("7) seven\n8) eight").blocks[0]).toMatchObject({ ordered: true, start: 7 });
    expect(parseDocument("0. zero").blocks[0].start).toBe(0);
  });

  test("top-level fences and markdown fences are untouched by the list rules", () => {
    expect(parseDocument("Before\n\n```js\nconst x = 1;\n```\n\nAfter").blocks.map((b) => b.type)).toEqual(["paragraph", "code", "paragraph"]);
    expect(parseDocument("```md\n# Plan\n\n- **a** b\n```").blocks[0]).toEqual({ type: "code", language: "md", text: "# Plan\n\n- **a** b" });
  });
});
