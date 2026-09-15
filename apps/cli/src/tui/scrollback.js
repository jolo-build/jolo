import chalk from 'chalk';
import { themeColor } from '../themes/palettes.js';

/** Emit logical lines, so the terminal can reflow paragraphs when its width changes. */
export function scrollbackText(lines, theme) {
  const themed = theme.id !== 'terminal';
  return lines.map((entry, index) => {
    const continued = index > 0 && entry.continuation != null;
    let indent = continued ? entry.continuationIndent ?? 0 : 0;
    const text = entry.spans.map(span => {
      const skip = Math.min(indent, span.text.length);
      indent -= skip;
      let text = span.text.slice(skip);
      const role = themed ? span.themeRole ?? span.color : span.color;
      const color = role ? themeColor(theme, role) : span.dim && themed ? theme.colors.muted : undefined;
      if (color?.startsWith('#')) text = chalk.hex(color)(text);
      else if (color && typeof chalk[color] === 'function') text = chalk[color](text);
      if (span.bold) text = chalk.bold(text);
      if (span.dim && !themed) text = chalk.dim(text);
      if (span.italic) text = chalk.italic(text);
      if (span.underline) text = chalk.underline(text);
      return text;
    }).join('');
    return (index === 0 ? '' : continued ? entry.continuation : '\n') + text;
  }).join('') + '\n';
}
