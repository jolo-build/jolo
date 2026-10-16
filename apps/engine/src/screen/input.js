// Screen input helper: `engine screen-input`, spawned by Jolo desktop over stdio. It posts real mouse
// and keyboard events through CoreGraphics, lists windows, brings an app forward, and reports how
// long ago the user last touched the mouse or keyboard. No dependency: bun:ffi against system
// frameworks. Events go to the session event tap, which leaves the hardware idle counters alone, so
// Jolo's own input is never mistaken for the user's (verified in spikes/computer-use).
//
// Wire: one JSON object per line each way. Request { id, cmd, ...args } → reply { id, ok, result } or
// { id, ok: false, error: { code, message } }. Commands run one at a time, in order.

export const MODIFIER_FLAGS = Object.freeze({ Shift: 0x20000, Control: 0x40000, Alt: 0x80000, Meta: 0x100000 });
// US ANSI virtual key codes. Characters on other layouts are typed as text, not pressed.
const LETTERS = { a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17, o: 31, u: 32, i: 34, p: 35, l: 37, j: 38, k: 40, n: 45, m: 46 };
const DIGITS = { 1: 18, 2: 19, 3: 20, 4: 21, 6: 22, 5: 23, 9: 25, 7: 26, 8: 28, 0: 29 };
const PUNCTUATION = { '=': 24, '-': 27, ']': 30, '[': 33, "'": 39, ';': 41, '\\': 42, ',': 43, '/': 44, '.': 47, '`': 50 };
const SHIFTED = { '~': '`', '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0', '_': '-', '+': '=', '{': '[', '}': ']', '|': '\\', ':': ';', '"': "'", '<': ',', '>': '.', '?': '/' };
const NAMED = { Enter: 36, Tab: 48, Space: 49, Backspace: 51, Escape: 53, Delete: 117, Insert: 114, Home: 115, End: 119, PageUp: 116, PageDown: 121, ArrowLeft: 123, ArrowRight: 124, ArrowDown: 125, ArrowUp: 126,
  F1: 122, F2: 120, F3: 99, F4: 118, F5: 96, F6: 97, F7: 98, F8: 100, F9: 101, F10: 109, F11: 103, F12: 111 };
const MOUSE = { move: 5, leftDown: 1, leftUp: 2, rightDown: 3, rightUp: 4, leftDragged: 6, otherDown: 25, otherUp: 26 };
const BUTTONS = { left: 0, right: 1, middle: 2 };
// Physical input the user makes on purpose. Gesture events are excluded: a finger resting on a
// trackpad emits them continuously.
const USER_INPUT_TYPES = Object.freeze([MOUSE.move, MOUSE.leftDragged, 7 /* rightDragged */, 27 /* otherDragged */, MOUSE.leftDown, MOUSE.rightDown, MOUSE.otherDown, 10 /* keyDown */, 22 /* scrollWheel */]);
const MOVE_STEPS = 12;
const MOVE_STEP_MS = 14;
const SCROLL_STEP_PX = 100;
const TEXT_CHUNK = 16;

/** A key name and modifiers → the virtual key code and CoreGraphics flags to post. */
export function keyStroke(key, modifiers = []) {
  let flags = modifiers.reduce((value, modifier) => value | (MODIFIER_FLAGS[modifier] ?? 0), 0);
  let base = key;
  if (SHIFTED[key]) { base = SHIFTED[key]; flags |= MODIFIER_FLAGS.Shift; }
  else if (/^[A-Z]$/.test(key)) { base = key.toLowerCase(); flags |= MODIFIER_FLAGS.Shift; }
  const code = NAMED[base] ?? LETTERS[base] ?? DIGITS[base] ?? PUNCTUATION[base];
  if (code === undefined) throw Object.assign(new Error(`no key named ${key}`), { code: 'unknown_key' });
  return { code, flags };
}

/**
 * The mouse events for one pointer action, in global display points: a visible glide from the
 * cursor's current position, then the presses. Pure, so tests can check it without moving anything.
 * @param {{ action: string, from?: { x: number, y: number } | null, to: { x: number, y: number }, dragTo?: { x: number, y: number } | null, modifiers?: string[] }} request
 */
