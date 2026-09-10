// Read-only file tools: list_files, read_file, search_text.
import { closeSync, openSync, readSync, readdirSync, statSync, lstatSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { ProtocolError, SearchTextParams } from "@jolo/protocol";
import { resolveWorkspacePath, WorkspacePathError } from "./paths.js";
import { SEARCH_FILE_MAX_BYTES } from '../search/tgrep.js';

const LIST_MAX_ENTRIES = 500;
const LIST_MAX_BYTES = 128 * 1024;
const READ_MAX_BYTES = 64 * 1024;
const READ_MAX_LINES = 2000;
const SEARCH_LINE_MAX_CHARS = 500;
const BINARY_PROBE_BYTES = 8192;

const toolError = (error) => {
  if (error instanceof WorkspacePathError) return new ProtocolError(error.code === "not_found" ? "not_found" : "permission_denied", error.message, { pathCode: error.code });
  return error;
};

function resolve(ctx, relativePath) {
  try {
    return resolveWorkspacePath(ctx.workspace.root, relativePath);
  } catch (error) {
    throw toolError(error);
  }
}

/** Whole-file hash and newline count in bounded chunks; never loads the file into memory at once. */
function hashFile(absolute) {
  const hash = createHash("sha256");
  const fd = openSync(absolute, "r");
  const chunk = Buffer.alloc(64 * 1024);
  let lines = 0;
  let bytes = 0;
  let binary = false;
  let lastByte = 0x0a;
  try {
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, bytes);
      if (read === 0) break;
      const view = chunk.subarray(0, read);
      hash.update(view);
      if (bytes < BINARY_PROBE_BYTES && view.subarray(0, Math.min(read, BINARY_PROBE_BYTES - bytes)).includes(0)) binary = true;
      for (let i = 0; i < read; i += 1) if (view[i] === 0x0a) lines += 1;
      lastByte = view[read - 1];
      bytes += read;
    }
  } finally {
    closeSync(fd);
  }
  if (bytes > 0 && lastByte !== 0x0a) lines += 1;
  return { hash: `sha256:${hash.digest("hex")}`, lines, bytes, binary };
}

/** Read a line range without loading the whole file. */
function readLines(absolute, startLine, endLine) {
  const fd = openSync(absolute, "r");
  const chunk = Buffer.alloc(64 * 1024);
  const out = [];
  let outBytes = 0;
  let line = 1;
  let position = 0;
  let pending = Buffer.alloc(0);
  let truncated = false;
  let lastLine = startLine - 1;
  try {
    outer: for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, position);
      if (read === 0) break;
      position += read;
      let buffer = pending.length ? Buffer.concat([pending, chunk.subarray(0, read)]) : chunk.subarray(0, read);
      let start = 0;
      for (;;) {
        const nl = buffer.indexOf(0x0a, start);
        if (nl === -1) { pending = Buffer.from(buffer.subarray(start)); break; }
        if (line >= startLine && line <= endLine) {
          const text = buffer.subarray(start, nl + 1);
          if (outBytes + text.length > READ_MAX_BYTES) { truncated = true; break outer; }
          out.push(Buffer.from(text));
          outBytes += text.length;
          lastLine = line;
        }
        line += 1;
        start = nl + 1;
        if (line > endLine) { pending = Buffer.alloc(0); break outer; }
      }
    }
    if (pending.length && line >= startLine && line <= endLine && !truncated) {
      if (outBytes + pending.length > READ_MAX_BYTES) truncated = true;
      else { out.push(pending); outBytes += pending.length; lastLine = line; }
    }
  } finally {
    closeSync(fd);
  }
  return { content: Buffer.concat(out).toString("utf8"), endLine: lastLine, truncated };
}

