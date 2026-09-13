import path from 'node:path';
import os from 'node:os';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { parseFileReference } from '@jolo/markdown/file-links';

const DOCUMENTS = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.txt', '.md', '.csv', '.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp', '.rtf']);
const SEARCH_SKIP = new Set(['.git', 'node_modules', 'vendor', 'dist', 'build', '.next', '.cache', '.codex', '.agents']);

export class ChatFileError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function filesystemError(error, reference) {
  if (error instanceof ChatFileError) return error;
  if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return new ChatFileError('FILE_NOT_FOUND', `File not found: ${reference}`);
  if (error.code === 'EACCES' || error.code === 'EPERM') return new ChatFileError('FILE_ACCESS_DENIED', `Permission denied: ${reference}`);
  return new ChatFileError('FILE_UNREADABLE', `Could not read this file: ${reference}`);
}

export function fileErrorResult(error, fallback = 'Could not open this file.') {
  return { ok: false, code: error?.code ?? 'FILE_OPEN_FAILED', error: String(error?.message ?? fallback) };
}

/** Agents often omit parent directories. Resolve a path suffix only when it has one match. */
async function findWorkspaceFile(root, name) {
  const directories = [root];
  const matches = [];
  let inspected = 0;
  while (directories.length) {
    const directory = directories.pop();
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch { throw new ChatFileError('FILE_SEARCH_FAILED', `Could not search this workspace. Use the full relative path for ${name}.`); }
    for (const entry of entries) {
      if (++inspected > 20_000) throw new ChatFileError('FILE_SEARCH_LIMIT', `Workspace search limit reached. Use the full relative path for ${name}.`);
      const candidate = path.join(directory, entry.name);
      // Never follow directory symlinks into dependencies or another workspace.
      if (entry.isDirectory() && !SEARCH_SKIP.has(entry.name)) directories.push(candidate);
      else if (entry.isFile() && (path.relative(root, candidate) === name || path.relative(root, candidate).endsWith(`${path.sep}${name}`))) {
        matches.push(candidate);
        if (matches.length > 1) throw new ChatFileError('FILE_AMBIGUOUS', `More than one file matches ${name}. Use a full relative path, such as ${matches.map(file => path.relative(root, file)).join(' or ')}.`);
      }
    }
  }
  return matches[0] ?? null;
}

async function resolveChatFile(call, { sessionId, projectId, workspaceId, path: reference, urlEncoded = false, nativePath = false }) {
  const parsed = nativePath && typeof reference === 'string' && path.isAbsolute(reference) && reference.length <= 4096 && !/[\x00-\x1f\x7f]/.test(reference) ? { path: reference, line: undefined, column: undefined } : parseFileReference(reference, { explicit: true, urlEncoded });
  if ((!sessionId && (!projectId || !workspaceId)) || !parsed) throw new ChatFileError('FILE_INVALID_REFERENCE', 'This is not a supported file reference.');
  let requested = parsed.path;
  if (process.platform !== 'win32' && (/^[a-z]:[\\/]/i.test(requested) || requested.includes('\\'))) throw new ChatFileError('FILE_UNSUPPORTED_PLATFORM', 'This Windows path cannot be opened on this computer.');
  if (/^~[\\/]/.test(requested)) requested = path.join(os.homedir(), requested.slice(2));
  const session = sessionId ? (await call('session.page', { sessionId, limit: 1 })).session : { projectId, workspaceId };
  const { workspaces } = await call('workspace.list', { projectId: session.projectId });
  const workspace = workspaces.find(item => item.id === session.workspaceId && !item.removedAt && item.present);
  if (!workspace) throw new ChatFileError('FILE_WORKSPACE_UNAVAILABLE', 'This chat’s workspace is unavailable.');
  let resolved = path.isAbsolute(requested) ? requested : path.resolve(workspace.path, requested);
  try { await stat(resolved); }
  catch (error) {
    if (error.code === 'ENOENT' && !path.isAbsolute(requested) && !requested.split(path.sep).some(part => part === '.' || part === '..')) {
      resolved = await findWorkspaceFile(workspace.path, requested) ?? resolved;
    } else throw filesystemError(error, requested);
  }
  try {
    const target = await realpath(resolved);
    const info = await stat(target);
    if (info.isDirectory()) throw new ChatFileError('FILE_IS_DIRECTORY', `This path is a folder: ${requested}`);
    if (!info.isFile()) throw new ChatFileError('FILE_NOT_REGULAR', `This is not a regular file: ${requested}`);
    return { target, line: parsed.line, column: parsed.column };
  } catch (error) { throw filesystemError(error, requested); }
}

export async function previewChatFile(call, params) {
  const { target, line, column } = await resolveChatFile(call, params);
  const file = await open(target, 'r').catch(error => { throw filesystemError(error, target); });
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new ChatFileError('FILE_NOT_REGULAR', 'This is not a regular file.');
    const extension = path.extname(target).toLowerCase();
    const media = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.mp4': 'video/mp4', '.webm': 'video/webm' }[extension];
    const details = { sessionId: params.sessionId, path: target, size: info.size, extension, line, column };
    if (media && info.size > 32 * 1024 * 1024) return { ...details, kind: 'details', note: 'This file exceeds the 32 MiB media preview limit.' };
    const buffer = Buffer.alloc(Math.min(info.size, media ? 32 * 1024 * 1024 : 256 * 1024));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const content = buffer.subarray(0, bytesRead);
    if (media) return { ...details, kind: media.startsWith('image/') ? 'image' : media.startsWith('audio/') ? 'audio' : media.startsWith('video/') ? 'video' : 'pdf', mime: media, content };
    let text;
    try { if (content.includes(0)) throw new Error(); text = new TextDecoder('utf-8', { fatal: true }).decode(content, { stream: info.size > bytesRead }); }
    catch { return { ...details, kind: 'details', note: 'A visual preview is not available for this file format.' }; }
    return { ...details, kind: /\.(md|markdown|mdx)$/i.test(target) ? 'markdown' : 'text', text, truncated: info.size > bytesRead };
  } catch (error) { throw filesystemError(error, target); }
  finally { await file.close(); }
}

export async function openChatFile(call, shell, params) {
  const { target } = await resolveChatFile(call, params);
  // Never launch a script, executable or application bundle from a model-generated link.
  if (!DOCUMENTS.has(path.extname(target).toLowerCase())) { shell.showItemInFolder(target); return; }
  const error = await shell.openPath(target);
  if (error) throw new Error(error);
}
