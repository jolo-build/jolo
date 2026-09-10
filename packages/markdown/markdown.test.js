import { describe, expect, test } from "bun:test";
import { parseDocument, parseInline, renderPlain, segment } from "./src/index.js";

describe("markdown model", () => {
  test("removes Markdown fence indentation from copied code, preserving nested source indentation", () => {
    const source = "// apps/cli/src/highlight.js\nimport { highlight } from 'cli-highlight';\nexport function colorize(code) {\n  return highlight(code);\n}";
    const indented = source.split("\n").map((line) => `  ${line}`).join("\n");
    const markdown = `- Example\n\n  \`\`\`js\n${indented}`;
    for (const ending of ["", "\n  ```"]) {
      expect(parseDocument(markdown + ending).blocks[1]).toEqual({ type: "code", language: "js", text: source });
    }
    expect(parseDocument("   ~~~python\n   if True:\n       pass\n\n x = 1\n   ~~~").blocks[0].text).toBe("if True:\n    pass\n\nx = 1");
    // An unindented fence has no Markdown margin to remove.
    expect(parseDocument("```python\n    pass\n```").blocks[0].text).toBe("    pass");
  });

  test("keeps repository lists and code references structured", () => {
    const { blocks } = parseDocument("What I found\n- Read `gh_search.py`.\n- Run `python gh_search.py repos \"<query>\"`.\n\n```python\nclass GitHubSearcher:\n    pass\n```");
    expect(blocks.map((block) => block.type)).toEqual(["paragraph", "list", "code"]);
    expect(blocks[1].items[0].children).toContainEqual({ type: "code", text: "gh_search.py" });
    expect(blocks[1].items[1].children).toContainEqual({ type: "code", text: 'python gh_search.py repos "<query>"' });
    expect(blocks[2].text).toBe("class GitHubSearcher:\n    pass");
    const plain = "gh_search.py and search_repositories with foo__bar__baz";
    expect(parseInline(plain)).toEqual([{ type: "text", text: plain }]);
    expect(parseInline("_emphasis_ and __strong__").map((node) => node.type)).toEqual(["em", "text", "strong"]);
  });

  test("parses headings, paragraphs, lists, code, quotes, tables, and rules without producing HTML", () => {
    const text = "# Title\n\nSome **bold** and `code` with a [link](https://example.com) and <b>raw</b>.\n\n- one\n- two\n  - nested\n\n1. first\n2. second\n\n```js\nconst x = 1;\n```\n\n> quoted\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n---\n";
    const { blocks } = parseDocument(text);
    expect(blocks.map((b) => b.type)).toEqual(["heading", "paragraph", "list", "list", "code", "quote", "table", "rule"]);
    expect(blocks[0]).toMatchObject({ level: 1 });
    const paragraph = blocks[1].children;
    expect(paragraph.some((n) => n.type === "strong")).toBe(true);
    expect(paragraph.some((n) => n.type === "code" && n.text === "code")).toBe(true);
    expect(paragraph.find((n) => n.type === "link").href).toBe("https://example.com/");
    expect(paragraph.map((n) => n.text ?? "").join("")).toContain("<b>raw</b>"); // literal text, never markup
    expect(blocks[2].items.map((i) => i.depth)).toEqual([0, 0, 1]);
    expect(blocks[3].ordered).toBe(true);
    expect(blocks[4]).toMatchObject({ language: "js", text: "const x = 1;" });
    expect(blocks[6].rows[0].map((c) => c[0].text)).toEqual(["1", "2"]);
  });

  test("rejects unsafe links and renders images as text", () => {
    const nodes = parseInline("[x](javascript:alert(1)) ![alt](https://img) https://auto.link/path");
    expect(nodes.find((n) => n.type === "link" && n.href.startsWith("javascript"))).toBeUndefined();
    expect(nodes.some((n) => n.type === "text" && n.text.includes("[image: alt]"))).toBe(true);
    expect(nodes.find((n) => n.type === "link").href).toBe("https://auto.link/path");
  });

  test("keeps an unfinished fence open while streaming and reuses cached blocks", () => {
    const cache = new Map();
    const partial = "Intro\n\n```sh\necho hi";
    const a = parseDocument(partial, { cache });
    expect(a.open).toBe(true);
    expect(a.blocks[1]).toMatchObject({ type: "code", text: "echo hi" });
    expect(cache.size).toBe(1);
    const complete = `${partial}\n\`\`\`\n\nDone.\n\n`;
    const b = parseDocument(complete, { cache });
    expect(b.open).toBe(false);
    expect(b.blocks.map((x) => x.type)).toEqual(["paragraph", "code", "paragraph"]);
    expect(b.blocks[0]).toBe(a.blocks[0]); // cached instance reused
  });

  test("plain rendering wraps and marks structure for terminals", () => {
    const { blocks } = parseDocument("## Heading\n\nA long paragraph that should wrap at a narrow width for terminal display purposes.\n\n- [x] done\n- [ ] todo");
    const plain = renderPlain(blocks, { width: 30 });
    expect(plain.split("\n")[0]).toBe("## Heading");
    expect(plain.split("\n").every((line) => line.length <= 30)).toBe(true);
    expect(plain).toContain("• [x] done");
    expect(segment("a\n\n\n\nb").segments).toEqual(["a", "b"]);
  });
});
