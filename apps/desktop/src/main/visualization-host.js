import { randomUUID } from 'node:crypto';
import path from 'node:path';

export const VISUALIZATION_SCHEME = 'jolo-visualization';
export const MAX_VISUALIZATION_BYTES = 1024 * 1024;
const CHUNK_BYTES = 48 * 1024; // base64 replies stay comfortably below the protocol frame limit
const CDNS = 'https://cdnjs.cloudflare.com https://esm.sh https://cdn.jsdelivr.net https://unpkg.com';
const FONTS = 'https://fonts.googleapis.com https://fonts.gstatic.com https://fonts.bunny.net';
export const VISUALIZATION_CSP = `default-src 'none'; script-src 'unsafe-inline' ${CDNS}; style-src 'unsafe-inline' ${CDNS} ${FONTS}; img-src data: blob: ${CDNS}; font-src data: ${FONTS}; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts`;

export async function readVisualization(call, { sessionId, path: requested }) {
  if (typeof sessionId !== 'string' || typeof requested !== 'string' || requested.length > 4096 || /[\x00-\x1f\x7f]/.test(requested) || !/\.html?$/i.test(requested)) throw new Error('Choose an HTML visualization from this chat’s workspace.');
  const { session } = await call('session.page', { sessionId });
  const { workspaces } = await call('workspace.list', { projectId: session.projectId });
  const workspace = workspaces.find(item => item.id === session.workspaceId && !item.removedAt && item.present);
  if (!workspace) throw new Error('The workspace for this visualization is unavailable.');
  const relative = path.isAbsolute(requested) ? path.relative(workspace.path, requested) : requested;
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => part === '..')) throw new Error('This visualization is outside this chat’s workspace.');
  const chunks = [];
  let offset = 0;
  for (;;) {
    // Use the engine's read permission and path policy, including its symlink restrictions.
    const result = await call('workspace.readFile', { workspaceId: workspace.id, path: relative, offset, maxBytes: CHUNK_BYTES, encoding: 'base64' });
    const bytes = Buffer.from(result.text, 'base64');
    if (bytes.length !== result.bytes || !bytes.length && result.truncated) throw new Error('Couldn’t read the visualization. Restart Jolo and try again.');
    offset += bytes.length;
    if (offset > MAX_VISUALIZATION_BYTES || offset === MAX_VISUALIZATION_BYTES && result.truncated) throw new Error('This visualization exceeds the 1 MB preview limit.');
    chunks.push(bytes);
    if (!result.truncated) break;
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.includes(0)) throw new Error('This file is not an HTML text document.');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('This visualization is not valid UTF-8 text.'); }
}

export function visualizationDocument(html, id) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
    :root{color-scheme:light dark;--background:light-dark(#fcfcfb,#191a1c);--foreground:light-dark(#242629,#ededee);--muted-foreground:light-dark(#73767d,#9ea0a8);--border:light-dark(#e9e9e7,#303236);--card:light-dark(#fff,#202124);--card-foreground:var(--foreground);--primary:light-dark(#4264d6,#9caeff);--primary-foreground:light-dark(#fff,#191a1c);--font-size-base:14px;--viz-series-1:#4264d6;--viz-series-2:#389879;--viz-series-3:#bc7f36;--viz-series-4:#a666c4;--viz-series-5:#d06476;--viz-series-6:#448fa8}
    *{box-sizing:border-box}body{margin:0;color:var(--foreground);background:transparent;font:14px/1.5 system-ui,sans-serif}button,input,select,textarea{font:inherit}button{cursor:pointer}[hidden]{display:none!important}img,svg,canvas{max-width:100%}.text-muted,.text-small{color:var(--muted-foreground)}.text-small{font-size:12px}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}.table-responsive{overflow:auto}.table{width:100%;border-collapse:collapse}.table th,.table td{padding:8px;text-align:left;border-bottom:1px solid var(--border)}.btn{padding:6px 10px;border:1px solid var(--border);border-radius:6px;background:var(--card);color:var(--foreground)}.btn-primary{background:var(--primary);color:var(--primary-foreground)}
    </style><script>
    (()=>{const id=${JSON.stringify(id)};let queued=false;const send=()=>{queued=false;if(document.body)parent.postMessage({type:'jolo:visualization-height',id,height:Math.ceil(Math.max(document.body.scrollHeight,document.body.getBoundingClientRect().height))},'*')};const queue=()=>{if(!queued){queued=true;requestAnimationFrame(send)}};addEventListener('DOMContentLoaded',()=>{new ResizeObserver(queue).observe(document.body);queue()});addEventListener('load',queue);addEventListener('resize',queue)})();
    </script></head><body>${html}</body></html>`;
}

/** Tokens serve only prepared documents, never arbitrary filesystem paths or application APIs. */
export function createVisualizationStore(call) {
  const documents = new Map();
  let active = 0, generation = 0;
  return {
    async prepare(params) {
      if (active >= 4 || documents.size + active >= 32) throw new Error('Too many previews are open. Scroll away from another preview and try again.');
      active++;
      const current = generation;
      try {
        const html = await readVisualization(call, params);
        if (current !== generation) throw new Error('The conversation was closed.');
        const id = randomUUID(), url = `${VISUALIZATION_SCHEME}://preview/${id}`;
        documents.set(url, visualizationDocument(html, id));
        return { id, url };
      } finally { active--; }
    },
    has: url => documents.has(url),
    response(request) {
      const html = request.method === 'GET' ? documents.get(request.url) : null;
      return new Response(html ?? 'Preview unavailable. Reopen it from the conversation.', { status: html ? 200 : 404, headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': VISUALIZATION_CSP, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'permissions-policy': 'camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=()' } });
    },
    release: url => documents.delete(url),
    clear() { generation++; documents.clear(); },
  };
}
