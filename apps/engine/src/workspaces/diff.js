// Unified diffs of what a patch changed.
//
// Written here rather than taken from git, because a transcript needs the change *this* call made at the
// moment it made it: the working tree moves on, the repository may have no commits, and several calls can
// touch one file in a run. The patch transaction already holds both sides in memory, so the diff costs
// nothing extra to produce and is stored beside the preimages it was computed from.
//
// Everything here is bounded. A file too large, too binary, or too different to diff cheaply is reported as
// a line saying so, which is honest and small, rather than a diff nobody asked to scroll through.

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_EDIT_SCRIPT = 3_000; // how far Myers will look before the change is called wholesale
const CONTEXT = 3;
export const MAX_DIFF_LINES = 500;

const binary = (buffer) => buffer.subarray(0, 8_000).includes(0);

/** Lines as a diff counts them, remembering whether the file ended with a newline. */
function lines(buffer) {
  const text = buffer.toString("utf8");
  if (text === "") return { rows: [], newlineAtEof: true };
  const newlineAtEof = text.endsWith("\n");
  const rows = text.split("\n");
  if (newlineAtEof) rows.pop();
  return { rows, newlineAtEof };
}

/**
 * Myers' difference algorithm: the shortest edit script between two lists of lines. Returns null when the
 * two are more different than the caller is willing to pay for.
 */
export function editScript(a, b, maxEdits = MAX_EDIT_SCRIPT) {
  const n = a.length;
  const m = b.length;
  const max = Math.min(maxEdits, n + m);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace = [];
  for (let d = 0; d <= max; d += 1) {
    trace.push(Int32Array.prototype.slice.call(v));
    for (let k = -d; k <= d; k += 2) {
      const index = k + offset;
      let x = k === -d || (k !== d && v[index - 1] < v[index + 1]) ? v[index + 1] : v[index - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x += 1; y += 1; }
      v[index] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, d, offset);
    }
  }
  return null;
}

/** Walk the saved traces backwards, turning them into the operations that made the change. */
function backtrack(trace, a, b, d, offset) {
  const ops = [];
  let x = a.length;
  let y = b.length;
  for (let step = d; step > 0; step -= 1) {
    const v = trace[step];
    const k = x - y;
    const index = k + offset;
    const down = k === -step || (k !== step && v[index - 1] < v[index + 1]);
    const previousK = down ? k + 1 : k - 1;
    const startX = v[previousK + offset];
    const startY = startX - previousK;
    while (x > startX && y > startY) { ops.push({ op: " ", text: a[x - 1] }); x -= 1; y -= 1; }
    if (down) { ops.push({ op: "+", text: b[y - 1] }); y -= 1; }
    else { ops.push({ op: "-", text: a[x - 1] }); x -= 1; }
  }
  while (x > 0 && y > 0) { ops.push({ op: " ", text: a[x - 1] }); x -= 1; y -= 1; }
  return ops.reverse();
}

/** Group operations into hunks, keeping a few unchanged lines either side for the reader's bearings. */
function hunks(ops) {
  const changed = [];
  ops.forEach((entry, index) => { if (entry.op !== " ") changed.push(index); });
  if (!changed.length) return [];
  const groups = [[changed[0], changed[0]]];
  for (const index of changed.slice(1)) {
    const current = groups.at(-1);
    // Two changes closer than twice the context share a hunk rather than repeating the lines between them.
    if (index - current[1] > CONTEXT * 2) groups.push([index, index]);
    else current[1] = index;
  }
  return groups.map(([first, last]) => ({ from: Math.max(0, first - CONTEXT), to: Math.min(ops.length - 1, last + CONTEXT) }));
}

const header = ({ op, path, newPath }) => {
  const target = newPath ?? path;
  return [
    `diff --git a/${path} b/${target}`,
    op === "create" ? "--- /dev/null" : `--- a/${path}`,
    op === "delete" ? "+++ /dev/null" : `+++ b/${target}`,
  ];
};

/**
 * One file's change as a unified diff.
 * @param {{ path: string, newPath?: string|null, op: string, before: Buffer|null, after: Buffer|null }} file
 * @returns {string[]} lines, including the header
 */
export function fileDiff(file) {
  const { path, newPath, op } = file;
  const before = file.before ?? Buffer.alloc(0);
  const after = file.after ?? Buffer.alloc(0);
  const target = newPath ?? path;
  if (before.equals(after)) return op === "rename" ? [`diff --git a/${path} b/${target}`, `rename from ${path}`, `rename to ${target}`] : [];
  if (binary(before) || binary(after)) return [...header(file), `Binary file ${target} changed`];
  if (before.length > MAX_FILE_BYTES || after.length > MAX_FILE_BYTES) return [...header(file), `File ${target} is too large to diff here; review it in the changes panel`];

  const left = lines(before);
  const right = lines(after);
  const ops = editScript(left.rows, right.rows);
  const out = header(file);
  if (!ops) {
    // Beyond the effort budget: say what happened in numbers rather than line by line.
    out.push(`@@ -1,${left.rows.length} +1,${right.rows.length} @@`, `${target} was rewritten (${left.rows.length} lines replaced by ${right.rows.length})`);
    return out;
  }
  let oldLine = 1;
  let newLine = 1;
  const positions = ops.map((entry) => {
    const at = { old: oldLine, new: newLine };
    if (entry.op !== "+") oldLine += 1;
    if (entry.op !== "-") newLine += 1;
    return at;
  });
  for (const group of hunks(ops)) {
    const slice = ops.slice(group.from, group.to + 1);
    const oldCount = slice.filter((entry) => entry.op !== "+").length;
    const newCount = slice.filter((entry) => entry.op !== "-").length;
    const start = positions[group.from];
    out.push(`@@ -${oldCount ? start.old : start.old - 1},${oldCount} +${newCount ? start.new : start.new - 1},${newCount} @@`);
    for (const entry of slice) out.push(`${entry.op}${entry.text}`);
  }
  if (left.rows.length && !left.newlineAtEof) out.push("\\ No newline at end of file");
  return out;
}

/**
 * Every file a patch touched, as one diff.
 * @param {Array<{ path: string, newPath?: string|null, op: string, before: Buffer|null, after: Buffer|null }>} files
 * @returns {{ text: string, truncated: boolean, files: number }}
 */
export function patchDiff(files, { maxLines = MAX_DIFF_LINES } = {}) {
  const out = [];
  let truncated = false;
  let touched = 0;
  for (const file of files) {
    const rows = fileDiff(file);
    if (!rows.length) continue;
    touched += 1;
    if (out.length + rows.length > maxLines) {
      out.push(...rows.slice(0, Math.max(0, maxLines - out.length)));
      truncated = true;
      break;
    }
    out.push(...rows);
  }
  if (truncated) out.push(`… diff truncated at ${maxLines} lines; the rest is in the changes panel`);
  return { text: out.join("\n"), truncated, files: touched };
}
