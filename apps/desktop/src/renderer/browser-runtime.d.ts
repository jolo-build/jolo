// Chromium has no `Buffer`. Shared packages that also run under Bun test for it before using it, so
// the name still has to resolve when those modules are checked as part of the renderer; declaring it
// as possibly absent is what makes those guards meaningful rather than dead code. Only the member
// the guarded branches actually reach is described.
//
// This is deliberately separate from globals.d.ts. The desktop test program includes that file so
// the components it renders see the same bridge, but Bun runs those tests with a real `Buffer`, and
// a second declaration of the name there would collide.
declare const Buffer: undefined | { byteLength(text: string, encoding?: string): number };
