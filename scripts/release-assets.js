import { writeFile } from 'node:fs/promises';
import path from 'node:path';
export const MAX_RELEASE_BYTES = 256 * 1024 * 1024;
export const ASSET_PART_BYTES = 24 * 1024 * 1024;

// The public archive URL stays stable. Large archives become ordered static
// parts, joined as a streaming response by the website Worker.
export async function writeReleaseArchive(directory, name, bytes, sha256, partBytes = ASSET_PART_BYTES) {
  if (bytes.length <= partBytes) return writeFile(path.join(directory, name), bytes);
  const parts = [];
  for (let offset = 0; offset < bytes.length; offset += partBytes) {
    const filename = `${name}.part-${String(parts.length).padStart(3, '0')}`;
    const part = bytes.subarray(offset, offset + partBytes);
    await writeFile(path.join(directory, filename), part);
    parts.push({ name: filename, size: part.length });
  }
  await writeFile(path.join(directory, `${name}.parts.json`), JSON.stringify({ version: 1, size: bytes.length, sha256, parts }) + '\n');
}
