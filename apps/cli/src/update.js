// `jolo update`: compare this build against the project's GitHub releases and, for an
// installed CLI, apply one.
//
// Applying re-runs the installer that shipped inside this release (lib/install.sh) rather
// than repeating its work here. That installer already resolves the archive, verifies its
// SHA-256, rejects unsafe archive entries, runs the new binary once before trusting it, and
// swaps PREFIX/bin/jolo atomically while leaving previous releases in place for processes
// that are still using them. One hardened implementation, used by first installs and updates
// alike, is worth more than a second copy of that logic here.
//
// Nothing updates on its own. A background check only records what is available; the user
// decides when to install it.
import { existsSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import path from "node:path";
import { discover, resolvePaths } from "@jolo/launcher";
import { RELEASE_BASE_URL, VERSION_PATTERN, checkForUpdate, isNewer, releaseLayout } from "@jolo/updates";
import { createUpdateCache } from "@jolo/updates/cache";
import { EXIT } from "./exit-codes.js";

export const updateBaseUrl = (env = process.env) => env.JOLO_UPDATE_BASE_URL || RELEASE_BASE_URL;
/** @typedef {ReturnType<typeof resolvePaths>} ProfilePaths */
/** @param {ProfilePaths} paths */
const cacheFile = (paths) => path.join(paths.dataDir, "update.json");

/**
 * Work out how this CLI was installed, which decides whether an update can be applied here.
 *
 * A managed install is the layout scripts/install.sh creates:
 * PREFIX/share/jolo/releases/<release>/lib/jolo.js, launched through PREFIX/bin/jolo.
 *
 * @returns {{ kind: 'managed'|'source'|'unmanaged', version: string, prefix?: string, releaseDir?: string, installer?: string|null, active?: boolean }}
 */
export function detectInstall({ mainPath = Bun.main, build = "dev", exists = existsSync, readText = (file) => readFileSync(file, "utf8"), readLink = readlinkSync } = {}) {
  const lib = path.dirname(mainPath);
  const releaseDir = path.dirname(lib);
  const releases = path.dirname(releaseDir);
  const shared = path.dirname(releases); // PREFIX/share/jolo
  const share = path.dirname(shared);
  const prefix = path.dirname(share);
  const versionFile = path.join(releaseDir, "VERSION");
  if (path.basename(lib) !== "lib" || path.basename(releases) !== "releases" || path.basename(shared) !== "jolo" || path.basename(share) !== "share" || !exists(versionFile)) {
    // A checkout runs from source and updates with Git; anything else was placed here by hand.
    return { kind: build === "dev" ? "source" : "unmanaged", version: build };
  }
  // The build stamp is compiled into the bundle, so it describes the code that is actually
  // running and is what `jolo --version` prints. The VERSION file only describes the directory;
  // it answers for a bundle that carries no stamp of its own.
  let version = build;
  if (!VERSION_PATTERN.test(version)) {
    try {
      const recorded = readText(versionFile).trim();
      if (VERSION_PATTERN.test(recorded)) version = recorded;
    } catch { /* the build identifier remains the best answer */ }
  }
  const installer = path.join(lib, "install.sh");
  let active = false;
  try {
    // Only the release the launcher points at is the one an update replaces. Both sides are
    // canonicalised so a symlinked prefix cannot make the same file look like two.
    const linked = path.resolve(path.join(prefix, "bin"), readLink(path.join(prefix, "bin", "jolo")));
    active = canonical(linked) === canonical(path.join(releaseDir, "bin", "jolo"));
  } catch { /* no managed launcher: report it as inactive rather than guessing */ }
  return { kind: "managed", version, prefix, releaseDir, installer: exists(installer) ? installer : null, active };
}

function canonical(file) {
  try { return realpathSync(file); } catch { return file; }
}

/** Whether the process an endpoint file names is still alive; the file outlives a crash. */
function engineAlive(metadata) {
  if (!Number.isInteger(metadata?.pid) || metadata.pid <= 0) return false;
  try { process.kill(metadata.pid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; } // exists, but belongs to another user
}

/** How to update an installation this command cannot replace itself. */
function manualInstructions(install) {
  if (install.kind === "source") return "This Jolo runs from a source checkout. Update it with `git pull` and `bun install`.";
  return `This Jolo was not installed by the Jolo installer, so it cannot update itself.\nInstall the new release with:\n  curl -fsSL https://jolo.build/install.sh | bash`;
}

/**
 * Record what is available without blocking anything. Never throws: an update check that
 * cannot reach the network is not a failure the user needs to hear about.
 * @param {{ paths?: ProfilePaths, build?: string, fetchImpl?: typeof fetch, env?: NodeJS.ProcessEnv, now?: () => number }} [options]
 * @returns {Promise<{ available: boolean, latest?: string } | null>}
 */
export async function backgroundCheck({ paths, build = "dev", fetchImpl = fetch, env = process.env, now = Date.now } = {}) {
  if (!VERSION_PATTERN.test(build)) return null; // development builds have nothing to compare against
  const cache = createUpdateCache({ file: cacheFile(paths), now });
  if (!cache.due()) return cache.read();
  try {
    const result = await checkForUpdate({ current: build, product: "cli", baseUrl: updateBaseUrl(env), fetchImpl });
    // `record` writes the failure shape only when handed a failure, and this branch always has a
    // real answer, so the entry it returns carries `available` and `latest`.
    return /** @type {{ available: boolean, latest?: string }} */ (cache.record(result));
  } catch {
    cache.record({ failed: true });
    return null;
  }
}

/**
 * The last recorded result, for showing a new release without waiting for the network.
 * @param {{ paths?: ProfilePaths, build?: string, now?: () => number }} [options]
 */
export function pendingUpdate({ paths, build = "dev", now = Date.now } = {}) {
  if (!VERSION_PATTERN.test(build)) return null;
  const entry = createUpdateCache({ file: cacheFile(paths), now }).read();
  // A recorded result outlives the build it was made for: only trust one about this version.
  return entry?.available && entry.current === build && VERSION_PATTERN.test(entry.latest ?? "") ? { latest: entry.latest } : null;
}

/**
 * `jolo update [<version>] [--check] [--json]`
 * @returns {Promise<number>} exit code
 */
export async function commandUpdate({ positional, flags }, options = {}) {
  const {
    build = "dev",
    fetchImpl = fetch,
    env = process.env,
    install = detectInstall({ build }),
    spawnImpl = Bun.spawn,
    write = (line) => process.stdout.write(`${line}\n`),
    writeError = (line) => process.stderr.write(`${line}\n`),
  } = options;
  const json = flags.json === true;
  const baseUrl = updateBaseUrl(env);
  // `jolo update 0.2.0` and `jolo update --version 0.2.0` both name a release explicitly;
  // parseArgs leaves the value as a positional either way.
  const requested = positional[1] ?? null;
  if (requested !== null && !VERSION_PATTERN.test(requested)) {
    writeError("usage: jolo update [<version>] [--check] [--json]");
    return EXIT.usage;
  }
  const current = install.version;
  if (!VERSION_PATTERN.test(current)) {
    writeError(json ? JSON.stringify({ type: "update.unsupported", current }) : `This is a development build (${current}); there is nothing to update.\n${manualInstructions(install)}`);
    return EXIT.failed;
  }

  let latest;
  let available;
  try {
    if (requested) { latest = requested; available = isNewer(latest, current); }
    else {
      // The default path also reads the published checksum, which proves the release
      // really carries a build for this platform before anything is announced.
      ({ latest, available } = await checkForUpdate({ current, product: "cli", baseUrl, fetchImpl }));
    }
  } catch (error) {
    writeError(json ? JSON.stringify({ type: "update.failed", error: String(error?.message ?? error) }) : `Could not check for updates: ${error?.message ?? error}`);
    return EXIT.failed;
  }

  // Only a genuine lookup is worth remembering: a version the user named says nothing about
  // what is newest, and recording it would hide the real release from the welcome panel.
  if (!requested) {
    try { createUpdateCache({ file: cacheFile(resolvePaths({ home: flags.home, profile: flags.profile })) }).record({ current, latest, available }); }
    catch { /* advisory only */ }
  }

  if (flags.check === true) {
    write(json ? JSON.stringify({ type: "update.status", current, latest, available, install: install.kind })
      : available ? `Jolo ${latest} is available (this is ${current}). Run \`jolo update\` to install it.` : `Jolo ${current} is up to date.`);
    return EXIT.completed;
  }
  if (!available && !requested) {
    write(json ? JSON.stringify({ type: "update.current", current, latest }) : `Jolo ${current} is up to date.`);
    return EXIT.completed;
  }
  if (install.kind !== "managed" || !install.installer) {
    const note = install.kind === "managed"
      ? "This release predates self-updating. Reinstall once with:\n  curl -fsSL https://jolo.build/install.sh | bash"
      : manualInstructions(install);
    writeError(json ? JSON.stringify({ type: "update.unsupported", current, latest, install: install.kind }) : `Jolo ${latest} is available.\n${note}`);
    return EXIT.failed;
  }
  if (!install.active && !json) writeError(`Note: ${install.prefix}/bin/jolo does not point at this release; the update will replace whichever release it does point at.`);

  if (!json) write(`Updating Jolo ${current} → ${latest}…`);
  const command = ["/bin/bash", install.installer, "--prefix", install.prefix, "--version", latest];
  const child = spawnImpl(command, {
    env: { ...env, JOLO_INSTALL_BASE_URL: baseUrl, JOLO_INSTALL_LAYOUT: releaseLayout(baseUrl) },
    stdout: json ? "pipe" : "inherit",
    stderr: json ? "pipe" : "inherit",
  });
  // Drain both pipes before awaiting exit: a piped child that fills either buffer never finishes.
  const [failure] = json ? await Promise.all([new Response(child.stderr).text(), new Response(child.stdout).text()]) : [""];
  const code = await child.exited;
  if (code !== 0) {
    writeError(json ? JSON.stringify({ type: "update.failed", current, latest, error: failure.trim().slice(-500) || `installer exited with code ${code}` })
      : `Update failed; Jolo ${current} is unchanged.`);
    return EXIT.failed;
  }

  // A running engine keeps serving the build it started with, and previous releases are kept
  // so it can. Until it stops, the updated CLI would be talking to the older engine.
  let engineBuild = null;
  try {
    const metadata = discover(resolvePaths({ home: flags.home, profile: flags.profile }))?.metadata;
    if (engineAlive(metadata)) engineBuild = metadata.build ?? null;
  } catch { /* an unreadable profile changes nothing about the update */ }
  const stale = engineBuild !== null && engineBuild !== latest;
  write(json ? JSON.stringify({ type: "update.installed", current, latest, engineRestartRequired: stale })
    : `Installed Jolo ${latest}.${stale ? `\nAn engine from ${engineBuild} is still running. Finish active tasks, then run \`jolo engine stop\` to switch it too.` : ""}`);
  return EXIT.completed;
}
