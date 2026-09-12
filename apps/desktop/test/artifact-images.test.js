import { expect, test } from 'bun:test';
import { readArtifactImage } from '../src/shared/artifact-images.js';

test('image reads reconstruct binary across chunks, including partial reads with base64 padding', async () => {
  const bytes = Buffer.alloc(150_007, 230);
  const offsets = [];
  const src = await readArtifactImage(async (method, params) => {
    expect(method).toBe('artifact.read');
    expect(params.encoding).toBe('base64');
    expect(params.length).toBeLessThanOrEqual(65535);
    offsets.push(params.offset);
    const chunk = bytes.subarray(params.offset, params.offset + 40_001);
    return { text: chunk.toString('base64'), bytes: chunk.length, committedBytes: bytes.length, kind: 'attachment:image/png' };
  }, 'art_image');
  expect(Buffer.from(src.split(',')[1], 'base64')).toEqual(bytes);
  expect(offsets).toEqual([0, 40_001, 80_002, 120_003]);
});

test('unavailable, oversized, non-image and truncated artifacts fail visibly; cancelled reads stop', async () => {
  const valid = { text: 'YQ==', bytes: 1, committedBytes: 1, kind: 'attachment:image/png' };
  for (const change of [{ kind: 'message' }, { kind: 'attachment:image/svg+xml' }, { committedBytes: 6 * 1024 * 1024 }, { bytes: 0 }, { text: '' }]) {
    await expect(readArtifactImage(async () => ({ ...valid, ...change }), 'art_bad')).rejects.toThrow();
  }
  let count = 0;
  expect(await readArtifactImage(async () => { count++; return valid; }, 'art_cancel', () => true)).toBeNull();
  expect(count).toBe(0);
});
