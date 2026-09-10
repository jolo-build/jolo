// Bounded local diagnostics. Never logs tokens, prompts, or payload bodies.
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";

const MAX_LOG_BYTES = 1024 * 1024;

export function createLogger({ logDir, name = "engine", stderr = true }) {
  let filePath = null;
  if (logDir) {
    try {
      mkdirSync(logDir, { recursive: true, mode: 0o700 });
      filePath = path.join(logDir, `${name}.log`);
    } catch {
      filePath = null;
    }
  }
  const write = (level, message, fields) => {
    const line = JSON.stringify({ at: new Date().toISOString(), level, message, ...(fields ?? {}) });
    if (stderr) process.stderr.write(`${line}\n`);
    if (!filePath) return;
    try {
      if (statSync(filePath, { throwIfNoEntry: false })?.size > MAX_LOG_BYTES) renameSync(filePath, `${filePath}.1`);
      appendFileSync(filePath, `${line}\n`, { mode: 0o600 });
    } catch {
      /* diagnostics must never take the engine down */
    }
  };
  return {
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
  };
}
