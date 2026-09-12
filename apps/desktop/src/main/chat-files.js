import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { fileReference } from '@jolo/markdown/file-links';

const DOCUMENTS = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.txt', '.md', '.csv', '.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp', '.rtf']);
export async function openChatFile(call, shell, { sessionId, path: reference }) {
  let requested = fileReference(reference);
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
  // Never launch a script, executable or application bundle from a model-generated link.
  if (!DOCUMENTS.has(path.extname(target).toLowerCase())) { shell.showItemInFolder(target); return; }
  const error = await shell.openPath(target);
  if (error) throw new Error(error);
}
