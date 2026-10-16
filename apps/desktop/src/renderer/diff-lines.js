/** How one line of a unified diff should read (§5.2): the same classes wherever a diff is shown. */
export function diffLineKind(line) {
  if (line.startsWith("@@")) return "hunk";
  if (/^(diff |index |--- |\+\+\+ |rename |Binary file |File |… )/.test(line)) return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "remove";
  return "context";
}

/** What a set of changes did, in a few words: "2 files · +12 −3". */
export function diffSummary(text) {
  let added = 0;
  let removed = 0;
  const files = new Set();
  for (const line of text.split("\n")) {
    const renamed = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (renamed) { files.add(renamed[2]); continue; }
    if (line.startsWith("+++ b/")) files.add(line.slice(6));
    else if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  }
  return { files: files.size, added, removed };
}

/** Real source line numbers reset at each hunk; metadata and truncated tails have none. */
export function numberedDiffLines(text) {
  let before = 0, after = 0, beforeLeft = 0, afterLeft = 0;
  return text.split('\n').map(text => {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text);
    if (header) {
      before = Number(header[1]); after = Number(header[3]);
      beforeLeft = Number(header[2] ?? 1); afterLeft = Number(header[4] ?? 1);
      return { text, kind: 'hunk', before: null, after: null };
    }
    if ((beforeLeft > 0 || afterLeft > 0) && /^[ +\-]/.test(text)) {
      const kind = text[0] === '+' ? 'add' : text[0] === '-' ? 'remove' : 'context';
      const row = { text, kind, before: kind === 'add' ? null : before++, after: kind === 'remove' ? null : after++ };
      if (kind !== 'add') beforeLeft--;
      if (kind !== 'remove') afterLeft--;
      return row;
    }
    if (!text.startsWith('\\ No newline')) beforeLeft = afterLeft = 0;
    return { text, kind: diffLineKind(text), before: null, after: null };
  });
}
