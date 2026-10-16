import path from 'node:path';
import { realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { patchDiff } from '../workspaces/diff.js';

const MAX_BYTES = 256 * 1024;
export const editPath = (root, value) => {
  const absolute = path.resolve(root, value);
  try { return realpathSync(absolute); } catch {
    const parent = path.dirname(absolute);
    return parent === absolute ? absolute : path.join(editPath(root, parent), path.basename(absolute));
  }
};
const displayPath = (root, value) => {
  const absolute = editPath(root, value);
  const relative = path.relative(editPath(root, root), absolute);
  return relative === '..' || relative.startsWith(`..${path.sep}`) ? absolute : relative;
};
const header = (file, next = file) => `diff --git a/${file} b/${next}\n--- a/${file}\n+++ b/${next}\n`;

/** Normalize structured vendor edits only. Never infer mutations from prose or scan a shared tree. */
export function agentEdits(provider, value, input, root) {
  if (provider === 'codex') return (value.changes ?? []).filter(item => typeof item.path === 'string').map(item => {
    const file = displayPath(root, item.path), next = item.kind?.move_path ? displayPath(root, item.kind.move_path) : null;
    const op = next ? 'rename' : item.kind?.type === 'add' ? 'create' : item.kind?.type === 'delete' ? 'delete' : 'replace';
    let diff = '';
    if (typeof item.diff === 'string' && item.diff) {
      if (op === 'create' && !/^(diff --git |@@ )/.test(item.diff)) diff = patchDiff([{ path: file, op, before: null, after: Buffer.from(item.diff) }]).text;
      else diff = header(file, next ?? file) + item.diff.replace(/^diff --git .*\n(?:.*\n)*?(?=@@|Binary|$)/, '');
    }
    return { path: file, ...(next ? { newPath: next } : {}), op, diff };
  });
  if (provider === 'acp') return (value.content ?? []).filter(part => part.type === 'diff' && typeof part.path === 'string').map(part => {
    const file = displayPath(root, part.path), op = part.oldText == null ? 'create' : 'replace';
    return { path: file, op, diff: typeof part.newText === 'string' ? patchDiff([{ path: file, op, before: part.oldText == null ? null : Buffer.from(part.oldText), after: Buffer.from(part.newText) }]).text : '' };
  });
  if (provider !== 'claude' || !['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(input?.name)) return [];
  const args = input.input ?? {}, target = args.file_path ?? args.notebook_path;
  if (typeof target !== 'string') return [];
  const file = displayPath(root, target);
  const hunks = value?.structuredPatch;
  let diff = '';
  if (Array.isArray(hunks) && hunks.length) {
    diff = header(file) + hunks.filter(hunk => Array.isArray(hunk.lines) && [hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines].every(Number.isInteger)).map(hunk => `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join('\n')}\n`).join('');
  } else if (typeof value?.originalFile === 'string' && typeof args.content === 'string') {
    diff = patchDiff([{ path: file, op: 'replace', before: Buffer.from(value.originalFile), after: Buffer.from(args.content) }]).text;
  } else if (value?.type === 'create' && typeof args.content === 'string') {
    diff = patchDiff([{ path: file, op: 'create', before: null, after: Buffer.from(args.content) }]).text;
  }
  // Without an acknowledged preimage, Write content is not evidence that every line was added.
  return [{ path: file, op: value?.type === 'create' ? 'create' : 'replace', diff }];
}

export function recordAgentEdits({ storage, sessionId, runId, tool, edits }) {
  if (!edits.length) return;
  let text = edits.map(edit => edit.diff).filter(Boolean).join('\n');
  if (Buffer.byteLength(text) > MAX_BYTES) text = Buffer.from(text).subarray(0, MAX_BYTES).toString('utf8') + '\n… diff truncated';
  let diffArtifactId;
  if (text) {
    const artifact = storage.createArtifact({ sessionId, kind: 'diff' });
    const writer = storage.openArtifactWriter(artifact), bytes = Buffer.from(text);
    let committed;
    try { writer.append(bytes); committed = writer.flush(); } finally { writer.close(); }
    storage.finalizeArtifact(artifact.id, committed, `sha256:${createHash('sha256').update(bytes).digest('hex')}`);
    diffArtifactId = artifact.id;
  }
  storage.appendEvent({ sessionId, runId, type: 'files.changed', payload: {
    invocationId: tool.invocationId, messageId: tool.messageId, tool: tool.name,
    ...(diffArtifactId ? { diffArtifactId } : {}),
    changes: edits.map(({ path, newPath, op }) => ({ path, ...(newPath ? { newPath } : {}), op, beforeHash: null, afterHash: null })),
  } });
}
