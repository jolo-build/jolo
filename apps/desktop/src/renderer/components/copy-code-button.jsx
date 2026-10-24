import { CopyButton } from './copy-button.jsx';

/** Copy the fence's source, preserving whitespace and excluding its controls. */
export function CopyCodeButton({ text, language = '' }) {
  return <CopyButton className="md-code-copy" label="Copy code to clipboard" title={`Copy ${language || 'code'}`} text={text} />;
}
