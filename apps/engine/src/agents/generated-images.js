import { createHash } from 'node:crypto';
import { constants, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import path from 'node:path';
import { LIMITS } from '@jolo/protocol';
import { mimeOf } from '../attachments.js';

/** Copy Codex's output into durable storage before its temporary file disappears. */
export function saveGeneratedImage(storage, sessionId, item) {
  let buffer;
  if (item.result) {
    const data = item.result.replace(/^data:image\/(?:png|jpeg|gif|webp);base64,/, '');
    if (data.length > Math.ceil(LIMITS.imageAttachmentBytes / 3) * 4) throw new Error('Generated image exceeds the 5 MB preview limit.');
    buffer = Buffer.from(data, 'base64');
    if (buffer.toString('base64') !== data) throw new Error('Generated image has invalid encoding.');
  } else if (typeof item.savedPath === 'string' && path.isAbsolute(item.savedPath)) {
    const fd = openSync(item.savedPath, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > LIMITS.imageAttachmentBytes) throw new Error('Generated image is unavailable or exceeds the 5 MB preview limit.');
      buffer = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < buffer.length) {
        const bytes = readSync(fd, buffer, offset, buffer.length - offset, offset);
        if (!bytes) throw new Error('Generated image could not be read completely.');
        offset += bytes;
      }
    } finally { closeSync(fd); }
  } else throw new Error('Codex did not return image data or a saved image path.');
  const mimeType = mimeOf(buffer);
  if (!mimeType) throw new Error('Generated image has an unsupported file type.');
  const extension = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' }[mimeType];
  const artifact = storage.createArtifact({ sessionId, kind: `attachment:${mimeType}`, extension });
  storage.artifacts.writeChunk(artifact.storageKey, 0, buffer);
  storage.finalizeArtifact(artifact.id, buffer.length, createHash('sha256').update(buffer).digest('hex'));
  return `![Generated image](jolo-artifact:${artifact.id})`;
}
