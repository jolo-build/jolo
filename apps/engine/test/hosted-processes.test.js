import { expect, test } from 'bun:test';
import { spawnLineChild } from '../src/processes/line-child.js';

const log = { warn() {} };
test('oversized unterminated vendor output fails within a bounded buffer', async () => {
  const controller = new AbortController();
  const link = spawnLineChild({ argv: [process.execPath, '--eval', 'process.stdout.write("x".repeat(200000)); setInterval(()=>{},1000)'], cwd: process.cwd(), env: { PATH: process.env.PATH }, signal: controller.signal, log, agentId: 'test', maxLineBytes: 10000 });
  try {
    await expect((async () => { for await (const _ of link.messages()) {} })()).rejects.toThrow('line exceeded limit');
  } finally { await link.settle(); }
});

test('vendor grandchildren are terminated even when the engine is killed abruptly', async () => {
  const modulePath = new URL('../src/processes/line-child.js', import.meta.url).pathname;
  const grandchild = 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000);';
  const vendor = `process.on('SIGTERM',()=>{}); const child=Bun.spawn([process.execPath,'--eval',${JSON.stringify(grandchild)}],{stdout:'ignore',stderr:'ignore'}); console.log(JSON.stringify({pid:process.pid,grandchild:child.pid})); setInterval(()=>{},1000);`;
  const parentCode = `import {spawnLineChild} from ${JSON.stringify(modulePath)}; const link=spawnLineChild({argv:[process.execPath,'--eval',${JSON.stringify(vendor)}],cwd:process.cwd(),env:{PATH:process.env.PATH},signal:new AbortController().signal,log:{warn(){}},agentId:'test'}); for await(const message of link.messages()) console.log(JSON.stringify(message));`;
  const parent = Bun.spawn([process.execPath, '--eval', parentCode], { stdout: 'pipe', stderr: 'pipe' });
  let pids = [];
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    const reader = parent.stdout.getReader();
    const { value } = await reader.read();
    const record = JSON.parse(Buffer.from(value).toString().trim());
    pids = [record.pid, record.grandchild];
    parent.kill('SIGKILL');
    await parent.exited;
    for (let i = 0; i < 60 && pids.some(alive); i++) await Bun.sleep(50);
    expect(pids.map(alive)).toEqual([false, false]);
    await reader.cancel();
  } finally {
    if (parent.exitCode === null) parent.kill('SIGKILL');
    for (const pid of pids) if (alive(pid)) try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}, 10000);

test('a burst of output faster than the reader steps is read in full, while a reader that stops reading still fails', async () => {
  // Thousands of lines at once, as a streamed answer arrives after a busy moment: everything is buffered before the reader runs.
  const burst = `for (let i = 0; i < 6000; i++) console.log(JSON.stringify({ type: 'stream_event', i })); setInterval(() => {}, 1000);`;
  const spawn = () => spawnLineChild({ argv: [process.execPath, '--eval', burst], cwd: process.cwd(), env: { PATH: process.env.PATH }, signal: new AbortController().signal, log: { warn() {} }, agentId: 'test' });
  const live = spawn();
  let read = 0;
  for await (const message of live.messages()) {
    for (let hop = 0; hop < 8; hop++) await null; // a reader handing each message on through a few async steps
    if (++read === 6000) { expect(message.i).toBe(5999); break; }
  }
  await live.settle();

  // A reader that stops for longer than a moment (waiting on something else) is not waited for.
  const stuck = spawn();
  await expect((async () => { for await (const _ of stuck.messages()) await Bun.sleep(1500); })()).rejects.toThrow('queue exceeded limit');
  await stuck.settle();
}, 10_000);
