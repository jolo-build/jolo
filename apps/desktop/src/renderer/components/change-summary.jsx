import { useEffect, useRef, useState } from 'react';
import { diffSummary } from '../diff-lines.js';
import { changeKey } from '../presentation.js';
import { Icon } from './icon.jsx';

function LineCounts({ added, removed, truncated = false }) {
  return <span className="change-summary-counts" title={truncated ? 'At least these many lines; the diff was truncated.' : `${added} lines added, ${removed} lines removed`}>
    <span className="diff-added">+{added}{truncated ? '+' : ''}</span>
    <span className="diff-removed">−{removed}{truncated ? '+' : ''}</span>
  </span>;
}

/** Reuse the review panel's bounded diffs; cache counts until a file's revision changes. */
export function ChangeSummary({ files, onLoadDiff, onReview, frozen = false, initialCounts = [], onCounts = null, runId = null }) {
  const [expanded, setExpanded] = useState(false);
  const [counts, setCounts] = useState(() => new Map(initialCounts));
  const cache = useRef(new Map(initialCounts));
  const reportCounts = useRef(onCounts);
  reportCounts.current = onCounts;
  const revision = JSON.stringify(files.map(file => [file.newPath ?? file.path, changeKey(file)]));
  useEffect(() => {
    let cancelled = false;
    const entries = JSON.parse(revision);
    const current = new Map(entries.filter(([, key]) => cache.current.has(key)).map(([, key]) => [key, cache.current.get(key)]));
    cache.current = current;
    setCounts(new Map(current));
    // Old replies retain their counts; later turns must never reread their paths.
    if (frozen) return;
    const queue = entries.filter(([, key]) => !current.has(key));
    const work = async () => {
      while (!cancelled && queue.length) {
        const [path, key] = queue.shift();
        let result;
        try {
          const diff = await onLoadDiff(path);
          result = diff.source === 'none' ? { unavailable: true }
            : { ...diffSummary(diff.diff), binary: /^Binary files? /m.test(diff.diff), truncated: diff.truncated };
        } catch { result = { unavailable: true }; }
        if (cancelled) return;
        current.set(key, result);
        setCounts(new Map(current));
        reportCounts.current?.([...current]);
      }
    };
    // Coalesce streamed edits and bound concurrent file reads.
    const timer = setTimeout(() => { for (let i = 0; i < Math.min(4, entries.length); i++) void work(); }, 150);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [revision, onLoadDiff, frozen]);
  const stats = files.map(file => counts.get(changeKey(file)));
  const pending = !frozen && stats.some(stat => !stat);
  const unavailable = stats.some(stat => stat?.unavailable || (frozen && !stat));
  const totals = stats.reduce((sum, stat) => ({ added: sum.added + (stat?.added ?? 0), removed: sum.removed + (stat?.removed ?? 0), truncated: sum.truncated || Boolean(stat?.truncated) }), { added: 0, removed: 0, truncated: false });
  const visible = expanded ? files : files.slice(0, 3);
  if (!files.length) return null;
  return <section className="change-summary" aria-label="Changed files" data-run-id={runId}>
    <div className="change-summary-header">
      <span className="change-summary-icon"><Icon name="fileDiff" size={21} /></span>
      <div className="change-summary-heading"><strong>Changed {files.length} {files.length === 1 ? 'file' : 'files'}</strong>
        {pending || unavailable ? <span className="change-summary-status">{pending ? 'Calculating changes…' : 'Line counts unavailable'}</span> : <LineCounts {...totals} />}
      </div>
      <button type="button" className="change-summary-review" title="Review current working changes" onClick={onReview}><Icon name="fileDiff" size={14} />Review</button>
    </div>
    <ul className="change-summary-files">{visible.map(file => {
      const stat = counts.get(changeKey(file));
      const label = file.newPath ? `${file.path} → ${file.newPath}` : file.path;
      return <li key={file.newPath ?? file.path}><span className="change-summary-path" title={label}>{label}</span>
        {!stat && !frozen ? <span className="muted" aria-label="Calculating line counts">…</span> : !stat || stat.unavailable ? <span className="muted" title="Line counts unavailable">—</span> : stat.binary ? <span className="muted">Binary</span> : <LineCounts {...stat} />}
      </li>;
    })}</ul>
    {files.length > 3 && <button type="button" className="change-summary-toggle" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      <span>{expanded ? 'Show fewer files' : `Show ${files.length - 3} more ${files.length === 4 ? 'file' : 'files'}`}</span><Icon name={expanded ? 'down' : 'chevron'} size={13} />
    </button>}
  </section>;
}
