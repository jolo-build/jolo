import { useMemo } from 'react';
import { diffTokens } from '../diff-tokens.js';
import { SyntaxTokens } from './syntax-code.jsx';

export default function SyntaxDiff({ text, path, context = true }) {
  const lines = useMemo(() => diffTokens(text, path), [text, path]);
  return lines.map((line, index) => context || line.kind !== 'context'
    ? <div className={`diff-line ${line.kind}`} key={index}><code>{line.prefix}<SyntaxTokens nodes={line.tokens} /></code></div> : null);
}
