// Shared engine discovery and startup contract for desktop main and CLI.
// The launcher lock only reduces duplicate starts; SQLite ownership decides who serves.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmdirSync, statSync } from "node:fs";
import { connect } from "@jolo/client";
import { PROTOCOL_VERSION } from "@jolo/protocol";

export { resolvePaths } from "./paths.js";

const STALE_LOCK_MS = 30_000;
/** Engine exit code when another process already owns the profile database (apps/engine/src/main.js). */
export const EXIT_OWNERSHIP_BUSY = 75;

/** Read the published endpoint, or null when no metadata/token is present. */
export function discover(paths) {
  let metadata;
  let token;
  try {
    metadata = JSON.parse(readFileSync(paths.metadataPath, "utf8"));
    token = readFileSync(paths.tokenPath, "utf8").trim();
  } catch {
    return null;
  }
  if (!metadata?.engineBootId || !token) return null;
  return { socketPath: paths.socketPath, token, metadata };
}

/**
 * Try to attach to a live engine. Returns null when there is no endpoint or nothing listens.
 * Throws on a live engine with an incompatible protocol so it is reported, never replaced.
 */
export async function tryConnect(paths, options = {}) {
  const endpoint = discover(paths);
  if (!endpoint) return null;
  try {
    return await connect({ socketPath: endpoint.socketPath, token: endpoint.token, clientKind: options.clientKind ?? "headless", build: options.build ?? "dev", requestTimeoutMs: options.requestTimeoutMs });
  } catch (error) {
    if (error?.code === "version_mismatch") throw error;
    if (error?.code === "unauthenticated") {
      const current = discover(paths);
      if (current && current.token !== endpoint.token) return connect({ socketPath: current.socketPath, token: current.token, clientKind: options.clientKind ?? "headless", build: options.build ?? "dev", requestTimeoutMs: options.requestTimeoutMs });
      throw error; // a live endpoint rejected its published credential; do not start a competitor
    }
    if (["ECONNREFUSED", "ENOENT", "ECONNRESET", "unavailable"].includes(error?.code)) return null;
    throw error;
  }
}

function acquireStartupLock(lockPath) {
  try {
    mkdirSync(lockPath, { mode: 0o700 });
    const stat = statSync(lockPath);
    return { owned: true, dev: stat.dev, ino: stat.ino };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    try {
      if (Date.now() - statSync(lockPath).mtimeMs > STALE_LOCK_MS) {
        // An advisory stale lock may be bypassed, never removed by a non-owner.
        // SQLite arbitrates simultaneous starts. This avoids deleting a fresh
        // lock between a stale observation and rmdir/rename.
        return { owned: false };
      }
    } catch { /* another owner released it; retry on the next launch */ }
    return null;
  }
}

function releaseStartupLock(lockPath, lease) {
  if (!lease?.owned) return;
  try {
    const stat = statSync(lockPath);
    if (stat.dev === lease.dev && stat.ino === lease.ino) rmdirSync(lockPath);
  } catch { /* owner already released */ }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Connect to the profile's engine, starting one detached when none answers.
 * @param {{ paths: ReturnType<typeof import("./paths.js").resolvePaths>, engineCommand: string[], env?: Record<string, string>, clientKind?: string, build?: string, deadlineMs?: number, spawnImpl?: typeof spawn }} options
 */
export async function connectOrStart(options) {
  const { paths, engineCommand } = options;
  const deadlineMs = options.deadlineMs ?? 15_000;
  const spawnImpl = options.spawnImpl ?? spawn;
  const existing = await tryConnect(paths, options);
  if (existing) return { client: existing, started: false };

  mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });
  const locked = acquireStartupLock(paths.startupLockPath);
  const startedAt = Date.now();
  let child = null;
  try {
    if (locked) {
      const [command, ...args] = engineCommand;
      child = spawnImpl(command, args, {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, ...(options.env ?? {}), JOLO_HOME: options.env?.JOLO_HOME ?? process.env.JOLO_HOME, JOLO_PROFILE: paths.profile },
      });
      child.on("error", () => {});
      child.unref();
    }
    while (Date.now() - startedAt < deadlineMs) {
      if (child && child.exitCode !== null) {
        if (child.exitCode !== 0 && child.exitCode !== EXIT_OWNERSHIP_BUSY) {
          const error = new Error(`engine exited with code ${child.exitCode} before publishing an endpoint; see the engine log under ${paths.logDir}`);
          error.code = "unavailable";
          throw error;
        }
        // Exit 75: the candidate lost ownership to a live engine; keep polling that engine's endpoint.
        child = null;
      }
      const client = await tryConnect(paths, options);
      if (client) return { client, started: Boolean(locked) };
      await sleep(100);
    }
    const error = new Error(`engine did not become reachable within ${deadlineMs} ms`);
    error.code = "unavailable";
    throw error;
  } finally {
    if (locked) releaseStartupLock(paths.startupLockPath, locked);
  }
}

export { PROTOCOL_VERSION };
