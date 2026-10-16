import { Fragment, useLayoutEffect, useMemo } from 'react';
import { codeTokens } from '../code-tokens.js';
import { languageForPath, tokenLines } from '../diff-tokens.js';
import { SyntaxTokens } from './syntax-code.jsx';

export default function SyntaxFile({ file, selected }) {
  const lines = useMemo(() => tokenLines(codeTokens(file.text, languageForPath(file.path))), [file.text, file.path]);
  useLayoutEffect(() => { selected.current?.scrollIntoView({ block: 'center', inline: 'center' }); }, [file, selected]);
  return <pre className="file-preview-source"><code>{lines.map((tokens, index) => <Fragment key={index}><span className="file-source-line" data-line={index + 1}><span className={file.line === index + 1 ? 'file-source-location' : undefined}>{file.line === index + 1 && <span ref={selected} className="file-source-caret" style={{ left: `${Math.min(Math.max(0, (file.column ?? 1) - 1), file.text.split('\n')[index].length)}ch` }} />}<SyntaxTokens nodes={tokens} /></span></span>{index < lines.length - 1 ? '\n' : ''}</Fragment>)}</code></pre>;
}
