import { randomUUID } from 'node:crypto';
import { ChatFileError, previewChatFile } from './chat-files.js';

export const FILE_PREVIEW_SCHEME = 'jolo-file-preview';
const MAX_MEDIA_BYTES = 256 * 1024 * 1024;
const PDF_VIEWER_ORIGIN = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/';
/** Only explicit file clicks create tokens. No URL is interpreted as a filesystem path. */
export function createFilePreviewStore(call) {
  const files = new Map();
  const resources = new Map();
  let generation = 0;
  return {
    async prepare(params) {
      const started = generation;
      const result = await previewChatFile(call, params);
      if (started !== generation) throw new ChatFileError('FILE_PREVIEW_CLOSED', 'The file preview was closed.');
      if (!('content' in result)) return result;
      const { content, ...file } = result;
      const scope = JSON.stringify([params.sessionId ?? null, params.sessionId ? null : params.projectId, params.sessionId ? null : params.workspaceId]);
      const key = JSON.stringify([scope, file.path]);
      let resource = resources.get(key);
      const retainedBytes = [...resources.values()].reduce((total, value) => total + value.content.length, 0) - (resource?.content.length ?? 0);
      if (retainedBytes + content.length > MAX_MEDIA_BYTES) throw new ChatFileError('FILE_PREVIEW_MEMORY_LIMIT', 'Close a media preview to free space before opening this file.');
      if (!resource) {
        if ([...resources.values()].filter(value => value.scope === scope).length >= 8) throw new ChatFileError('FILE_PREVIEW_LIMIT', 'Close a file preview in this chat before opening another.');
        resource = { key, scope, content, mime: file.mime, leases: 0 };
        resources.set(key, resource);
      } else { resource.content = content; resource.mime = file.mime; }
      // Each request owns a lease. A discarded late response can release its
      // lease without breaking an existing tab displaying the same resource.
      const url = `${FILE_PREVIEW_SCHEME}://preview/${randomUUID()}`;
      resource.leases++;
      files.set(url, resource);
      return { ...file, url };
    },
    has: url => files.has(url),
    allowsFrameNavigation(event) {
      // Chromium's PDF viewer creates an internal stream frame beneath the prepared PDF.
      if (event.isMainFrame || !event.url.startsWith(PDF_VIEWER_ORIGIN) || event.initiator?.url !== `${PDF_VIEWER_ORIGIN}index.html`) return false;
      for (let frame = event.frame?.parent; frame; frame = frame.parent) if (files.get(frame.url)?.mime === 'application/pdf') return true;
      return false;
    },
    release(url) {
      const resource = files.get(url);
      if (!resource) return;
      files.delete(url);
      if (--resource.leases === 0) resources.delete(resource.key);
    },
    clear() { generation++; files.clear(); resources.clear(); },
    response(request) {
      const file = files.get(request.url);
      if (!file || request.method !== 'GET') return new Response('Preview unavailable', { status: 404 });
      const headers = { 'content-type': file.mime, 'content-length': String(file.content.length), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'accept-ranges': 'bytes' };
      const range = request.headers.get('range');
      if (!range) return new Response(file.content, { headers });
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      const start = match ? Number(match[1]) : -1;
      const end = match?.[2] ? Math.min(Number(match[2]), file.content.length - 1) : file.content.length - 1;
      if (start < 0 || start > end) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${file.content.length}` } });
      return new Response(file.content.subarray(start, end + 1), { status: 206, headers: { ...headers, 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${file.content.length}` } });
    },
  };
}
