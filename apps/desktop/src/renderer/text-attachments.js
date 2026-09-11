import { IMAGE_LIMITS as LIMITS } from '@jolo/protocol/attachments';

export const isLongPaste = text => text.length >= 2000 || text.split('\n').length >= 20;

export function attachmentSummary(attachments) {
  const texts = attachments.filter(item => item.mimeType === 'text/plain').length;
  const images = attachments.length - texts;
  return [images ? `${images} ${images === 1 ? 'image' : 'images'}` : '', texts ? `${texts} ${texts === 1 ? 'text file' : 'text files'}` : ''].filter(Boolean).join(' · ');
}

export async function readTextAttachment(text, name = 'Pasted text.txt') {
  const file = new Blob([text], { type: 'text/plain' });
  if (!file.size || file.size > LIMITS.textAttachmentBytes) throw new Error('Pasted text must be 256 KB or smaller.');
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read the pasted text. Try pasting it again.'));
    reader.onabort = () => reject(new Error('Reading pasted text was interrupted.'));
    reader.readAsDataURL(file);
  });
  return { id: crypto.randomUUID(), name, mimeType: 'text/plain', bytes: file.size, dataUrl, text };
}
