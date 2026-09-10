import { expect, test } from "bun:test";
import { codeTokens, MAX_HIGHLIGHT_CHARS } from "./code-tokens.js";

const textOf = (nodes) => nodes.map((node) => typeof node === "string" ? node : textOf(node.children)).join("");
const kindsOf = (nodes) => nodes.flatMap((node) => typeof node === "string" ? [] : [...node.kinds, ...kindsOf(node.children)]);

test("Python highlighting recognizes imports, comments, docstrings, classes and methods without changing code", () => {
  const source = '#!/usr/bin/env python3\n"""GitHub search helper"""\nimport requests\n\nclass GitHubSearcher:\n    def search(self, query):\n        return 42\n';
  const tokens = codeTokens(source, "python");
  expect(textOf(tokens)).toBe(source);
  expect(kindsOf(tokens)).toEqual(expect.arrayContaining(["comment", "string", "keyword", "class-name", "function", "number"]));
  expect(codeTokens(source, "py")).toEqual(tokens);
});

test("language aliases and partial streaming code preserve exact text", () => {
  for (const [language, source] of [["js", 'const message = "<script>";'], ["tsx", 'const view = <div title="Hi">{name}</div>'], ["sh", 'echo "$HOME"'], ["json", '{"ok": true}'], ["python", 'def search(query):\n    return "unfinished']]) {
    const tokens = codeTokens(source, language);
    expect(textOf(tokens)).toBe(source);
    expect(kindsOf(tokens).length).toBeGreaterThan(0);
  }
});

test("unknown languages and oversized blocks remain readable plain text", () => {
  for (const language of [null, "unknown", "__proto__", "constructor"]) expect(codeTokens('<img src=x onerror="alert(1)">', language)).toEqual(['<img src=x onerror="alert(1)">']);
  const large = "x".repeat(MAX_HIGHLIGHT_CHARS + 1);
  expect(codeTokens(large, "python")).toEqual([large]);
});