export const fileTools = [
  {
    name: "list_files",
    description: "List entries of a workspace directory (names, types, sizes). Paged; pass the returned cursor to continue.",
    executionClass: "read",
    deadlineMs: 30_000,
    params: z.object({
      path: z.string().max(4096).default(".").describe("Workspace-relative directory"),
      cursor: z.string().max(32).optional().describe("Continuation cursor from a previous call"),
    }),
    async execute(ctx, args) {
      const { absolute, relative } = resolve(ctx, args.path);
      if (!statSync(absolute).isDirectory()) throw new ProtocolError("invalid_params", "path is not a directory");
      const names = readdirSync(absolute, { withFileTypes: true }).filter((dirent) => dirent.name !== ".git").sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)); // repository metadata is never listed; in a worktree it is a file
      const start = args.cursor ? Number.parseInt(args.cursor, 10) : 0;
      if (!Number.isInteger(start) || start < 0) throw new ProtocolError("invalid_params", "invalid cursor");
      const entries = [];
      let bytes = 0;
      let index = start;
      for (; index < names.length; index += 1) {
        const dirent = names[index];
        const type = dirent.isSymbolicLink() ? "symlink" : dirent.isDirectory() ? "directory" : dirent.isFile() ? "file" : "other";
        const entry = { name: dirent.name, type };
        if (type === "file") { try { entry.size = statSync(path.join(absolute, dirent.name)).size; } catch { /* ignore */ } }
        const encoded = JSON.stringify(entry).length + 1;
        if (entries.length >= LIST_MAX_ENTRIES || bytes + encoded > LIST_MAX_BYTES) break;
        entries.push(entry);
        bytes += encoded;
      }
      return { path: relative || ".", entries, total: names.length, nextCursor: index < names.length ? String(index) : undefined, truncated: index < names.length };
    },
  },
  {
    name: "read_file",
    description: "Read a workspace file by line range (1-based, inclusive). Returns at most 64 KiB plus the whole-file hash needed for later edits.",
    executionClass: "read",
    deadlineMs: 30_000,
    params: z.object({
      path: z.string().min(1).max(4096).describe("Workspace-relative file path"),
      startLine: z.number().int().min(1).default(1).describe("First line to return"),
      endLine: z.number().int().min(1).optional().describe("Last line to return; defaults to as many as fit"),
      expectedHash: z.string().max(80).optional().describe("Fail with a conflict if the file's current hash differs"),
    }),
    async execute(ctx, args) {
      const { absolute, relative, stat } = resolve(ctx, args.path);
      if (!stat.isFile()) throw new ProtocolError("invalid_params", "path is not a regular file");
      const meta = hashFile(absolute);
      if (args.expectedHash && args.expectedHash !== meta.hash) throw new ProtocolError("conflict", "file changed: hash mismatch", { currentHash: meta.hash });
      if (meta.binary) throw new ProtocolError("invalid_params", "binary file; read_file only returns text", { bytes: meta.bytes });
      const endLine = args.endLine ?? Math.min(meta.lines, args.startLine + READ_MAX_LINES - 1);
      if (endLine < args.startLine) throw new ProtocolError("invalid_params", "endLine precedes startLine");
      const range = readLines(absolute, args.startLine, endLine);
      return { path: relative, hash: meta.hash, totalLines: meta.lines, totalBytes: meta.bytes, startLine: args.startLine, endLine: range.endLine, truncated: range.truncated || range.endLine < endLine, content: range.content };
    },
  },
  {
    name: "search_text",
    description: "Search workspace files for a pattern (literal by default). Uses a live tgrep index when ready, otherwise ripgrep or built-in search. Returns bounded matches with paths and line numbers. Set fresh=true to verify the latest filesystem contents after edits. Ignores .git; tgrep and ripgrep respect .gitignore.",
    executionClass: "read",
    deadlineMs: 60_000,
    params: SearchTextParams,
    async execute(ctx, args) {
      const scopes = args.paths.length ? args.paths.map((p) => resolve(ctx, p)) : [{ absolute: ctx.workspace.root, relative: "." }];
      const skip = args.cursor ? Number.parseInt(args.cursor, 10) : 0;
      if (!Number.isInteger(skip) || skip < 0 || skip > 100_000 || (args.cursor && !/^\d+$/.test(args.cursor))) throw new ProtocolError("invalid_params", "invalid cursor");
      let engine = ctx.env.ripgrep ? 'ripgrep' : 'builtin';
      let result = null;
      const lease = !args.fresh && ctx.search ? await ctx.search.acquire(ctx.workspace.root, ctx.signal) : null;
      if (lease) {
        const cancel = () => { void lease.cancel(); };
        ctx.signal.addEventListener('abort', cancel, { once: true });
        try {
          if (ctx.signal.aborted) { await lease.cancel(); throw new ProtocolError('interrupted', 'search cancelled'); }
          const indexed = await searchWithGrep({ ctx, args, scopes, skip, binary: ctx.env.tgrep, indexPath: lease.indexPath });
          // Negative results are verified against disk, including files not yet observed by the watcher.
          if (lease.alive() && indexed.total > 0) { result = indexed; engine = 'tgrep'; }
        } catch { /* An unsupported flag, failed process, or stale discovery falls back to a live search. */ }
        finally { ctx.signal.removeEventListener('abort', cancel); lease.release(); }
      }
      if (ctx.signal.aborted) throw new ProtocolError('interrupted', 'search cancelled');
      result ??= ctx.env.ripgrep ? await searchWithGrep({ ctx, args, scopes, skip, binary: ctx.env.ripgrep }) : await searchBuiltin({ ctx, args, scopes, skip });
      const { matches, truncated, total } = result;
      return { pattern: args.pattern, engine, freshness: engine === 'tgrep' ? 'indexed' : 'live', matches, truncated, nextCursor: truncated ? String(skip + matches.length) : undefined, scanned: total };
    },
  },
];

