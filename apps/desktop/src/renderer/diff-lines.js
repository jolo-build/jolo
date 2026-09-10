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
