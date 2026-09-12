import { randomUUID } from 'node:crypto';
import { previewChatFile } from './chat-files.js';

export const FILE_PREVIEW_SCHEME = 'jolo-file-preview';
const PDF_VIEWER_ORIGIN = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/';
/** Only explicit file clicks create tokens. No URL is interpreted as a filesystem path. */
export function createFilePreviewStore(call) {
  const files = new Map();
  let generation = 0;
  return {
    async prepare(params) {
      const started = generation;
      const result = await previewChatFile(call, params);
      if (started !== generation) throw new Error('The file preview was closed.');
      if (!('content' in result)) return result;
      const { content, ...file } = result;
      if (files.size >= 8) throw new Error('Close an existing file preview before opening another.');
      const url = `${FILE_PREVIEW_SCHEME}://preview/${randomUUID()}`;
      files.set(url, { content, mime: file.mime });
      return { ...file, url };
    },
    has: url => files.has(url),
    allowsFrameNavigation(event) {
      // Chromium's PDF viewer creates an internal stream frame beneath the prepared PDF.
      if (event.isMainFrame || !event.url.startsWith(PDF_VIEWER_ORIGIN) || event.initiator?.url !== `${PDF_VIEWER_ORIGIN}index.html`) return false;
      for (let frame = event.frame?.parent; frame; frame = frame.parent) if (files.get(frame.url)?.mime === 'application/pdf') return true;
      return false;
    },
    release: url => files.delete(url),
    clear() { generation++; files.clear(); },
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
