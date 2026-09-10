import { expect, test } from 'bun:test';
import { clipboardImages, readImageAttachment, uploadImages } from './image-attachments.js';
import { FRAME_MAX_BYTES, encodeFrame, LIMITS } from '@jolo/protocol';

test('clipboard images are extracted once and ordinary text is left alone', () => {
  const image = { type: 'image/png' };
  expect(clipboardImages({ items: [{ kind: 'file', type: image.type, getAsFile: () => image }], files: [image] })).toEqual([image]);
  expect(clipboardImages({ items: [{ kind: 'string', type: 'text/plain' }], files: [] })).toEqual([]);
  expect(clipboardImages({ files: [image] })).toEqual([image]);
});

test('unsupported and oversized images fail before reading their contents', async () => {
  await expect(readImageAttachment({ type: 'image/svg+xml', size: 10 })).rejects.toThrow('PNG');
  await expect(readImageAttachment({ type: 'image/png', size: LIMITS.imageAttachmentBytes + 1 })).rejects.toThrow('5 MB');
});

test('uploads stay below the wire limit, retry the same chunk, and reuse completed uploads', async () => {
  const data = Buffer.alloc(350_000, 42);
  const image = { name: 'Screenshot.png', mimeType: 'image/png', bytes: data.length, dataUrl: `data:image/png;base64,${data.toString('base64')}` };
  const chunks = [], offsets = [];
  let creates = 0, fail = true;
  const call = async (method, params) => {
    expect(encodeFrame({ method, params }).length).toBeLessThan(FRAME_MAX_BYTES);
    if (method === 'attachment.create') { creates++; return { artifactId: `a${creates}` }; }
    offsets.push(params.offset);
    if (params.offset > 0 && fail) { fail = false; throw new Error('connection closed'); }
    const part = Buffer.from(params.data, 'base64'); chunks.push(part);
    return { bytes: params.offset + part.length, complete: params.final };
  };
  await expect(uploadImages(call, 's', [image])).rejects.toThrow('connection closed');
  expect(await uploadImages(call, 's', [image])).toEqual([{ artifactId: 'a1', name: image.name, mimeType: image.mimeType, bytes: image.bytes }]);
  expect(creates).toBe(1);
  expect(offsets[1]).toBe(offsets[2]);
  expect(Buffer.concat(chunks).equals(data)).toBe(true);
  const count = offsets.length;
  await uploadImages(call, 's', [image]);
  expect(offsets.length).toBe(count);
  await uploadImages(call, 'other-session', [image]);
  expect(creates).toBe(2);
});
