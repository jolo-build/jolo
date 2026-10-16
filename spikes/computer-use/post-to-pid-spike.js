// Probe: can Jolo drive an app that is NOT in front, without moving the user's cursor, by posting
// events to that app's process instead of to the session? If so, Jolo can have a pointer of its own.
// Clicks AC, 4, ×, 4, = in Calculator while another app stays frontmost, then reports whether the
// real cursor moved and whether the frontmost app changed. Calculator must already be open.
import { dlopen, FFIType } from 'bun:ffi';

const cg = dlopen('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics', {
  CGEventSourceCreate: { args: [FFIType.i32], returns: FFIType.ptr },
  CGEventCreateMouseEvent: { args: [FFIType.ptr, FFIType.u32, FFIType.f64, FFIType.f64, FFIType.u32], returns: FFIType.ptr },
  CGEventSetIntegerValueField: { args: [FFIType.ptr, FFIType.u32, FFIType.i64], returns: FFIType.void },
  CGEventPostToPid: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.void },
});
const cf = dlopen('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation', { CFRelease: { args: [FFIType.ptr], returns: FFIType.void } });
const run = (lang, script) => Bun.spawnSync(['osascript', ...(lang === 'js' ? ['-l', 'JavaScript'] : []), '-e', script]).stdout.toString().trim();
const cursor = () => JSON.parse(run('js', 'ObjC.import("AppKit"); const p = $.NSEvent.mouseLocation; const h = $.NSScreen.screens.objectAtIndex(0).frame.size.height; JSON.stringify({ x: Math.round(p.x), y: Math.round(h - p.y) })'));
const front = () => run('as', 'tell application "System Events" to get name of first process whose frontmost is true');

const pid = Number(Bun.spawnSync(['pgrep', '-x', 'Calculator']).stdout.toString().trim());
if (!pid) throw new Error('Calculator is not running');
const [x, y] = run('as', 'tell application "System Events" to tell process "Calculator" to get position of window 1').split(',').map(Number);
if (front() === 'Calculator') throw new Error('Calculator is in front; put another app in front first');
// Button centres relative to the window's top-left, from an earlier screenshot of the same window.
const buttons = { AC: [88, 158], '4': [34, 265], '×': [196, 212], '=': [196, 373] };
const source = cg.symbols.CGEventSourceCreate(-1);
const post = (type, px, py, clickState) => {
  const event = cg.symbols.CGEventCreateMouseEvent(source, type, px, py, 0);
  if (clickState) cg.symbols.CGEventSetIntegerValueField(event, 1 /* kCGMouseEventClickState */, clickState);
  cg.symbols.CGEventPostToPid(pid, event);
  cf.symbols.CFRelease(event);
};
const before = { cursor: cursor(), front: front() };
for (const label of ['AC', '4', '×', '4', '=']) {
  const [bx, by] = buttons[label];
  const px = x + bx, py = y + by;
  post(5 /* moved */, px, py, 0);
  post(1 /* leftDown */, px, py, 1);
  post(2 /* leftUp */, px, py, 1);
  await Bun.sleep(180);
}
cf.symbols.CFRelease(source);
await Bun.sleep(300);
const after = { cursor: cursor(), front: front() };
console.log(JSON.stringify({ pid, window: { x, y }, before, after, cursorMoved: before.cursor.x !== after.cursor.x || before.cursor.y !== after.cursor.y, frontChanged: before.front !== after.front }, null, 2));
