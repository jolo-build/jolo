import { createHash } from 'node:crypto';
import { LIMITS, ProtocolError, ImageAttachmentSchema } from '@jolo/protocol';

const kindFor = mimeType => `attachment:${mimeType}`;
function mimeOf(buffer) {
  if (buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

export function createImageUpload(storage, { sessionId, mimeType }) {
  const session = storage.getSession(sessionId);
  if (!session || session.state === 'archived') throw new ProtocolError('conflict', 'open a task before attaching an image');
  const extension = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' }[mimeType];
  if (!extension) throw new ProtocolError('invalid_params', 'unsupported image type');
  return { artifactId: storage.createArtifact({ sessionId, kind: kindFor(mimeType), extension }).id };
}

export function writeImageUpload(storage, { sessionId, artifactId, offset, data, final }) {
  const artifact = storage.getArtifact(artifactId);
  if (!artifact || artifact.sessionId !== sessionId || !artifact.kind.startsWith('attachment:')) throw new ProtocolError('not_found', 'image upload not found in this task');
  const buffer = Buffer.from(data, 'base64');
  if (!buffer.length || buffer.toString('base64') !== data) throw new ProtocolError('invalid_params', 'invalid image encoding');
  const end = offset + buffer.length;
  if (buffer.length > LIMITS.attachmentChunkBytes || end > LIMITS.imageAttachmentBytes) throw new ProtocolError('limit_exceeded', 'images must be 5 MB or smaller');
  if (offset === 0 && kindFor(mimeOf(buffer)) !== artifact.kind) throw new ProtocolError('invalid_params', 'the image does not match its file type');
  // An acknowledged chunk may be replayed after reconnecting. Never append it twice.
  if (offset < artifact.committedBytes) {
    const prior = storage.readArtifact(artifact, offset, buffer.length).buffer;
    if (end > artifact.committedBytes || !prior.equals(buffer)) throw new ProtocolError('conflict', 'image upload offset changed');
  } else {
    if (offset !== artifact.committedBytes || artifact.finalizedHash) throw new ProtocolError('conflict', 'image upload is complete or out of order');
    storage.artifacts.writeChunk(artifact.storageKey, offset, buffer);
    storage.commitArtifactBytes(artifact.id, end);
    artifact.committedBytes = end;
  }
  if (final && !artifact.finalizedHash) {
    if (end !== artifact.committedBytes) throw new ProtocolError('conflict', 'final image chunk is not the last chunk');
    const all = storage.readArtifact(artifact, 0, end).buffer;
    artifact.finalizedHash = createHash('sha256').update(all).digest('hex');
    storage.finalizeArtifact(artifact.id, end, artifact.finalizedHash);
  }
  return { bytes: artifact.committedBytes, complete: Boolean(artifact.finalizedHash) };
}

export function validateAttachments(storage, sessionId, attachments = []) {
  if (attachments.length > LIMITS.imageAttachments) throw new ProtocolError('limit_exceeded', 'attach up to 4 images per message');
  return attachments.map(value => {
    const parsed = ImageAttachmentSchema.safeParse(value);
    if (!parsed.success) throw new ProtocolError('invalid_params', 'invalid image attachment');
    const image = parsed.data;
    const artifact = storage.getArtifact(image.artifactId);
    if (!artifact || artifact.sessionId !== sessionId || artifact.kind !== kindFor(image.mimeType) || !artifact.finalizedHash || artifact.committedBytes !== image.bytes) throw new ProtocolError('invalid_params', 'image attachment is incomplete or belongs to another task');
    return image;
  });
}

/** Binary images live in artifacts; neither events nor SQLite payloads contain base64. */
export function readImages(storage, run) {
  return validateAttachments(storage, run.sessionId, run.attachments).map(image => {
    const artifact = storage.getArtifact(image.artifactId);
    const buffer = storage.readArtifact(artifact, 0, image.bytes).buffer;
    if (buffer.length !== image.bytes) throw new ProtocolError('unavailable', `could not read attached image ${image.name}`);
    return { ...image, data: buffer.toString('base64'), path: storage.artifacts.pathFor(artifact.storageKey) };
  });
}

export const claudeImageContent = images => images.map(image => ({ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data } }));
export const acpImageContent = images => images.map(image => ({ type: 'image', mimeType: image.mimeType, data: image.data }));

/** Hydrate only the images that survived context selection, under a separate binary budget. */
export function hydrateRequestImages(storage, request) {
  let bytes = 0;
  return { ...request, items: request.items.map(item => {
    if (item.kind !== 'user_message' || !item.payload.attachments?.length) return item;
    const images = readImages(storage, { sessionId: request.sessionId, attachments: item.payload.attachments });
    bytes += images.reduce((sum, image) => sum + image.bytes, 0);
    if (bytes > LIMITS.imageAttachmentBytes * LIMITS.imageAttachments) throw new ProtocolError('limit_exceeded', 'image context exceeds 20 MB; start a new task or use fewer images');
    return { ...item, payload: { ...item.payload, images } };
  }) };
}
