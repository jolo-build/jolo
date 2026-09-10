import { Icon } from './icon.jsx';
export function ChecksPanel({ verification }) {
  const checks = verification?.checks ?? [];
  return <div className="checks-panel">
    {!checks.length && <p className="muted">No verification commands have run for this task yet.</p>}
    {verification?.status === 'stale' && <p className="muted">Files changed after these checks. Run verification again before relying on them.</p>}
    {checks.map((check) => <div className="check-row" key={check.invocationId}><Icon name={check.exitCode === 0 ? 'check' : 'close'} className={check.exitCode === 0 ? 'good' : 'negative'} /><code>{check.argv.join(' ') || 'Shell command'}</code><span className="muted">{check.exitCode === null ? check.signal ?? 'Interrupted' : `Exit ${check.exitCode}`}</span></div>)}
  </div>;
}
