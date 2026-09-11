import { memo, useDeferredValue, useMemo } from "react";
import { codeTokens } from "../code-tokens.js";

export function SyntaxTokens({ nodes }) {
  return nodes.map((node, index) => typeof node === "string" ? node : <span key={index} className={`syntax-token ${node.kinds.join(" ")}`}><SyntaxTokens nodes={node.children} /></span>);
}

// A fence that names no language is still highlighted, as plain text.
export default memo(function SyntaxCode(/** @type {{ text: string, language?: string }} */ { text, language }) {
  const deferred = useDeferredValue(text);
  const tokens = useMemo(() => codeTokens(deferred, language), [deferred, language]);
  return <code>{deferred === text ? <SyntaxTokens nodes={tokens} /> : text}</code>;
});
