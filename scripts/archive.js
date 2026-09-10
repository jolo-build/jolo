// Portable deterministic ustar + gzip; no platform tar flags, ownership, xattrs,
// directory iteration order, or wall-clock timestamps leak into the archive.
import { createReadStream, createWriteStream, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

function header(name, size, mode, directory, epoch) {
  if (Buffer.byteLength(name) > 100) throw new Error(`archive path exceeds ustar name field: ${name}`);
  const block = Buffer.alloc(512);
  const string = (value, offset, length) => block.write(value, offset, length, 'utf8');
  const octal = (value, offset, length) => string(value.toString(8).padStart(length - 1, '0') + '\0', offset, length);
  string(name, 0, 100); octal(mode, 100, 8); octal(0, 108, 8); octal(0, 116, 8);
  octal(size, 124, 12); octal(epoch, 136, 12); block.fill(32, 148, 156);
  string(directory ? '5' : '0', 156, 1); string('ustar\0', 257, 6); string('00', 263, 2);
  const checksum = block.reduce((sum, byte) => sum + byte, 0);
  string(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return block;
}

export async function deterministicArchive(root, destination, epoch = 0) {
  async function* entries(relative = '') {
    for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const name = path.posix.join(relative, entry.name);
      const full = path.join(root, name);
      if (entry.isSymbolicLink()) throw new Error(`archive symlinks must be resolved explicitly: ${name}`);
      if (entry.isDirectory()) { yield header(name + '/', 0, 0o755, true, epoch); yield* entries(name); }
      else if (entry.isFile()) {
        const stat = statSync(full);
        yield header(name, stat.size, stat.mode & 0o111 ? 0o755 : 0o644, false, epoch);
        yield* createReadStream(full);
        if (stat.size % 512) yield Buffer.alloc(512 - stat.size % 512);
      } else throw new Error(`unsupported archive entry: ${name}`);
    }
  }
  async function* tar() { yield* entries(); yield Buffer.alloc(1024); }
  await pipeline(Readable.from(tar()), createGzip({ level: 9 }), createWriteStream(destination));
}
