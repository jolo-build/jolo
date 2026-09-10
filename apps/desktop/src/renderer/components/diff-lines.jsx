import { lazy, Suspense, memo } from 'react';
import { diffLineKind } from '../diff-lines.js';

function PlainDiff({ text, context = true }) {
  return text.split('\n').map((line, index) => {
    const kind = diffLineKind(line);
    return context || kind !== 'context' ? <div className={`diff-line ${kind}`} key={index}><code>{line}</code></div> : null;
  });
}
const HighlightedDiff = lazy(() => import('./syntax-diff.jsx').catch(() => ({ default: PlainDiff })));

export const DiffLines = memo(function DiffLines(props) {
  return <Suspense fallback={<PlainDiff {...props} />}><HighlightedDiff {...props} /></Suspense>;
});
