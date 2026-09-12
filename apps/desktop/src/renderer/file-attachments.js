import { IMAGE_LIMITS as LIMITS } from '@jolo/protocol/attachments';
import { IMAGE_TYPES, readImageAttachment } from './image-attachments.js';
import { readTextAttachment } from './text-attachments.js';

export async function readFileAttachment(file) {
  if (IMAGE_TYPES.includes(file.type)) return readImageAttachment(file);
  if (!file.size || file.size > LIMITS.fileAttachmentBytes) throw new Error('Files must be non-empty and 20 MB or smaller.');
  const name = (file.name || 'Attached file').slice(0, 200);
  if (file.size <= LIMITS.textAttachmentBytes && (file.type.startsWith('text/') || /\.(txt|md|csv|json|jsonl|yaml|yml|xml|html|css|js|jsx|ts|tsx|py|rs|go|java|c|h|cpp|sh|sql|log)$/i.test(name))) {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      if (!text.includes('\0')) return readTextAttachment(text, name);
    } catch { /* Preserve files with other encodings as binary attachments. */ }
  }
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(`Could not read ${name}.`));
    reader.onabort = () => reject(new Error(`Reading ${name} was interrupted.`));
    reader.readAsDataURL(file);
  });
  return { id: crypto.randomUUID(), name, mimeType: 'application/octet-stream', bytes: file.size, dataUrl };
}