export function planPointer({ action, from = null, to, dragTo = null, modifiers = [] }) {
  const flags = modifiers.reduce((value, modifier) => value | (MODIFIER_FLAGS[modifier] ?? 0), 0);
  const events = [];
  const glide = (a, b, type, button = 0) => {
    const steps = a ? MOVE_STEPS : 1;
    for (let step = 1; step <= steps; step += 1) {
      const t = a ? step / steps : 1;
      const ease = 1 - (1 - t) ** 3;
      events.push({ type, x: a ? a.x + (b.x - a.x) * ease : b.x, y: a ? a.y + (b.y - a.y) * ease : b.y, button, flags, delayMs: a ? MOVE_STEP_MS : 0 });
    }
  };
  glide(from, to, MOUSE.move);
  if (action === 'move') return events;
  if (action === 'drag') {
    if (!dragTo) throw Object.assign(new Error('drag needs a destination'), { code: 'invalid_arguments' });
    events.push({ type: MOUSE.leftDown, x: to.x, y: to.y, button: 0, flags, clickState: 1, delayMs: 40 });
    glide(to, dragTo, MOUSE.leftDragged);
    events.push({ type: MOUSE.leftUp, x: dragTo.x, y: dragTo.y, button: 0, flags, clickState: 1, delayMs: 0 });
    return events;
  }
  const button = action === 'right_click' ? 'right' : action === 'middle_click' ? 'middle' : 'left';
  const [down, up] = button === 'left' ? [MOUSE.leftDown, MOUSE.leftUp] : button === 'right' ? [MOUSE.rightDown, MOUSE.rightUp] : [MOUSE.otherDown, MOUSE.otherUp];
  const clicks = action === 'double_click' ? 2 : action === 'triple_click' ? 3 : 1;
  for (let click = 1; click <= clicks; click += 1) {
    events.push({ type: down, x: to.x, y: to.y, button: BUTTONS[button], flags, clickState: click, delayMs: 30 });
    events.push({ type: up, x: to.x, y: to.y, button: BUTTONS[button], flags, clickState: click, delayMs: click < clicks ? 60 : 0 });
  }
  return events;
}

/** Text as posting steps: unicode chunks, with line breaks and tabs pressed as keys so apps see them. */
export function planText(text) {
  /** @type {Array<{ text?: string, key?: string }>} */
  const steps = [];
  let run = '';
  const flush = () => { for (let i = 0; i < run.length; i += TEXT_CHUNK) steps.push({ text: run.slice(i, i + TEXT_CHUNK) }); run = ''; };
  for (const char of text.replace(/\r\n?/g, '\n')) {
    if (char === '\n' || char === '\t') { flush(); steps.push({ key: char === '\n' ? 'Enter' : 'Tab' }); }
    else run += char;
  }
  flush();
  return steps;
}

/** Scroll deltas in screen pixels as bounded wheel steps; CoreGraphics counts positive as up and left. */
export function planScroll(deltaX = 0, deltaY = 0) {
  const count = Math.max(1, Math.ceil(Math.max(Math.abs(deltaX), Math.abs(deltaY)) / SCROLL_STEP_PX));
  const steps = [];
  for (let i = 0; i < count; i += 1) steps.push({ vertical: -Math.round(deltaY / count) || 0, horizontal: -Math.round(deltaX / count) || 0 });
  return steps;
}

function loadNative() {
  const { dlopen, FFIType, ptr, CString } = require('bun:ffi');
  const framework = name => `/System/Library/Frameworks/${name}.framework/${name}`;
  const cg = dlopen(framework('CoreGraphics'), {
    CGEventSourceCreate: { args: [FFIType.i32], returns: FFIType.ptr },
    CGEventCreateMouseEvent: { args: [FFIType.ptr, FFIType.u32, FFIType.f64, FFIType.f64, FFIType.u32], returns: FFIType.ptr },
    CGEventCreateKeyboardEvent: { args: [FFIType.ptr, FFIType.u16, FFIType.bool], returns: FFIType.ptr },
    CGEventCreateScrollWheelEvent2: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.ptr },
    CGEventKeyboardSetUnicodeString: { args: [FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.void },
    CGEventSetFlags: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.void },
    CGEventSetIntegerValueField: { args: [FFIType.ptr, FFIType.u32, FFIType.i64], returns: FFIType.void },
    CGEventPost: { args: [FFIType.u32, FFIType.ptr], returns: FFIType.void },
    CGEventSourceSecondsSinceLastEventType: { args: [FFIType.i32, FFIType.u32], returns: FFIType.f64 },
    CGPreflightScreenCaptureAccess: { args: [], returns: FFIType.bool },
    // Core Foundation references travel as exact 64-bit integers: tagged pointers (small numbers and
    // strings) exceed 2^53 and would be corrupted as JavaScript numbers.
    CGWindowListCopyWindowInfo: { args: [FFIType.u32, FFIType.u32], returns: FFIType.u64 },
    CGRectMakeWithDictionaryRepresentation: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.bool },
  });
  const cf = dlopen(framework('CoreFoundation'), {
    CFRelease: { args: [FFIType.ptr], returns: FFIType.void },
    CFArrayGetCount: { args: [FFIType.u64], returns: FFIType.i64 },
    CFArrayGetValueAtIndex: { args: [FFIType.u64, FFIType.i64], returns: FFIType.u64 },
    CFDictionaryGetValue: { args: [FFIType.u64, FFIType.u64], returns: FFIType.u64 },
    CFStringCreateWithCString: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.u64 },
    CFStringGetCString: { args: [FFIType.u64, FFIType.ptr, FFIType.i64, FFIType.u32], returns: FFIType.bool },
    CFNumberGetValue: { args: [FFIType.u64, FFIType.i64, FFIType.ptr], returns: FFIType.bool },
    CFBooleanGetValue: { args: [FFIType.u64], returns: FFIType.bool },
  });
  // The same function bound a second time for references held as 64-bit integers.
  const cfRef = dlopen(framework('CoreFoundation'), { CFRelease: { args: [FFIType.u64], returns: FFIType.void } });
  const ax = dlopen(framework('ApplicationServices'), { AXIsProcessTrusted: { args: [], returns: FFIType.bool } });
  const libc = dlopen('/usr/lib/libSystem.B.dylib', { proc_pidpath: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 } });
  return { cg: cg.symbols, cf: cf.symbols, releaseRef: cfRef.symbols.CFRelease, ax: ax.symbols, libc: libc.symbols, ptr, CString };
}

