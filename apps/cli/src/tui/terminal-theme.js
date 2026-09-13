// xterm OSC 10/11 set the terminal canvas, including unused rows. Capture the
// original dynamic colors before Ink owns stdin, and restore them on every exit.
const osc = (code, value) => `\x1b]${code}${value === undefined ? '' : `;${value}`}\x1b\\`;

/**
 * @param {import('node:stream').Readable & { isTTY?: boolean }} [stdin]
 * @param {{ isTTY?: boolean, write: (text: string) => unknown }} [stdout]
 * @param {Record<string, string | undefined>} [env]
 */
export async function terminalTheme(stdin = process.stdin, stdout = process.stdout, env = process.env) {
  if (!stdin.isTTY || !stdout.isTTY || (env.NO_COLOR && !env.FORCE_COLOR) || env.TERM === 'dumb' || env.FORCE_COLOR === '0') return { apply: (_theme) => {}, restore: () => {} };
  const original = await new Promise((resolve) => {
    let pending = '';
    const colors = {};
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      stdin.off('readable', readable); stdin.off('end', finish);
      if (pending && !stdin.readableEnded) stdin.unshift(Buffer.from(pending, 'latin1'));
      resolve(colors);
    };
    const readable = () => {
      let chunk;
      while (!finished && (chunk = stdin.read()) !== null) {
        pending += Buffer.from(chunk).toString('latin1');
        pending = pending.replace(/\x1b\](10|11);(rgb:[0-9a-f]{1,4}\/[0-9a-f]{1,4}\/[0-9a-f]{1,4}|#[0-9a-f]{6})(?:\x07|\x1b\\)/gi, (_match, code, color) => { colors[code] = color; return ''; });
        if ((colors[10] && colors[11]) || pending.length >= 64 * 1024) finish();
      }
    };
    const timer = setTimeout(finish, 200);
    stdin.on('readable', readable); stdin.once('end', finish);
    stdout.write(osc(10, '?') + osc(11, '?'));
  });
  let current = '';
  const restore = () => {
    if (!current) return;
    stdout.write([10, 11].map((code) => original[code] ? osc(code, original[code]) : osc(code + 100, undefined)).join(''));
    current = '';
  };
  return {
    apply(theme) {
      if (theme.id === 'terminal') { restore(); return; }
      const next = osc(10, theme.colors.text) + osc(11, theme.colors.background);
      if (next !== current) { stdout.write(next); current = next; }
    },
    restore,
  };
}
