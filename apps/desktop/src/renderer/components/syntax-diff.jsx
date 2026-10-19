import { useMemo } from 'react';
import { fileHeaders } from '../diff-lines.js';
import { diffTokens } from '../diff-tokens.js';
import { SyntaxTokens } from './syntax-code.jsx';

export default function SyntaxDiff({ text, path, context = true }) {
  const lines = useMemo(() => diffTokens(text, path), [text, path]);
  const headers = useMemo(() => fileHeaders(text.split('\n')), [text]);
  return lines.map((line, index) => headers.has(index) ? headers.get(index) && <div className="diff-line meta" key={index}><code>{headers.get(index)}</code></div>
    : context || line.kind !== 'context' ? <div className={`diff-line ${line.kind}`} key={index}><code>{line.prefix}<SyntaxTokens nodes={line.tokens} /></code></div> : null);
}
