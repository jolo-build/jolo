import { describe, expect, test } from "bun:test";
import { codeTokens, grammarFor, MAX_HIGHLIGHT_CHARS } from "@jolo/markdown/tokens";

const kindsOf = (nodes, out = []) => { for (const node of nodes) if (typeof node !== "string") { out.push(node.kinds); kindsOf(node.children, out); } return out; };
const textOf = (nodes) => nodes.map((node) => (typeof node === "string" ? node : textOf(node.children))).join("");

describe("shared code tokens", () => {
  test("markdown fences highlight their nested language and keep every character", () => {
    const source = "# Title\n\nSome **bold** text with `code` and a [link](https://example.com).\n\n```js\nconst answer = 42; // why\n```\n";
    const tokens = codeTokens(source, "md");
    expect(textOf(tokens)).toBe(source);
    const kinds = kindsOf(tokens).flat();
    expect(kinds).toContain("title");
    expect(kinds).toContain("bold");
    expect(kinds).toContain("code-snippet");
    expect(kinds).toContain("url");
    expect(kinds).toContain("language-javascript"); // the fence body was tokenized with the fence's grammar
    expect(kinds).toContain("keyword");
    expect(kinds).toContain("comment");
    expect(textOf(codeTokens(source, "markdown"))).toBe(source);
  });

  test("aliases resolve, unknown languages pass through, and oversized input is left alone", () => {
    expect(grammarFor("py").name).toBe("python");
    expect(grammarFor("sh").name).toBe("bash");
    expect(grammarFor("c++").name).toBe("cpp");
    expect(grammarFor("html").name).toBe("markup");
    expect(grammarFor("nope")).toBeNull();
    expect(codeTokens("plain text", "nope")).toEqual(["plain text"]);
    expect(codeTokens("plain text", null)).toEqual(["plain text"]);
    const big = "x".repeat(MAX_HIGHLIGHT_CHARS + 1);
    expect(codeTokens(big, "js")).toEqual([big]);
    expect(kindsOf(codeTokens("SELECT 1 FROM t;", "sql")).flat()).toContain("keyword");
  });
});
