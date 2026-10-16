// Read-only probe: can Bun reach CoreGraphics through bun:ffi with no dependency, and what does
// this machine report for the two permissions whole-desktop control needs. Posts nothing.
import { dlopen, FFIType } from 'bun:ffi';

const cg = dlopen('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics', {
  CGMainDisplayID: { args: [], returns: FFIType.u32 },
  CGDisplayPixelsWide: { args: [FFIType.u32], returns: FFIType.u64 },
  CGDisplayPixelsHigh: { args: [FFIType.u32], returns: FFIType.u64 },
  CGDisplayCopyDisplayMode: { args: [FFIType.u32], returns: FFIType.ptr },
  CGDisplayModeGetWidth: { args: [FFIType.ptr], returns: FFIType.u64 },
  CGDisplayModeGetPixelWidth: { args: [FFIType.ptr], returns: FFIType.u64 },
  CGDisplayModeRelease: { args: [FFIType.ptr], returns: FFIType.void },
  CGPreflightScreenCaptureAccess: { args: [], returns: FFIType.bool },
  // CGPoint is two doubles; on arm64 and x86-64 a by-value {double,double} travels in the same
  // registers as two double arguments, so the struct needs no FFI support. Created, never posted.
  CGEventCreateMouseEvent: { args: [FFIType.ptr, FFIType.u32, FFIType.f64, FFIType.f64, FFIType.u32], returns: FFIType.ptr },
  CGEventGetType: { args: [FFIType.ptr], returns: FFIType.u32 },
  CGEventCreateKeyboardEvent: { args: [FFIType.ptr, FFIType.u16, FFIType.bool], returns: FFIType.ptr },
});
const cf = dlopen('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation', { CFRelease: { args: [FFIType.ptr], returns: FFIType.void } });
const ax = dlopen('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices', { AXIsProcessTrusted: { args: [], returns: FFIType.bool } });

const display = cg.symbols.CGMainDisplayID();
const mode = cg.symbols.CGDisplayCopyDisplayMode(display);
const points = Number(cg.symbols.CGDisplayModeGetWidth(mode)), pixels = Number(cg.symbols.CGDisplayModeGetPixelWidth(mode));
cg.symbols.CGDisplayModeRelease(mode);
const move = cg.symbols.CGEventCreateMouseEvent(null, 5 /* kCGEventMouseMoved */, 100.5, 200.25, 0);
const key = cg.symbols.CGEventCreateKeyboardEvent(null, 0 /* kVK_ANSI_A */, true);
const result = {
  arch: process.arch, bun: Bun.version,
  mainDisplay: { pixels: [Number(cg.symbols.CGDisplayPixelsWide(display)), Number(cg.symbols.CGDisplayPixelsHigh(display))], pointsWide: points, scale: pixels / points },
  mouseEventCreated: Boolean(move) && cg.symbols.CGEventGetType(move) === 5,
  keyEventCreated: Boolean(key),
  accessibilityTrusted: ax.symbols.AXIsProcessTrusted(),
  screenRecordingGranted: cg.symbols.CGPreflightScreenCaptureAccess(),
  screencapture: Bun.which('screencapture'),
};
if (move) cf.symbols.CFRelease(move);
if (key) cf.symbols.CFRelease(key);
console.log(JSON.stringify(result, null, 2));
