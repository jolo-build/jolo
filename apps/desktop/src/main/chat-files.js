import path from 'node:path';
import { open, realpath, stat } from 'node:fs/promises';
import { fileReference } from '@jolo/markdown/file-links';

const DOCUMENTS = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.txt', '.md', '.csv', '.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp', '.rtf']);
async function resolveChatFile(call, { sessionId, path: reference }) {
  let requested = fileReference(reference, { explicit: true });
  if (!sessionId || !requested) throw new Error('This is not a supported file reference.');
  requested = requested.replace(/:\d+(?::\d+)?$/, '');
  const { session } = await call('session.page', { sessionId, limit: 1 });
  const { workspaces } = await call('workspace.list', { projectId: session.projectId });
  const workspace = workspaces.find(item => item.id === session.workspaceId && !item.removedAt && item.present);
  if (!workspace) throw new Error('This chat’s workspace is unavailable.');
  const resolved = path.isAbsolute(requested) ? requested : path.resolve(workspace.path, requested);
  let target;
  try { target = await realpath(resolved); if (!(await stat(target)).isFile()) throw new Error(); }
  catch { throw new Error(`File not found: ${requested}`); }
  return target;
}

export async function previewChatFile(call, params) {
  const target = await resolveChatFile(call, params);
  const file = await open(target, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error('This is not a regular file.');
    const extension = path.extname(target).toLowerCase();
    const media = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.mp4': 'video/mp4', '.webm': 'video/webm' }[extension];
    const details = { sessionId: params.sessionId, path: target, size: info.size, extension };
    if (media && info.size > 32 * 1024 * 1024) return { ...details, kind: 'details', note: 'This file exceeds the 32 MiB media preview limit.' };
    const buffer = Buffer.alloc(Math.min(info.size, media ? 32 * 1024 * 1024 : 256 * 1024));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const content = buffer.subarray(0, bytesRead);
    if (media) return { ...details, kind: media.startsWith('image/') ? 'image' : media.startsWith('audio/') ? 'audio' : media.startsWith('video/') ? 'video' : 'pdf', mime: media, content };
    let text;
    try { if (content.includes(0)) throw new Error(); text = new TextDecoder('utf-8', { fatal: true }).decode(content, { stream: info.size > bytesRead }); }
    catch { return { ...details, kind: 'details', note: 'A visual preview is not available for this file format.' }; }
    return { ...details, kind: /\.(md|markdown|mdx)$/i.test(target) ? 'markdown' : 'text', text, truncated: info.size > bytesRead };
  } finally { await file.close(); }
}

export async function openChatFile(call, shell, params) {
  const target = await resolveChatFile(call, params);
  // Never launch a script, executable or application bundle from a model-generated link.
  if (!DOCUMENTS.has(path.extname(target).toLowerCase())) { shell.showItemInFolder(target); return; }
  const error = await shell.openPath(target);
  if (error) throw new Error(error);
}
