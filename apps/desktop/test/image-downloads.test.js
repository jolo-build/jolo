import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { saveArtifactImage } from '../src/main/image-downloads.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const call = async () => ({ kind: 'attachment:image/png', text: png.toString('base64'), bytes: png.length, committedBytes: png.length });

test('downloads preserve the original bytes at the destination chosen in the native dialog', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jolo-image-download-'));
  try {
    const destination = path.join(dir, 'chosen.png');
    const result = await saveArtifactImage(call, async options => {
      expect(options.defaultPath).toBe('mockup.png');
      expect(options.filters).toEqual([{ name: 'Image', extensions: ['png'] }]);
      return { canceled: false, filePath: destination };
    }, { artifactId: 'art_image', name: '../../mockup.exe' });
    expect(result).toEqual({ canceled: false });
    expect(await readFile(destination)).toEqual(png);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('canceling does not write a file and invalid images never open a save dialog', async () => {
  expect(await saveArtifactImage(call, async () => ({ canceled: true }), { artifactId: 'art_image', name: 'Generated image' })).toEqual({ canceled: true });
  let opened = false;
  const dialog = async () => { opened = true; return { canceled: true }; };
  await expect(saveArtifactImage(call, dialog, { artifactId: '../private', name: 'bad' })).rejects.toThrow();
  await expect(saveArtifactImage(async () => ({ ...(await call()), kind: 'message' }), dialog, { artifactId: 'art_text' })).rejects.toThrow();
  expect(opened).toBe(false);
});
