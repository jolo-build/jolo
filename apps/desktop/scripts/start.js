// Launch Electron with the desktop main process. Electron's Node runtime executes main/preload, not Bun.
import electronPath from "electron";
import path from "node:path";
const root = path.resolve(import.meta.dir, "..");
// Electron's types describe the API its own runtime exposes; required from Bun, the package exports the
// path to the Electron executable instead.
const child = Bun.spawn([/** @type {string} */ (/** @type {unknown} */ (electronPath)), path.join(root, "src/main/index.js"), ...process.argv.slice(2)], { stdio: ["inherit", "inherit", "inherit"], env: { ...process.env, JOLO_BUN: process.env.JOLO_BUN ?? process.execPath } });
process.exit(await child.exited);
