// Endpoint publication under database ownership.
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";

function validatePrivateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`runtime path is not a directory: ${dir}`);
  if (process.platform !== "win32") {
    if (stat.uid !== os.userInfo().uid) throw new Error(`runtime directory is not owned by the current user: ${dir}`);
    if ((stat.mode & 0o077) !== 0) chmodSync(dir, 0o700);
  }
}

function writePrivateFile(filePath, content) {
  const temp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temp, content, { mode: 0o600 });
  renameSync(temp, filePath);
}

function removeIfSocket(socketPath) {
  const stat = lstatSync(socketPath, { throwIfNoEntry: false });
  if (!stat) return;
  if (!stat.isSocket()) throw new Error(`refusing to remove non-socket at ${socketPath}`);
  unlinkSync(socketPath);
}

/**
 * Prepare a fresh endpoint: only the database owner calls this. Returns the token and a publish/cleanup pair.
 */
export function prepareEndpoint(paths) {
  validatePrivateDir(paths.runtimeDir);
  removeIfSocket(paths.socketPath);
  const token = randomBytes(32).toString("hex");
  writePrivateFile(paths.tokenPath, `${token}\n`);
  return {
    token,
    /** Called after the socket is listening. */
    publish(metadata) {
      chmodSync(paths.socketPath, 0o600);
      writePrivateFile(paths.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    },
    /** Remove only this boot's endpoint files; called while the database lock is still held. */
    cleanup(bootId) {
      try {
        const current = JSON.parse(readFileSync(paths.metadataPath, "utf8"));
        if (current.engineBootId === bootId) unlinkSync(paths.metadataPath);
      } catch { /* absent or foreign */ }
      try { unlinkSync(paths.tokenPath); } catch { /* absent */ }
      try { removeIfSocket(paths.socketPath); } catch { /* absent */ }
    },
  };
}
