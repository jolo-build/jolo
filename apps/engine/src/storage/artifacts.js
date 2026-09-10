// Artifact files: append-only, flushed before their metadata commits.
import { closeSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readSync, statSync, readdirSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";

export class ArtifactStore {
  constructor(artifactsDir) {
    this.artifactsDir = artifactsDir;
    /** @type {Map<string, { fd: number, path: string, bytes: number }>} */
    this.writers = new Map();
  }

  pathFor(storageKey) {
    return path.join(this.artifactsDir, storageKey);
  }

  /** Upload chunks resume at the durable boundary, discarding any tail left by a crash. */
  writeChunk(storageKey, offset, buffer) {
    if (this.writers.has(storageKey)) throw new Error('artifact is already being written');
    const filePath = this.pathFor(storageKey);
    mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const fd = openSync(filePath, offset === 0 ? 'w' : 'r+', 0o600);
    try {
      ftruncateSync(fd, offset);
      let written = 0;
      while (written < buffer.length) {
        const count = writeSync(fd, buffer, written, buffer.length - written, offset + written);
        if (!count) throw new Error('attachment write made no progress');
        written += count;
      }
      fsyncSync(fd);
    } finally { closeSync(fd); }
  }

  /** Open an exclusive append writer for a new artifact. One writer per artifact (§12.3). */
  openWriter(storageKey) {
    if (this.writers.has(storageKey)) throw new Error(`artifact ${storageKey} already has a writer`);
    const filePath = this.pathFor(storageKey);
    mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const fd = openSync(filePath, "a", 0o600);
    const writer = { fd, path: filePath, bytes: 0 };
    this.writers.set(storageKey, writer);
    return {
      append: (buffer) => {
        let offset = 0;
        while (offset < buffer.length) {
          const written = writeSync(fd, buffer, offset, buffer.length - offset);
          if (written <= 0) throw new Error("artifact write made no progress");
          offset += written;
          writer.bytes += written;
        }
        return writer.bytes;
      },
      flush: () => {
        fsyncSync(fd);
        return writer.bytes;
      },
      close: () => {
        if (!this.writers.has(storageKey)) return writer.bytes;
        try { fsyncSync(fd); }
        finally {
          try { closeSync(fd); } finally { this.writers.delete(storageKey); }
        }
        return writer.bytes;
      },
    };
  }

  /** Read a committed range. Callers pass the committed length so an uncommitted tail is never exposed. */
  read(storageKey, offset, length, committedBytes) {
    const filePath = this.pathFor(storageKey);
    let size = 0;
    try {
      size = statSync(filePath).size;
    } catch {
      return { buffer: Buffer.alloc(0), eof: true };
    }
    const end = Math.min(committedBytes, size);
    if (offset >= end) return { buffer: Buffer.alloc(0), eof: true };
    const bytes = Math.min(length, end - offset);
    const buffer = Buffer.alloc(bytes);
    const fd = openSync(filePath, "r");
    try {
      const read = readSync(fd, buffer, 0, bytes, offset);
      return { buffer: buffer.subarray(0, read), eof: offset + read >= end };
    } finally {
      closeSync(fd);
    }
  }

  /** Only files with no durable artifact row, older than a day, are collectible.
   * Referenced transcript, checkpoint, and patch preimage bytes remain pinned. */
  purgeOrphans(storageKeys, before = Date.now() - 86_400_000) {
    let removed = 0;
    const visit = directory => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(full);
        else if (entry.isFile()) {
          const key = path.relative(this.artifactsDir, full);
          if (!storageKeys.has(key) && !this.writers.has(key) && statSync(full).mtimeMs < before) { unlinkSync(full); removed++; }
        }
      }
    };
    visit(this.artifactsDir);
    return removed;
  }

  closeAll() {
    for (const [key, writer] of this.writers) {
      try { fsyncSync(writer.fd); } catch { /* uncommitted tails remain hidden */ }
      try { closeSync(writer.fd); } finally { this.writers.delete(key); }
    }
  }
}
