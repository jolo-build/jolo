import { lazy, Suspense, useMemo, useState } from "react";
import { parseDocument } from "@jolo/markdown";
import { MermaidDiagram } from "./mermaid.jsx";
import { Visualization } from './visualization.jsx';

const SyntaxCode = lazy(() => import("./syntax-code.jsx").catch(() => ({ default: ({ text }) => <code>{text}</code> })));

/** Safe React rendering of the shared markdown model (§5.1): no HTML, links open externally. */
function Inline({ nodes }) {
  return nodes.map((node, i) => {
    switch (node.type) {
      case "text": return node.text;
      // A span the model wrapped across lines is a block of code: keep its breaks so it stays copyable.
      case "code": return node.text.includes("\n")
        ? <code key={i} className="md-code-lines">{node.text.replace(/^\n+|\n+$/g, "")}</code>
        : <code key={i}>{node.text}</code>;
      case "strong": return <strong key={i}><Inline nodes={node.children} /></strong>;
      case "em": return <em key={i}><Inline nodes={node.children} /></em>;
      case "link": return <a key={i} href="#" title={node.href} onClick={(e) => { e.preventDefault(); window.jolo.openExternal(node.href); }}><Inline nodes={node.children} /></a>;
      default: return null;
    }
  });
}

const MARKDOWN_LANGUAGES = new Set(["md", "markdown", "mdx"]);
const MERMAID_LANGUAGES = new Set(["mermaid", "mmd"]);
const MAX_EMBED_DEPTH = 2;

/** A fence as code: highlighted, with its language named. */
function CodeBlock({ block }) {
  return <div className="md-code-block">{block.language && <div className="md-code-language">{block.language}</div>}<pre className="md-code" data-language={block.language ?? ""}><Suspense fallback={<code>{block.text}</code>}><SyntaxCode text={block.text} language={block.language} /></Suspense></pre></div>;
}

/** A markdown fence is a document, not code: render it, keep its source one click away. */
function MarkdownEmbed({ block, depth }) {
  const [source, setSource] = useState(false);
  return <div className="md-embed">
    <div className="md-code-language"><span>{block.language}</span><span className="grow" /><button type="button" className="md-embed-toggle" aria-pressed={source} onClick={() => setSource((value) => !value)}>{source ? "Rendered" : "Source"}</button></div>
    {source ? <pre className="md-code" data-language={block.language}><Suspense fallback={<code>{block.text}</code>}><SyntaxCode text={block.text} language={block.language} /></Suspense></pre> : <div className="md-embed-body"><Markdown text={block.text} cacheKey={block.text.length} depth={depth + 1} /></div>}
  </div>;
}

function Block({ block, depth, sessionId, streaming }) {
  switch (block.type) {
    case "heading": { const Tag = `h${Math.min(6, block.level + 2)}`; return <Tag><Inline nodes={block.children} /></Tag>; }
    case "paragraph": return <p><Inline nodes={block.children} /></p>;
    case 'visualization': return depth > 0 ? <p>Visualization: {block.path || 'incomplete reference'}</p> : <Visualization key={`${sessionId}:${block.path}`} block={block} sessionId={sessionId} streaming={streaming} />;
    case "code":
      if (block.language && MARKDOWN_LANGUAGES.has(block.language.toLowerCase()) && depth < MAX_EMBED_DEPTH) return <MarkdownEmbed block={block} depth={depth} />;
      // A diagram Jolo can draw is drawn; one it cannot read stays the code it was written as.
      if (block.language && MERMAID_LANGUAGES.has(block.language.toLowerCase())) return <MermaidDiagram block={block} fallback={<CodeBlock block={block} />} />;
      return <CodeBlock block={block} />;
    case "quote": return <blockquote><Inline nodes={block.children} /></blockquote>;
    case "rule": return <hr />;
    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      const start = block.ordered && (block.start ?? 1) !== 1 ? block.start : undefined;
      return <Tag start={start}>{block.items.map((item, i) => <li key={i} style={{ marginLeft: `${item.depth * 16}px` }} className={item.checked === null ? "" : item.checked ? "task done" : "task"}><Inline nodes={item.children} /></li>)}</Tag>;
    }
    case "table": return (
      <table>
        <thead><tr>{block.header.map((cell, i) => <th key={i} style={{ textAlign: block.align[i] }}><Inline nodes={cell} /></th>)}</tr></thead>
        <tbody>{block.rows.map((row, r) => <tr key={r}>{row.map((cell, c) => <td key={c} style={{ textAlign: block.align[c] }}><Inline nodes={cell} /></td>)}</tr>)}</tbody>
      </table>
    );
    default: return null;
  }
}

export function Markdown({ text, cacheKey, depth = 0, sessionId, streaming = false }) {
  const cache = useMemo(() => new Map(), [cacheKey]); // completed blocks are parsed once per message
  const { blocks } = useMemo(() => parseDocument(text, { cache }), [text, cache]);
  return <div className="md">{blocks.map((block, i) => <Block key={i} block={block} depth={depth} sessionId={sessionId} streaming={streaming} />)}</div>;
}
