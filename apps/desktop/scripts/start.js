// Launch Electron with the desktop main process. Electron's Node runtime executes main/preload, not Bun.
import electronPath from "electron";
import path from "node:path";
const root = path.resolve(import.meta.dir, "..");
const child = Bun.spawn([electronPath, path.join(root, "src/main/index.js"), ...process.argv.slice(2)], { stdio: ["inherit", "inherit", "inherit"], env: { ...process.env, JOLO_BUN: process.env.JOLO_BUN ?? process.execPath } });
process.exit(await child.exited);
