// Per-profile data and runtime locations. Node/Bun compatible.
import os from "node:os";
import path from "node:path";

const PROFILE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/i;
// macOS sun_path is 104 bytes including the terminator; Linux allows 108.
const SOCKET_PATH_MAX = process.platform === "darwin" ? 103 : 107;

/**
 * @param {{ home?: string, profile?: string }} [options]
 */
export function resolvePaths(options = {}) {
  const home = options.home ?? process.env.JOLO_HOME;
  const profile = options.profile ?? process.env.JOLO_PROFILE ?? "default";
  if (!PROFILE_PATTERN.test(profile)) throw new Error(`invalid profile name: ${profile}`);
  const userHome = os.homedir();
  let dataDir;
  let runtimeDir;
  let logDir;
  if (home) {
    dataDir = path.join(home, "data", profile);
    runtimeDir = path.join(home, "run", profile);
    logDir = path.join(home, "logs", profile);
  } else if (process.platform === "darwin") {
    dataDir = path.join(userHome, "Library", "Application Support", "jolo", profile);
    runtimeDir = path.join(process.env.TMPDIR || os.tmpdir(), "jolo", profile);
    logDir = path.join(userHome, "Library", "Logs", "jolo", profile);
  } else {
    const dataHome = process.env.XDG_DATA_HOME || path.join(userHome, ".local", "share");
    const stateHome = process.env.XDG_STATE_HOME || path.join(userHome, ".local", "state");
    dataDir = path.join(dataHome, "jolo", profile);
    runtimeDir = process.env.XDG_RUNTIME_DIR
      ? path.join(process.env.XDG_RUNTIME_DIR, "jolo", profile)
      : path.join(os.tmpdir(), `jolo-${os.userInfo().uid}`, profile);
    logDir = path.join(stateHome, "jolo", profile);
  }
  const socketPath = path.join(runtimeDir, "engine.sock");
  if (Buffer.byteLength(socketPath) > SOCKET_PATH_MAX) {
    throw new Error(`socket path exceeds the platform limit (${Buffer.byteLength(socketPath)} > ${SOCKET_PATH_MAX} bytes): ${socketPath}`);
  }
  return Object.freeze({
    profile,
    dataDir,
    runtimeDir,
    logDir,
    databasePath: path.join(dataDir, "state.sqlite"),
    artifactsDir: path.join(dataDir, "artifacts"),
    agentsDir: path.join(dataDir, "agents"),
    patchesDir: path.join(dataDir, "patches"),
    recoveryDir: path.join(dataDir, "recovery"),
    socketPath,
    tokenPath: path.join(runtimeDir, "engine.token"),
    metadataPath: path.join(runtimeDir, "engine.json"),
    startupLockPath: path.join(runtimeDir, "startup.lock"),
  });
}
