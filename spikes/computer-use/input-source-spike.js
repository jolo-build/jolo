// Probe: do events Jolo posts leave the physical-input idle counter alone? If they do, that
// counter measures only the user's own mouse and keyboard, so a run can pause when the user
// touches the machine. Posts zero-distance scroll events only: nothing on screen changes.
import { dlopen, FFIType } from 'bun:ffi';

const cg = dlopen('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics', {
  CGEventSourceCreate: { args: [FFIType.i32], returns: FFIType.ptr },
  CGEventCreateScrollWheelEvent2: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.ptr },
  CGEventPost: { args: [FFIType.u32, FFIType.ptr], returns: FFIType.void },
  CGEventSourceSecondsSinceLastEventType: { args: [FFIType.i32, FFIType.u32], returns: FFIType.f64 },
});
const cf = dlopen('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation', { CFRelease: { args: [FFIType.ptr], returns: FFIType.void } });

const PRIVATE = -1, COMBINED = 0, HID = 1, ANY = 0xFFFFFFFF, SCROLL = 22;
const TAPS = { hid: 0, session: 1 };
const idle = state => cg.symbols.CGEventSourceSecondsSinceLastEventType(state, ANY);
const source = cg.symbols.CGEventSourceCreate(PRIVATE);
const results = {};
for (const [name, tap] of Object.entries(TAPS)) {
  await Bun.sleep(1200); // let any real input settle so a reset is visible
  const before = { hid: idle(HID), combined: idle(COMBINED), scrollHid: cg.symbols.CGEventSourceSecondsSinceLastEventType(HID, SCROLL) };
  const event = cg.symbols.CGEventCreateScrollWheelEvent2(source, 0 /* pixel */, 2, 0, 0, 0);
  cg.symbols.CGEventPost(tap, event);
  cf.symbols.CFRelease(event);
  await Bun.sleep(150);
  const after = { hid: idle(HID), combined: idle(COMBINED), scrollHid: cg.symbols.CGEventSourceSecondsSinceLastEventType(HID, SCROLL) };
  results[name] = { before, after, hidReset: after.hid < before.hid, combinedReset: after.combined < before.combined };
}
cf.symbols.CFRelease(source);
console.log(JSON.stringify(results, null, 2));
