// Syntax tokens for code blocks, shared by the desktop renderer and the terminal client. Prism's tokenizer
// only: never its HTML renderer, DOM highlighter, or autoloader. Output is a plain tree of
// { kinds, children } that each client styles itself, bounded so a hostile block cannot stall a render.
import Prism from "prismjs/components/prism-core.js";
import "prismjs/components/prism-markup.js";
import "prismjs/components/prism-css.js";
import "prismjs/components/prism-clike.js";
import "prismjs/components/prism-javascript.js";
import "prismjs/components/prism-typescript.js";
import "prismjs/components/prism-jsx.js";
import "prismjs/components/prism-tsx.js";
import "prismjs/components/prism-python.js";
import "prismjs/components/prism-bash.js";
import "prismjs/components/prism-json.js";
import "prismjs/components/prism-yaml.js";
import "prismjs/components/prism-sql.js";
import "prismjs/components/prism-go.js";
import "prismjs/components/prism-rust.js";
import "prismjs/components/prism-c.js";
import "prismjs/components/prism-cpp.js";
import "prismjs/components/prism-java.js";
import "prismjs/components/prism-diff.js";
import "prismjs/components/prism-markdown.js";
import "prismjs/components/prism-docker.js";

Prism.manual = true;
const ALIASES = Object.freeze({ js: "javascript", mjs: "javascript", cjs: "javascript", ts: "typescript", py: "python", python3: "python", sh: "bash", shell: "bash", zsh: "bash", shellscript: "bash", yml: "yaml", rs: "rust", md: "markdown", mdx: "markdown", "c++": "cpp", golang: "go", htm: "markup", html: "markup", xml: "markup", svg: "markup", jsonc: "json", json5: "json" });
export const MAX_HIGHLIGHT_CHARS = 24 * 1024;
const MAX_NODES = 8192;
const MAX_NESTING = 2;

/** Resolve a fence label to a grammar; null when the language is unknown so callers show plain text. */
export function grammarFor(language) {
  const name = String(language ?? "").trim().toLowerCase();
  const resolved = ALIASES[name] ?? name;
  const grammar = resolved && Object.hasOwn(Prism.languages, resolved) ? Prism.languages[resolved] : null;
  return grammar && typeof grammar === "object" ? { name: resolved, grammar } : null;
}

/**
 * Markdown fences carry their own language. Prism only labels them for its HTML renderer, so tokenize the
 * body here with the fence's grammar; a markdown fence inside markdown stays plain to bound the work.
 */
function tokenizeFences(tokens, depth) {
  for (const token of tokens) {
    if (typeof token === "string") continue;
    if (token.type === "code" && Array.isArray(token.content)) {
      const block = token.content.find((part) => typeof part !== "string" && part.type === "code-block");
      const label = token.content.find((part) => typeof part !== "string" && part.type === "code-language");
      if (block && typeof block.content === "string" && typeof label?.content === "string" && depth < MAX_NESTING) {
        const inner = grammarFor((/[a-z][\w+#-]*/i.exec(label.content) || [""])[0]);
        if (inner && inner.name !== "markdown") { block.content = Prism.tokenize(block.content, inner.grammar); block.alias = [`language-${inner.name}`]; }
      }
      continue;
    }
    if (Array.isArray(token.content)) tokenizeFences(token.content, depth + 1);
  }
}

/**
 * @param {string} text
 * @param {string | null | undefined} language fence label as written by the model
 * @returns {Array<string | { kinds: string[], children: any[] }>} plain strings and styled nodes
 */
export function codeTokens(text, language) {
  const found = grammarFor(language);
  if (!found || text.length > MAX_HIGHLIGHT_CHARS) return [text];
  try {
    const tokens = Prism.tokenize(text, found.grammar);
    if (found.name === "markdown") tokenizeFences(tokens, 0);
    let count = 0;
    const project = (list) => (Array.isArray(list) ? list : [list]).map((token) => {
      if (++count > MAX_NODES) throw new Error("highlight node budget exceeded");
      if (typeof token === "string") return token;
      const kinds = [token.type, ...(Array.isArray(token.alias) ? token.alias : token.alias ? [token.alias] : [])];
      return { kinds, children: project(token.content) };
    });
    return project(tokens);
  } catch {
    return [text]; // Incomplete or unusual syntax must never prevent reading or copying a response.
  }
}
