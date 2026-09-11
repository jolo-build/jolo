import electronPath from 'electron';
import path from 'node:path';
// Electron's types describe the API its own runtime exposes; required from Bun, the package exports the
// path to the Electron executable instead.
const child = Bun.spawn([/** @type {string} */ (/** @type {unknown} */ (electronPath)), path.resolve(import.meta.dir, '../smoke/browser-control-smoke.js')], { stdio: ['ignore', 'inherit', 'inherit'] });
const timeout = setTimeout(() => { console.error('Electron browser smoke did not finish within 60 seconds'); child.kill(); }, 60_000);
const code = await child.exited;
clearTimeout(timeout);
process.exit(code);
