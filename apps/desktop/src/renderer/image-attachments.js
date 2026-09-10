import { IMAGE_LIMITS as LIMITS, IMAGE_MIME_TYPES } from '@jolo/protocol/attachments';

export const IMAGE_TYPES = IMAGE_MIME_TYPES;
export function clipboardImages(clipboard) {
  const items = Array.from(clipboard?.items ?? []).filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile()).filter(Boolean);
  return items.length ? items : Array.from(clipboard?.files ?? []).filter(file => file.type.startsWith('image/'));
}

export async function readImageAttachment(file) {
  if (!IMAGE_TYPES.includes(file.type)) throw new Error('Paste a PNG, JPEG, WebP, or GIF image.');
  if (!file.size || file.size > LIMITS.imageAttachmentBytes) throw new Error('Images must be 5 MB or smaller.');
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read this image. Try copying it again.'));
    reader.onabort = () => reject(new Error('Image reading was interrupted.'));
    reader.readAsDataURL(file);
  });
  return { id: crypto.randomUUID(), name: (file.name || 'Pasted image').slice(0, 200), mimeType: file.type, bytes: file.size, dataUrl };
}

// Keep retry progress with the draft image, without retaining discarded drafts.
const uploads = new WeakMap();
const CHUNK_CHARACTERS = Math.floor(LIMITS.attachmentChunkBytes / 3) * 4;
export async function uploadImages(call, sessionId, images) {
  const attachments = [];
  for (const image of images) {
    let upload = uploads.get(image);
    if (!upload || upload.sessionId !== sessionId) {
      upload = { sessionId, ...(await call('attachment.create', { sessionId, mimeType: image.mimeType })), offset: 0, characters: 0 };
      uploads.set(image, upload);
    }
    const data = image.dataUrl.slice(image.dataUrl.indexOf(',') + 1);
    while (upload.characters < data.length) {
      const chunk = data.slice(upload.characters, upload.characters + CHUNK_CHARACTERS);
      const result = await call('attachment.write', { sessionId, artifactId: upload.artifactId, offset: upload.offset, data: chunk, final: upload.characters + chunk.length === data.length });
      upload.offset = result.bytes;
      upload.characters += chunk.length;
    }
    attachments.push({ artifactId: upload.artifactId, name: image.name, mimeType: image.mimeType, bytes: image.bytes });
  }
  return attachments;
}
