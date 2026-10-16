import { lazy, Suspense, memo } from 'react';
import { numberedDiffLines } from '../diff-lines.js';

function PlainDiff({ text, context = true }) {
  return numberedDiffLines(text).map((line, index) => {
    const kind = line.kind;
    return context || kind !== 'context' ? <div className={`diff-line ${kind}`} key={index}><span className="diff-number">{line.before}</span><span className="diff-number">{line.after}</span><code>{line.text}</code></div> : null;
  });
}
// Both halves of this pair take the same props, so name them once: the highlighter and the plain
// fallback are interchangeable from the caller's side.
/** @typedef {{ text: string, path?: string, context?: boolean }} DiffLinesProps */
/** @type {import('react').LazyExoticComponent<import('react').ComponentType<DiffLinesProps>>} */
const HighlightedDiff = lazy(() => import('./syntax-diff.jsx').catch(() => ({ default: PlainDiff })));

// `path` only chooses the grammar; a diff without one is still shown.
export const DiffLines = memo(function DiffLines(/** @type {DiffLinesProps} */ props) {
  return <div className="diff-lines"><Suspense fallback={<PlainDiff {...props} />}><HighlightedDiff {...props} /></Suspense></div>;
});
