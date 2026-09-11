import { lazy, Suspense, memo } from 'react';
import { diffLineKind } from '../diff-lines.js';

function PlainDiff({ text, context = true }) {
  return text.split('\n').map((line, index) => {
    const kind = diffLineKind(line);
    return context || kind !== 'context' ? <div className={`diff-line ${kind}`} key={index}><code>{line}</code></div> : null;
  });
}
// Both halves of this pair take the same props, so name them once: the highlighter and the plain
// fallback are interchangeable from the caller's side.
/** @typedef {{ text: string, path?: string, context?: boolean }} DiffLinesProps */
/** @type {import('react').LazyExoticComponent<import('react').ComponentType<DiffLinesProps>>} */
const HighlightedDiff = lazy(() => import('./syntax-diff.jsx').catch(() => ({ default: PlainDiff })));

// `path` only chooses the grammar; a diff without one is still shown.
export const DiffLines = memo(function DiffLines(/** @type {DiffLinesProps} */ props) {
  return <Suspense fallback={<PlainDiff {...props} />}><HighlightedDiff {...props} /></Suspense>;
});
