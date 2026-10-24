import { useEffect, useState } from 'react';
import { Icon } from './icon.jsx';

/**
 * Copies `text` on click: a check while it is copied (two seconds), and a retry title if the clipboard refused it. A
 * change of `text` (a streamed reply growing) returns it to Copy, so it never claims newer text was copied.
 * @param {{ text: string, label: string, title?: string, className?: string, size?: number }} props
 */
export function CopyButton({ text, label, title = 'Copy', className = undefined, size = 14 }) {
  const [result, setResult] = useState({ text: null, status: 'idle' });
  const status = result.text === text ? result.status : 'idle';
  useEffect(() => {
    if (result.status !== 'copied') return;
    const timer = setTimeout(() => setResult({ text: null, status: 'idle' }), 2000);
    return () => clearTimeout(timer);
  }, [result]);
  return <button type="button" className={className} aria-label={label}
    title={status === 'failed' ? 'Could not copy. Click to try again.' : title}
    disabled={result.status === 'copying'} onClick={async () => {
      setResult({ text, status: 'copying' });
      try {
        await navigator.clipboard.writeText(text);
        setResult({ text, status: 'copied' });
      } catch { setResult({ text, status: 'failed' }); }
    }}>
    <Icon name={status === 'copied' ? 'check' : 'copy'} size={size} />
    <span className="sr-only" aria-live="polite">{status === 'copied' ? 'Copied' : status === 'failed' ? 'Retry copy' : 'Copy'}</span>
  </button>;
}
