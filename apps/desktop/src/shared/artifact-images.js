const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Read a bounded image artifact for the preview or the native save dialog. */
export async function readArtifactImage(call, artifactId, cancelled = () => false) {
  let offset = 0, total, mimeType;
  const chunks = [];
  do {
    if (cancelled()) return null;
    const result = await call('artifact.read', { artifactId, offset, length: 65535, encoding: 'base64' });
    if (offset === 0) {
      total = result.committedBytes;
      mimeType = /^attachment:(image\/(?:png|jpeg|gif|webp))$/.exec(result.kind ?? '')?.[1];
      if (!mimeType || !Number.isInteger(total) || total <= 0 || total > MAX_IMAGE_BYTES) throw new Error('Image unavailable');
    }
    const chunk = atob(result.text);
    if (!chunk.length || chunk.length !== result.bytes || offset + chunk.length > total) throw new Error('Image could not be read completely');
    chunks.push(chunk);
    offset += chunk.length;
  } while (offset < total);
  return cancelled() ? null : `data:${mimeType};base64,${btoa(chunks.join(''))}`;
}
