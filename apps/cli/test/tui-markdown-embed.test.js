import { expect, test } from "bun:test";
import { renderMarkdown } from "../src/tui/markdown.js";

const text = (entry) => entry.spans.map((span) => span.text).join("");

test("a markdown fence renders as a document behind a gutter, and nesting stays bounded", () => {
  const { lines } = renderMarkdown("Here is the plan:\n\n```md\n# Plan\n\n- **first** step\n- second step\n\n```js\nconst x = 1;\n```\n```\n", { width: 40 });
  const rendered = lines.map(text);
  expect(rendered[0]).toBe("Here is the plan:");
  expect(rendered).toContain("  md");
  const plan = lines.find((entry) => text(entry) === "│ Plan");
  expect(plan).toBeDefined();
  expect(plan.spans.at(-1)).toMatchObject({ bold: true, underline: true });
  expect(rendered).toContain("│ • first step");
  expect(lines.flatMap((entry) => entry.spans).find((span) => span.text === "first")).toMatchObject({ bold: true });
  expect(lines.flatMap((entry) => entry.spans).find((span) => span.text === "const")).toMatchObject({ color: "magenta" }); // the nested js fence still highlights
  for (const entry of lines) expect(text(entry).length).toBeLessThanOrEqual(40);
  const deep = renderMarkdown("```md\n```md\n```md\n# Deep\n```\n```\n```", { width: 40 });
  expect(deep.lines.map(text).join("\n")).toContain("# Deep"); // beyond the nesting limit the fence stays source
});
