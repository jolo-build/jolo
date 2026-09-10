// Ordinary pages and small releases use static assets directly. Only split
// release archives run this path; the installer still verifies the whole SHA-256.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!/^\/releases\/[^/]+\/jolo-cli-(darwin|linux)-(arm64|x64)\.tar\.gz$/.test(url.pathname)) return env.ASSETS.fetch(request);
    if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
    const direct = await env.ASSETS.fetch(request);
    if (direct.status !== 404) return direct;
    const metadata = await env.ASSETS.fetch(new Request(`${url.origin}${url.pathname}.parts.json`));
    if (!metadata.ok) return direct;
    const manifest = await metadata.json();
    const name = url.pathname.split('/').at(-1);
    if (manifest.version !== 1 || !Number.isSafeInteger(manifest.size) || manifest.size < 1 || manifest.size > 256 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(manifest.sha256) || !Array.isArray(manifest.parts) || !manifest.parts.length || manifest.parts.length > 16 || manifest.parts.some((part, i) => part.name !== `${name}.part-${String(i).padStart(3, '0')}` || !Number.isSafeInteger(part.size) || part.size < 1 || part.size > 24 * 1024 * 1024) || manifest.parts.reduce((n, part) => n + part.size, 0) !== manifest.size) return new Response('Invalid release manifest', { status: 500 });
    const headers = { 'Content-Type': 'application/gzip', 'Content-Length': String(manifest.size), 'Cache-Control': 'public, max-age=31536000, immutable', ETag: `"${manifest.sha256}"` };
    if (request.headers.get('If-None-Match') === headers.ETag) return new Response(null, { status: 304, headers });
    if (request.method === 'HEAD') return new Response(null, { headers });
    let index = 0, reader = null, received = 0, cancelled = false;
    return new Response(new ReadableStream({
      async pull(controller) {
        for (;;) {
          if (cancelled) return;
          if (!reader) {
            if (index === manifest.parts.length) { controller.close(); return; }
            const part = manifest.parts[index];
            const response = await env.ASSETS.fetch(new Request(new URL(part.name, url), { signal: request.signal }));
            if (!response.ok || !response.body) throw new Error(`Release part ${index} unavailable`);
            reader = response.body.getReader(); received = 0;
            if (cancelled) { await reader.cancel(); return; }
          }
          const next = await reader.read();
          if (next.done) {
            if (received !== manifest.parts[index].size) throw new Error('Release part size mismatch');
            reader.releaseLock(); reader = null; index++; continue;
          }
          received += next.value.byteLength;
          if (received > manifest.parts[index].size) throw new Error('Release part exceeds declared size');
          controller.enqueue(next.value); return;
        }
      },
      async cancel() { cancelled = true; await reader?.cancel(); },
    }), { headers });
  },
};
