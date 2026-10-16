// Probe: which way of creating a CFString key through bun:ffi is sound. Reads only.
import { dlopen, FFIType, ptr } from 'bun:ffi';
const cf = dlopen('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation', {
  CFStringCreateWithCString: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.ptr },
  CFStringGetLength: { args: [FFIType.ptr], returns: FFIType.i64 },
  CFArrayGetCount: { args: [FFIType.ptr], returns: FFIType.i64 },
  CFArrayGetValueAtIndex: { args: [FFIType.ptr, FFIType.i64], returns: FFIType.ptr },
  CFDictionaryGetValue: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
  CFNumberGetValue: { args: [FFIType.ptr, FFIType.i64, FFIType.ptr], returns: FFIType.bool },
  CFRelease: { args: [FFIType.ptr], returns: FFIType.void },
});
const cg = dlopen('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics', {
  CGWindowListCopyWindowInfo: { args: [FFIType.u32, FFIType.u32], returns: FFIType.ptr },
});
const bytes = Buffer.from('kCGWindowLayer\0');
const key = cf.symbols.CFStringCreateWithCString(null, ptr(bytes), 0x08000100);
console.log('key', key, 'length', cf.symbols.CFStringGetLength(key));
const list = cg.symbols.CGWindowListCopyWindowInfo(17, 0);
console.log('list', list, 'count', cf.symbols.CFArrayGetCount(list));
const first = cf.symbols.CFArrayGetValueAtIndex(list, 0);
const layer = cf.symbols.CFDictionaryGetValue(first, key);
const out = new BigInt64Array(1);
console.log('first', first, 'layerRef', layer, 'ok', layer && cf.symbols.CFNumberGetValue(layer, 4, ptr(out)), 'layer', out[0]);
cf.symbols.CFRelease(list); cf.symbols.CFRelease(key);
