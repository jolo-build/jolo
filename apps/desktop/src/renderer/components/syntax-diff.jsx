import { useMemo } from 'react';
import { numberedDiffLines } from '../diff-lines.js';
import { diffTokens } from '../diff-tokens.js';
import { SyntaxTokens } from './syntax-code.jsx';

export default function SyntaxDiff({ text, path, context = true }) {
  const lines = useMemo(() => { const numbers = numberedDiffLines(text); return diffTokens(text, path).map((line, index) => ({ ...line, before: numbers[index].before, after: numbers[index].after })); }, [text, path]);
  return lines.map((line, index) => context || line.kind !== 'context'
    ? <div className={`diff-line ${line.kind}`} key={index}><span className="diff-number">{line.before}</span><span className="diff-number">{line.after}</span><code>{line.prefix}<SyntaxTokens nodes={line.tokens} /></code></div> : null);
}
