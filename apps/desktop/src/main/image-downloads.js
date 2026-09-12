import { writeFile } from 'node:fs/promises';
import { readArtifactImage } from '../shared/artifact-images.js';

/**
 * Only the native save dialog chooses a destination; the renderer supplies an artifact ID.
 * @param {any} call
 * @param {any} chooseFile
 * @param {{ artifactId?: unknown, name?: unknown }} params
 */
export async function saveArtifactImage(call, chooseFile, { artifactId, name } = {}) {
  if (typeof artifactId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(artifactId)) throw new Error('Choose an image from this chat.');
  const data = await readArtifactImage(call, artifactId);
  const [, mimeType, base64] = /^data:(image\/\w+);base64,(.+)$/.exec(data);
  const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[mimeType];
  const stem = typeof name === 'string' ? name.split(/[\\/]/).at(-1).replace(/\.[^.]*$/, '').replace(/[\x00-\x1f\x7f<>:"|?*]/g, '').trim().slice(0,120) : '';
  const result = await chooseFile({ title: 'Download image', defaultPath: `${stem || 'Generated image'}.${extension}`, filters: [{ name: 'Image', extensions: [extension] }] });
  if (result.canceled || !result.filePath) return { canceled: true };
  await writeFile(result.filePath, Buffer.from(base64, 'base64'));
  return { canceled: false };
}
