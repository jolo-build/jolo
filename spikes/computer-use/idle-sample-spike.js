// Probe: sample physical-input idle times by event type for three seconds. Posts nothing.
import { dlopen, FFIType } from 'bun:ffi';
const cg = dlopen('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics', {
  CGEventSourceSecondsSinceLastEventType: { args: [FFIType.i32, FFIType.u32], returns: FFIType.f64 },
});
const HID = 1;
const TYPES = { any: 0xFFFFFFFF, mouseMoved: 5, leftDown: 1, rightDown: 3, keyDown: 10, flagsChanged: 12, scroll: 22, tabletProximity: 24, gesture: 29 };
const rows = [];
for (let i = 0; i < 15; i++) {
  rows.push(Object.fromEntries(Object.entries(TYPES).map(([k, t]) => [k, Math.round(cg.symbols.CGEventSourceSecondsSinceLastEventType(HID, t) * 100) / 100])));
  await Bun.sleep(200);
}
console.log(JSON.stringify({ first: rows[0], last: rows.at(-1), anyMax: Math.max(...rows.map(r => r.any)), moveMax: Math.max(...rows.map(r => r.mouseMoved)) }, null, 1));
