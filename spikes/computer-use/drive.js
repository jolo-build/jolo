// Demo driver: run a plan of real clicks and drags through `engine screen-input` with the checks the
// screen host applies: the target app stays in front, its window does not move, and any physical
// input from the user since the previous action aborts the plan. Usage:
//   bun spikes/computer-use/drive.js plan.json
// plan.json: { app, window: "x, y, w, h", steps: [{ click: [x, y] } | { drag: [[x, y], [x2, y2]] } | { sleep: ms } | { note: "…" }] }
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const plan = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const run = (lang, script) => Bun.spawnSync(['osascript', ...(lang === 'js' ? ['-l', 'JavaScript'] : []), '-e', script]).stdout.toString().trim();
const helper = spawn('bun', ['apps/engine/src/main.js', 'screen-input'], { stdio: ['pipe', 'pipe', 'inherit'] });
const replies = []; let buffer = '';
helper.stdout.on('data', chunk => { buffer += chunk; let end; while ((end = buffer.indexOf('\n')) >= 0) { replies.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1); } });
let seq = 0;
const ask = message => new Promise(resolve => { const before = replies.length; helper.stdin.write(`${JSON.stringify({ id: ++seq, ...message })}\n`); const timer = setInterval(() => { if (replies.length > before) { clearInterval(timer); resolve(replies.at(-1)); } }, 5); });
const done = (code, ...message) => { if (message.length) console.log(...message); helper.stdin.end(); process.exit(code); };
const idle = async () => (await ask({ cmd: 'idle' })).result.seconds;
const cursor = () => JSON.parse(run('js', 'ObjC.import("AppKit"); const p = $.NSEvent.mouseLocation; const h = $.NSScreen.screens.objectAtIndex(0).frame.size.height; JSON.stringify({ x: p.x, y: h - p.y })'));
const front = () => run('as', 'tell application "System Events" to get name of first process whose frontmost is true');
const geometry = () => run('as', `tell application "System Events" to tell process "${plan.app}" to get {position, size} of window 1`);

// Wait for the user to be idle before the first action, so the plan never starts under their hands.
const deadline = Date.now() + 30_000;
let quiet = await idle();
while (quiet < 2 && Date.now() < deadline) { await Bun.sleep(400); quiet = await idle(); }
if (quiet < 2) done(3, 'aborted: you kept using the mouse or keyboard for 30 seconds');
let lastAction = null;
let count = 0;
for (const step of plan.steps) {
  if (step.note) { console.log(step.note); continue; }
  if (step.sleep) { await Bun.sleep(step.sleep); continue; }
  if (front() !== plan.app) done(5, `aborted at step ${count}: ${plan.app} is no longer in front`);
  if (plan.window && geometry() !== plan.window) done(5, `aborted at step ${count}: the ${plan.app} window moved to ${geometry()}`);
  if (lastAction && await idle() < (Date.now() - lastAction) / 1000 - 0.15) done(3, `aborted at step ${count}: you used the mouse or keyboard`);
  const reply = step.click
    ? await ask({ cmd: 'pointer', action: 'click', from: cursor(), to: { x: step.click[0], y: step.click[1] }, modifiers: [] })
    : await ask({ cmd: 'pointer', action: 'drag', from: cursor(), to: { x: step.drag[0][0], y: step.drag[0][1] }, dragTo: { x: step.drag[1][0], y: step.drag[1][1] }, modifiers: [] });
  if (!reply.ok) done(6, `step ${count} failed: ${JSON.stringify(reply.error)}`);
  lastAction = Date.now();
  count += 1;
  await Bun.sleep(step.after ?? 120);
}
done(0, `${count} actions posted`);
