import { describe, expect, test } from "bun:test";
import { renderMarkdown, MAX_CODE_LINES, MAX_LINES } from "../../apps/cli/src/tui/markdown.js";

const text = (entry) => entry.spans.map((span) => span.text).join("");
const spans = (lines) => lines.flatMap((entry) => entry.spans);

describe("terminal markdown", () => {
  test("headings, emphasis, links, lists, quotes, and rules become styled spans that fit the width", () => {
    const { lines } = renderMarkdown("# Title\n\nSome **bold** words and `code` with a [link](https://example.com) that goes on for a while.\n\n- one\n- [x] done\n  - nested item\n\n1. first\n\n> quoted words\n\n---", { width: 28 });
    expect(text(lines[0])).toBe("Title");
    expect(lines[0].spans[0]).toMatchObject({ bold: true, underline: true });
    for (const entry of lines) expect(text(entry).length).toBeLessThanOrEqual(28);
    expect(spans(lines).find((span) => span.text === "bold")).toMatchObject({ bold: true });
    expect(spans(lines).find((span) => span.text === "code")).toMatchObject({ color: "cyan" });
    expect(spans(lines).find((span) => span.text === "link")).toMatchObject({ underline: true });
    expect(spans(lines).some((span) => span.text.includes("<https://example.com/>"))).toBe(true);
    expect(lines.map(text)).toContain("• one");
    expect(lines.map(text)).toContain("• ☑ done");
    expect(lines.map(text)).toContain("  • nested item");
    expect(lines.map(text)).toContain("1. first");
    expect(lines.map(text).find((entry) => entry.startsWith("│ "))).toBe("│ quoted words");
    expect(lines.map(text)).toContain("─".repeat(28));
  });

  test("code blocks keep lines, highlight tokens, cut long lines, and stay bounded", () => {
    const { lines } = renderMarkdown("```js\nconst answer = 42; // why\n" + "y".repeat(120) + "\n```", { width: 40 });
    expect(text(lines[0])).toBe("  js");
    expect(spans(lines).find((span) => span.text === "const")).toMatchObject({ color: "magenta" });
    expect(spans(lines).find((span) => span.text === "42")).toMatchObject({ color: "yellow" });
    expect(spans(lines).find((span) => span.text.startsWith("// why"))).toMatchObject({ dim: true });
    const long = lines.find((entry) => text(entry).includes("yyyy"));
    expect(text(long).length).toBeLessThanOrEqual(40);
    expect(text(long).endsWith("…")).toBe(true);
    const many = renderMarkdown("```\n" + Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n") + "\n```", { width: 60 });
    expect(many.lines.length).toBeLessThanOrEqual(MAX_CODE_LINES + 2);
    expect(text(many.lines.at(-1))).toContain("140 more lines");
    const huge = renderMarkdown(Array.from({ length: 600 }, (_, i) => `paragraph ${i}`).join("\n\n"), { width: 60 });
    expect(huge.truncated).toBe(true);
    expect(huge.lines.length).toBe(MAX_LINES + 1);
  });

  test("tables align columns and clip to the width", () => {
    const { lines } = renderMarkdown("| name | value |\n|---|---:|\n| alpha | 1 |\n| a much longer cell than fits | 22 |", { width: 30 });
    expect(lines[0].spans[0]).toMatchObject({ bold: true });
    expect(text(lines[0]).startsWith("name")).toBe(true);
    expect(text(lines[1]).includes("───")).toBe(true);
    for (const entry of lines) expect(text(entry).length).toBeLessThanOrEqual(30);
    expect(text(lines[2]).trimEnd().endsWith("1")).toBe(true); // right-aligned numeric column
    expect(text(lines[3])).toContain("…");
  });

  test("control characters and escape sequences never reach the terminal", () => {
    const { lines } = renderMarkdown("hello [31mred[0m world\tand\r\n\n```sh\necho ]0;title\n```", { width: 60 });
    const all = lines.map(text).join("\n");
    // eslint-disable-next-line no-control-regex
    expect(all).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/);
    expect(all).toContain("hello red world and"); // complete escape sequences are removed
    expect(all).toContain("echo ");
    expect(all).not.toContain("]0;title");
  });
});

test("an ordered list renders the author's numbers, not a fresh count", () => {
  const { lines } = renderMarkdown("4. fourth\n5. fifth", { width: 30 });
  const rendered = lines.map((entry) => entry.spans.map((span) => span.text).join(""));
  expect(rendered).toContain("4. fourth");
  expect(rendered).toContain("5. fifth");
});
