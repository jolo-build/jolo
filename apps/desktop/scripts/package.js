// Package the prepared desktop app directory into a platform bundle with @electron/packager.
//
// On macOS the bundle is signed, and `--install` copies it into ~/Applications. Both matter for more than
// tidiness: the system refuses to register an application for notifications while it runs out of a build
// directory, so approvals and finished tasks reach the user only from an installed, signed bundle (§5.6).
// The signature here is ad-hoc unless an identity is named, which is enough for a local install; shipping to
// other machines still needs a Developer ID signature and notarization.
import { packager } from "@electron/packager";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
const root = path.resolve(import.meta.dir, "..", "..", "..");
const app = path.join(root, "dist", "desktop-app");
if (!existsSync(path.join(app, "main.mjs"))) throw new Error("run `bun scripts/build.js` first");
const electronVersion = JSON.parse(readFileSync(path.join(root, "apps/desktop/package.json"), "utf8")).devDependencies.electron;
const platform = process.env.JOLO_PACKAGE_PLATFORM ?? process.platform;
const arch = process.env.JOLO_PACKAGE_ARCH ?? process.arch;
const out = await packager({
  dir: app,
  out: path.join(root, "dist", "desktop"),
  name: "Jolo",
  executableName: "Jolo",
  appBundleId: "dev.jolo.desktop",
  icon: platform === "darwin" ? path.join(root, "assets", "brand", "jolo.icns") : platform === "linux" ? path.join(root, "assets", "brand", "jolo-app.png") : undefined,
  platform,
  arch,
  electronVersion,
  overwrite: true,
  asar: false, // the engine runtime must stay an executable file; asar would hide it from spawn
  prune: false,
  ignore: [],
  quiet: true,
});
const bundle = out.map((directory) => path.join(directory, "Jolo.app")).find((candidate) => existsSync(candidate)) ?? null;

/** Sign the bundle under its own identifier, so the system knows which application is asking. */
function sign(target) {
  const identity = process.env.JOLO_SIGN_IDENTITY ?? "-"; // "-" is ad-hoc: enough to install and run here
  const result = Bun.spawnSync(["codesign", "--force", "--deep", "--sign", identity, "--identifier", "dev.jolo.desktop", target], { stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`codesign failed: ${result.stderr.toString().trim().slice(0, 300)}`);
  return identity === "-" ? "ad-hoc" : identity;
}

let signed = null;
if (platform === "darwin" && bundle) signed = sign(bundle);

/**
 * Produce a drag-to-Applications disk image, with the checksum and build manifest
 * used by the release pipeline and desktop update notices.
 */
function archive(target) {
  if (platform !== "darwin" || process.platform !== "darwin") throw new Error("DMG creation requires macOS");
  const name = `jolo-desktop-${platform}-${arch}.dmg`;
  const file = path.join(root, "dist", "desktop", name);
  rmSync(file, { force: true });
  const staging = mkdtempSync(path.join(tmpdir(), 'jolo-dmg-'));
  const run = argv => {
    const result = Bun.spawnSync(argv, { stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode !== 0) throw new Error(`${argv[0]} failed: ${result.stderr.toString().trim().slice(0, 300)}`);
  };
  try {
    run(['ditto', target, path.join(staging, 'Jolo.app')]);
    symlinkSync('/Applications', path.join(staging, 'Applications'));
    run(['hdiutil', 'create', '-volname', 'Jolo', '-srcfolder', staging, '-format', 'UDZO', '-fs', 'HFS+', '-ov', file]);
    run(['hdiutil', 'verify', file]);
  } finally { rmSync(staging, { recursive: true, force: true }); }
  const bytes = readFileSync(file);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  writeFileSync(`${file}.sha256`, `${sha256}  ${name}\n`);
  const version = JSON.parse(readFileSync(path.join(app, "package.json"), "utf8")).version;
  writeFileSync(path.join(root, "dist", "desktop", "manifest.json"),
    `${JSON.stringify({ version, build: version, platform, arch, electron: electronVersion, archive: { name, sha256, size: bytes.length } }, null, 2)}\n`);
  return { name, file, sha256, size: bytes.length };
}

let packaged = null;
if (process.argv.includes("--dmg") || process.argv.includes("--archive")) {
  if (!bundle) throw new Error("--dmg is for macOS bundles");
  packaged = archive(bundle);
}

let installed = null;
if (process.argv.includes("--install")) {
  if (!bundle) throw new Error("--install is for macOS bundles");
  const applications = path.join(homedir(), "Applications");
  mkdirSync(applications, { recursive: true });
  installed = path.join(applications, "Jolo.app");
  rmSync(installed, { recursive: true, force: true });
  cpSync(bundle, installed, { recursive: true });
  sign(installed); // copying breaks the signature, so it is applied again where the app will run
}

console.log(`[package] ${out.join(", ")} (electron ${electronVersion}, ${signed ? `signed ${signed}` : "unsigned"})`);
if (packaged) console.log(`[package] ${packaged.name} (${(packaged.size / 1048576).toFixed(1)} MiB, sha256 ${packaged.sha256.slice(0, 12)}…)`);
if (installed) console.log(`[package] installed ${installed} — open it once and allow notifications when asked`);
else if (bundle) console.log("[package] pass --install to copy it into ~/Applications, where the system will let it raise notifications");