async function searchWithGrep({ ctx, args, scopes, skip, binary, indexPath }) {
  const rgArgs = ["--json", "--line-number", "--no-messages", "--glob", "!.git", "--max-filesize", `${SEARCH_FILE_MAX_BYTES}`];
  rgArgs.push('--sort', 'path'); // stable paging across repeated calls
  if (indexPath) rgArgs.push('--index-path', indexPath);
  if (!args.caseSensitive) rgArgs.push("-i");
  if (!args.regex) rgArgs.push("-F");
  rgArgs.push("--", args.pattern, ...scopes.map((s) => (s.relative === "" ? "." : s.relative || ".")));
  if (ctx.signal.aborted) throw new ProtocolError('interrupted', 'search cancelled');
  const proc = Bun.spawn([binary, ...rgArgs], { cwd: ctx.workspace.root, stdin: 'ignore', stdout: "pipe", stderr: "pipe", env: { PATH: ctx.env.path } });
  let diagnostics = '';
  const stderr = (async () => { for await (const chunk of proc.stderr) diagnostics = (diagnostics + Buffer.from(chunk).toString('utf8')).slice(-4096); })();
  const onAbort = () => proc.kill();
  ctx.signal.addEventListener("abort", onAbort, { once: true });
  const matches = [];
  let seen = 0;
  let truncated = false;
  let partial = "";
  let finishedReading = false;
  try {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    outer: for (;;) {
      const { value, done } = await reader.read();
      if (done) { finishedReading = true; break; }
      partial += decoder.decode(value, { stream: true });
      if (partial.length > 8 * 1024 * 1024) throw new ProtocolError('limit_exceeded', 'search output line is too large');
      let nl;
      while ((nl = partial.indexOf("\n")) !== -1) {
        const line = partial.slice(0, nl);
        partial = partial.slice(nl + 1);
        if (!line) continue;
        let record;
        try { record = JSON.parse(line); } catch { throw new ProtocolError('unavailable', 'invalid search output'); }
        if (record.type !== "match") continue;
        const file = record.data?.path?.text ?? (record.data?.path?.bytes ? Buffer.from(record.data.path.bytes, 'base64').toString('utf8') : null);
        let relative;
        try { relative = resolve(ctx, file).relative; } catch { continue; }
        if (!scopes.some(scope => scope.relative === '.' || scope.relative === '' || relative === scope.relative || relative.startsWith(scope.relative + '/'))) continue;
        if (!Number.isInteger(record.data.line_number) || record.data.line_number < 1) throw new ProtocolError('unavailable', 'invalid search line number');
        seen += 1;
        if (seen <= skip) continue;
        if (matches.length >= args.maxMatches) { truncated = true; proc.kill(); break outer; }
        const content = record.data.lines.text ?? (record.data.lines.bytes ? Buffer.from(record.data.lines.bytes, 'base64').toString('utf8') : '');
        matches.push({ path: relative, line: record.data.line_number, text: String(content).replace(/\r?\n$/, "").slice(0, SEARCH_LINE_MAX_CHARS) });
      }
    }
  } finally {
    ctx.signal.removeEventListener("abort", onAbort);
    if (!finishedReading && proc.exitCode === null) proc.kill();
    await proc.exited;
    await stderr;
  }
  if (ctx.signal.aborted) throw new ProtocolError("interrupted", "search cancelled");
  if (!truncated && ![0, 1].includes(proc.exitCode)) throw new ProtocolError('invalid_params', diagnostics.trim() || 'search failed');
  if (indexPath && /falling back|no index/i.test(diagnostics)) throw new ProtocolError('unavailable', 'tgrep index became unavailable');
  return { matches, truncated, total: seen };
}

async function searchBuiltin({ ctx, args, scopes, skip }) {
  const flags = args.caseSensitive ? "" : "i";
  let matcher;
  try {
    matcher = args.regex ? new RegExp(args.pattern, flags) : new RegExp(args.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
  } catch {
    throw new ProtocolError("invalid_params", "invalid regular expression");
  }
  const matches = [];
  let seen = 0;
  let truncated = false;
  const visit = (absolute, relative) => {
    if (ctx.signal.aborted) throw new ProtocolError("interrupted", "search cancelled");
    if (truncated) return;
    let entry;
    try { entry = lstatSync(absolute); } catch { return; }
    if (entry.isSymbolicLink()) return;
    if (entry.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) {
        if (name === ".git") continue;
        visit(path.join(absolute, name), relative ? `${relative}/${name}` : name);
        if (truncated) return;
      }
      return;
    }
    if (!entry.isFile() || entry.size > SEARCH_FILE_MAX_BYTES) return;
    const fd = openSync(absolute, "r");
    let content;
    try {
      const buffer = Buffer.alloc(entry.size);
      readSync(fd, buffer, 0, entry.size, 0);
      if (buffer.subarray(0, BINARY_PROBE_BYTES).includes(0)) return;
      content = buffer.toString("utf8");
    } finally {
      closeSync(fd);
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      if (!matcher.test(lines[i])) continue;
      seen += 1;
      if (seen <= skip) continue;
      if (matches.length >= args.maxMatches) { truncated = true; return; }
      matches.push({ path: relative, line: i + 1, text: lines[i].replace(/\r$/, "").slice(0, SEARCH_LINE_MAX_CHARS) });
    }
  };
  for (const scope of scopes) visit(scope.absolute, scope.relative === "." ? "" : scope.relative);
  return { matches, truncated, total: seen };
}
