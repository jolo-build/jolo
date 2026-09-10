import electronPath from 'electron';
import path from 'node:path';
const child = Bun.spawn([electronPath, path.resolve(import.meta.dir, '../src/main/browser-control-smoke.mjs')], { stdio: ['ignore', 'inherit', 'inherit'] });
const timeout = setTimeout(() => { console.error('Electron browser smoke did not finish within 60 seconds'); child.kill(); }, 60_000);
const code = await child.exited;
clearTimeout(timeout);
process.exit(code);
