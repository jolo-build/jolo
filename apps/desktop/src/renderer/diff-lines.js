/** How one line of a unified diff should read (§5.2): the same classes wherever a diff is shown. */
export function diffLineKind(line) {
  if (line.startsWith("@@")) return "hunk";
  if (/^(diff |index |--- |\+\+\+ |rename |Binary file |File |… )/.test(line)) return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "remove";
  return "context";
}

/** The lines git spends introducing a file; wherever a diff is shown, the file's name stands in for them. */
export const isFileHeader = line => /^(diff --git |index |--- |\+\+\+ |new file mode |deleted file mode |similarity index )/.test(line);

/**
 * The file headers of a diff by line index, outside any hunk: each maps to null (drawn as nothing), except the
 * "diff --git" line of a diff that spans several files, which maps to that file's name.
 * @param {string[]} lines
 */
export function fileHeaders(lines) {
  const several = lines.filter(line => line.startsWith("diff --git ")).length > 1;
  /** @type {Map<number, string | null>} */
  const headers = new Map();
  let header = true;
  lines.forEach((line, index) => {
    if (line.startsWith("diff --git ")) header = true;
    else if (line.startsWith("@@")) header = false;
    if (!header || !isFileHeader(line)) return;
    headers.set(index, several && line.startsWith("diff --git ") ? line.match(/^diff --git a\/(.+) b\/(.+)$/)?.[2] ?? line.slice(11) : null);
  });
  return headers;
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
  return { files: files.size, paths: [...files], added, removed };
}
