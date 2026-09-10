// Package the prepared desktop app directory into a platform bundle with @electron/packager.
//
// On macOS the bundle is signed, and `--install` copies it into ~/Applications. Both matter for more than
// tidiness: the system refuses to register an application for notifications while it runs out of a build
// directory, so approvals and finished tasks reach the user only from an installed, signed bundle (§5.6).
// The signature here is ad-hoc unless an identity is named, which is enough for a local install; shipping to
// other machines still needs a Developer ID signature and notarization.
import { packager } from "@electron/packager";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
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
if (installed) console.log(`[package] installed ${installed} — open it once and allow notifications when asked`);
else if (bundle) console.log("[package] pass --install to copy it into ~/Applications, where the system will let it raise notifications");