const UTF8 = 0x08000100;
const SESSION_TAP = 1;
const HID_STATE = 1;
const PRIVATE_STATE = -1;
const CLICK_STATE_FIELD = 1;

export function createScreenInput(native = loadNative()) {
  const { cg, cf, releaseRef, ax, libc, ptr } = native;
  const source = cg.CGEventSourceCreate(PRIVATE_STATE);
  const keys = new Map();
  const cfKey = name => {
    if (!keys.has(name)) {
      const bytes = Buffer.from(`${name}\0`, 'utf8');
      keys.set(name, cf.CFStringCreateWithCString(null, ptr(bytes), UTF8));
    }
    return keys.get(name);
  };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const post = (event, flags) => {
    if (!event) throw Object.assign(new Error('CoreGraphics refused to create the event'), { code: 'input_failed' });
    try {
      if (flags !== undefined) cg.CGEventSetFlags(event, flags);
      cg.CGEventPost(SESSION_TAP, event);
    } finally { cf.CFRelease(event); }
  };
  const pressKey = async (key, modifiers = [], repeat = 1) => {
    const { code, flags } = keyStroke(key, modifiers);
    for (let i = 0; i < repeat; i += 1) {
      post(cg.CGEventCreateKeyboardEvent(source, code, true), flags);
      post(cg.CGEventCreateKeyboardEvent(source, code, false), flags);
      await sleep(12);
    }
  };
  const string = value => {
    if (!value) return null;
    const buffer = Buffer.alloc(1024);
    return cf.CFStringGetCString(value, ptr(buffer), buffer.length, UTF8) ? buffer.toString('utf8', 0, buffer.indexOf(0)) : null;
  };
  const number = (value, float = false) => {
    if (!value) return null;
    const out = float ? new Float64Array(1) : new BigInt64Array(1);
    return cf.CFNumberGetValue(value, float ? 6 : 4, ptr(out)) ? Number(out[0]) : null;
  };
  const appPath = pid => {
    const buffer = Buffer.alloc(4096);
    const length = libc.proc_pidpath(pid, ptr(buffer), buffer.length);
    if (length <= 0) return null;
    const executable = buffer.toString('utf8', 0, length);
    const bundle = executable.match(/^(.*?\.app)\//);
    return bundle ? bundle[1] : null;
  };

  const commands = {
    status: () => ({ accessibility: Boolean(ax.AXIsProcessTrusted()), screenRecording: Boolean(cg.CGPreflightScreenCaptureAccess()) }),
    /** Seconds since the user last moved, clicked, scrolled or typed with real hardware. */
    idle: () => ({ seconds: Math.min(...USER_INPUT_TYPES.map(type => cg.CGEventSourceSecondsSinceLastEventType(HID_STATE, type))) }),
    pointer: async ({ action, from, to, dragTo, modifiers }) => {
      for (const event of planPointer({ action, from, to, dragTo, modifiers })) {
        const created = cg.CGEventCreateMouseEvent(source, event.type, event.x, event.y, event.button);
        if (created && event.clickState) cg.CGEventSetIntegerValueField(created, CLICK_STATE_FIELD, event.clickState);
        post(created, event.flags);
        if (event.delayMs) await sleep(event.delayMs);
      }
      return { posted: true };
    },
    type: async ({ text }) => {
      for (const step of planText(text)) {
        if (step.key) { await pressKey(step.key); continue; }
        const units = new Uint16Array([...step.text].flatMap(char => { const code = char.codePointAt(0); return code > 0xffff ? [0xd800 + ((code - 0x10000) >> 10), 0xdc00 + ((code - 0x10000) & 0x3ff)] : [code]; }));
        for (const down of [true, false]) {
          const event = cg.CGEventCreateKeyboardEvent(source, 0, down);
          if (event) cg.CGEventKeyboardSetUnicodeString(event, units.length, ptr(units));
          post(event, 0);
        }
        await sleep(8);
      }
      return { typed: text.length };
    },
    press: async ({ key, modifiers, repeat }) => { await pressKey(key, modifiers, repeat); return { pressed: key }; },
    scroll: async ({ at, deltaX, deltaY }) => {
      if (at) post(cg.CGEventCreateMouseEvent(source, MOUSE.move, at.x, at.y, 0), 0);
      for (const step of planScroll(deltaX, deltaY)) {
        post(cg.CGEventCreateScrollWheelEvent2(source, 0 /* pixel */, 2, step.vertical, step.horizontal, 0), 0);
        await sleep(12);
      }
      return { scrolled: true };
    },
    windows: ({ includeOffscreen = false }) => {
      const list = cg.CGWindowListCopyWindowInfo(includeOffscreen ? 16 : 1 | 16, 0);
      if (!list) return { windows: [] };
      try {
        const windows = [];
        const count = Number(cf.CFArrayGetCount(list));
        for (let i = 0; i < count; i += 1) {
          const entry = cf.CFArrayGetValueAtIndex(list, i);
          const get = name => cf.CFDictionaryGetValue(entry, cfKey(name));
          if (number(get('kCGWindowLayer')) !== 0) continue; // ordinary app windows only, not menus or the dock
          const rect = new Float64Array(4);
          const boundsRef = get('kCGWindowBounds');
          if (!boundsRef || !cg.CGRectMakeWithDictionaryRepresentation(boundsRef, ptr(rect))) continue;
          if (rect[2] < 40 || rect[3] < 40) continue;
          const onscreen = get('kCGWindowIsOnscreen');
          windows.push({ id: number(get('kCGWindowNumber')), app: string(get('kCGWindowOwnerName')) ?? '', title: string(get('kCGWindowName')) ?? '', pid: number(get('kCGWindowOwnerPID')),
            bounds: { x: rect[0], y: rect[1], width: rect[2], height: rect[3] }, onscreen: onscreen ? Boolean(cf.CFBooleanGetValue(onscreen)) : false });
        }
        return { windows: windows.slice(0, 100) };
      } finally { releaseRef(list); }
    },
    activate: async ({ pid }) => {
      const bundle = appPath(pid);
      if (!bundle) throw Object.assign(new Error(`process ${pid} is not a running app`), { code: 'not_found' });
      const opened = Bun.spawn(['/usr/bin/open', '-a', bundle], { stdout: 'ignore', stderr: 'pipe' });
      if (await opened.exited !== 0) throw Object.assign(new Error(`could not bring ${bundle} forward`), { code: 'activate_failed' });
      await sleep(250);
      return { activated: bundle.split('/').at(-1).replace(/\.app$/, '') };
    },
  };
  return {
    commands,
    dispose() { for (const key of keys.values()) if (key) releaseRef(key); if (source) cf.CFRelease(source); },
  };
}

/** Serve commands over stdio until stdin closes. */
export async function runScreenInput({ input = process.stdin, write = line => process.stdout.write(line) } = {}) {
  if (process.platform !== 'darwin') { write(`${JSON.stringify({ id: 0, ok: false, error: { code: 'unsupported_platform', message: 'screen control is available on macOS only' } })}\n`); return 2; }
  const screen = createScreenInput();
  const reply = message => write(`${JSON.stringify(message)}\n`);
  let pending = '';
  let queue = Promise.resolve();
  const decoder = new TextDecoder();
  try {
    for await (const chunk of input) {
      pending += decoder.decode(chunk, { stream: true });
      if (pending.length > 1024 * 1024) throw new Error('screen input exceeds limit');
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        if (!line.trim()) continue;
        let request;
        try { request = JSON.parse(line); } catch { reply({ id: null, ok: false, error: { code: 'invalid_json', message: 'invalid request' } }); continue; }
        queue = queue.then(async () => {
          const command = screen.commands[request.cmd];
          if (!command) { reply({ id: request.id, ok: false, error: { code: 'unknown_command', message: `unknown command ${request.cmd}` } }); return; }
          try { reply({ id: request.id, ok: true, result: await command(request) }); }
          catch (error) { reply({ id: request.id, ok: false, error: { code: String(error?.code ?? 'input_failed').slice(0, 64), message: String(error?.message ?? error).slice(0, 1000) } }); }
        });
      }
    }
    await queue;
    return 0;
  } finally { screen.dispose(); }
}
