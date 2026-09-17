import { useEffect, useState } from 'react';
import { Icon } from './icon.jsx';

/** Copy the fence's source, preserving whitespace and excluding its controls. */
export function CopyCodeButton({ text }) {
  const [result, setResult] = useState({ text: null, status: 'idle' });
  const status = result.text === text ? result.status : 'idle';
  useEffect(() => {
    if (result.status !== 'copied') return;
    const timer = setTimeout(() => setResult({ text: null, status: 'idle' }), 2000);
    return () => clearTimeout(timer);
  }, [result]);
  return <button type="button" className="md-code-copy" aria-label="Copy code to clipboard"
    title={status === 'failed' ? 'Could not copy. Click to try again.' : 'Copy to clipboard'}
    disabled={result.status === 'copying'} onClick={async () => {
      setResult({ text, status: 'copying' });
      try {
        await navigator.clipboard.writeText(text);
        setResult({ text, status: 'copied' });
      } catch { setResult({ text, status: 'failed' }); }
    }}>
    <Icon name={status === 'copied' ? 'check' : 'copy'} size={13} />
    <span aria-live="polite">{status === 'copied' ? 'Copied' : status === 'failed' ? 'Retry copy' : 'Copy'}</span>
  </button>;
}
