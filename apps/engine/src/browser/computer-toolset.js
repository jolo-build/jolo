// The Messages API's native computer toolset, expressed in terms of Jolo's portable browser tools.
// A preset with `computerUse: 'native'` declares the toolset instead of the four portable tools it
// covers; each member call the model makes is translated into the portable tool the dispatcher
// already admits, executes and records, so policy, leases and the transcript never see the vendor
// shape. The original block is kept beside the call for faithful replay (§7.1).
import { KEY_NAMES } from '../tools/browser.js';

export const COMPUTER_TOOLSET_TYPE = 'computer_toolset_20260801';
export const COMPUTER_TOOLSET_NAME = 'computer';
/** Portable tools the toolset replaces when it is declared. The reference-based tools stay. */
export const TOOLSET_REPLACES = Object.freeze(['browser_screenshot', 'browser_zoom', 'browser_pointer', 'browser_wait']);
/** Members the inline browser cannot honour are withheld rather than answered with errors. */
export const TOOLSET_DECLARATION = Object.freeze({
  type: COMPUTER_TOOLSET_TYPE,
  configs: { hold_key: { enabled: false }, cursor_position: { enabled: false }, left_mouse_down: { enabled: false }, left_mouse_up: { enabled: false } },
});
const SCROLL_STEP_PX = 120;
const WAIT_MAX_MS = 10_000;
const CLICKS = { left_click: 'click', right_click: 'right_click', middle_click: 'middle_click', double_click: 'double_click', triple_click: 'triple_click' };
const MODIFIERS = { ctrl: 'Control', control: 'Control', alt: 'Alt', option: 'Alt', shift: 'Shift', super: 'Meta', cmd: 'Meta', command: 'Meta', meta: 'Meta', win: 'Meta' };
const KEYS = { return: 'Enter', enter: 'Enter', kp_enter: 'Enter', tab: 'Tab', escape: 'Escape', esc: 'Escape', backspace: 'Backspace', delete: 'Delete', del: 'Delete', insert: 'Insert',
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
  home: 'Home', end: 'End', page_up: 'PageUp', pageup: 'PageUp', prior: 'PageUp', page_down: 'PageDown', pagedown: 'PageDown', next: 'PageDown', space: 'Space', ...Object.fromEntries(KEY_NAMES.map(name => [name.toLowerCase(), name])) };

/** `ctrl+shift+s` → the key and modifiers browser_press takes. Unknown names pass through and fail validation. */
export function parseKeyCombo(text) {
  const parts = String(text ?? '').split('+').map(part => part.trim()).filter(Boolean);
  const modifiers = [];
  let key = '';
  for (const part of parts) {
    const modifier = MODIFIERS[part.toLowerCase()];
    if (modifier && part !== parts.at(-1)) { if (!modifiers.includes(modifier)) modifiers.push(modifier); }
    else key = part.length === 1 ? part : KEYS[part.toLowerCase()] ?? part;
  }
  if (key === ' ') key = 'Space';
  return { key, modifiers };
}

const point = value => Array.isArray(value) && value.length === 2 ? { x: Math.round(Number(value[0])), y: Math.round(Number(value[1])) } : null;
const modifiersOf = text => text ? parseKeyCombo(`${text}+x`).modifiers : [];

/** Translate one toolset member call into a portable tool call, or null when the member is not supported. */
export function memberToTool(member, input = {}) {
  if (member === 'screenshot') return { name: 'browser_screenshot', arguments: {} };
  if (member === 'zoom') {
    const region = Array.isArray(input.region) && input.region.length === 4 ? input.region.map(Number) : null;
    return region ? { name: 'browser_zoom', arguments: { x0: Math.round(region[0]), y0: Math.round(region[1]), x1: Math.round(region[2]), y1: Math.round(region[3]) } } : { name: 'browser_zoom', arguments: input };
  }
  if (CLICKS[member] || member === 'mouse_move') {
    const at = point(input.coordinate);
    return { name: 'browser_pointer', arguments: { action: member === 'mouse_move' ? 'move' : CLICKS[member], ...(at ?? {}), modifiers: modifiersOf(input.text) } };
  }
  if (member === 'left_click_drag') {
    const from = point(input.start_coordinate), to = point(input.coordinate);
    return { name: 'browser_pointer', arguments: { action: 'drag', ...(from ?? {}), ...(to ? { toX: to.x, toY: to.y } : {}), modifiers: modifiersOf(input.text) } };
  }
  if (member === 'scroll') {
    const at = point(input.coordinate);
    const amount = Math.max(0, Number(input.scroll_amount) || 0) * SCROLL_STEP_PX;
    const delta = { up: { deltaY: -amount }, down: { deltaY: amount }, left: { deltaX: -amount }, right: { deltaX: amount } }[input.scroll_direction] ?? {};
    return { name: 'browser_scroll', arguments: { ...(at ?? {}), ...delta } };
  }
  if (member === 'type') return { name: 'browser_type', arguments: { text: String(input.text ?? '') } };
  if (member === 'key') return { name: 'browser_press', arguments: { ...parseKeyCombo(input.text), ...(input.repeat ? { repeat: Math.max(1, Math.min(50, Math.round(Number(input.repeat)))) } : {}) } };
  if (member === 'wait') return { name: 'browser_wait', arguments: { ms: Math.max(100, Math.min(WAIT_MAX_MS, Math.round((Number(input.duration) || 1) * 1000))) } };
  return null;
}

/**
 * The inverse: a portable computer-use call (made under another preset or before the toolset was
 * enabled) as the member it corresponds to, so a transcript replays with the toolset declared.
 */
export function toolToMember(name, args = {}) {
  const coordinate = [args.x ?? 0, args.y ?? 0];
  const text = args.modifiers?.length ? { text: args.modifiers.map(modifier => modifier.toLowerCase() === 'control' ? 'ctrl' : modifier.toLowerCase() === 'meta' ? 'super' : modifier.toLowerCase()).join('+') } : {};
  if (name === 'browser_screenshot') return { name: 'screenshot', input: {} };
  if (name === 'browser_zoom') return { name: 'zoom', input: { region: [args.x0 ?? 0, args.y0 ?? 0, args.x1 ?? 0, args.y1 ?? 0] } };
  if (name === 'browser_wait') return { name: 'wait', input: { duration: (args.ms ?? 1000) / 1000 } };
  if (name === 'browser_pointer') {
    if (args.action === 'drag') return { name: 'left_click_drag', input: { start_coordinate: coordinate, coordinate: [args.toX ?? 0, args.toY ?? 0], ...text } };
    if (args.action === 'move') return { name: 'mouse_move', input: { coordinate } };
    const member = Object.entries(CLICKS).find(([, action]) => action === args.action)?.[0] ?? 'left_click';
    return { name: member, input: { coordinate, ...text } };
  }
  return null;
}

/** The toolset is declared only while the portable tools it stands in for are declared. */
export function declaresToolset(tools) {
  return tools.some(tool => tool.name === 'browser_screenshot') && tools.some(tool => tool.name === 'browser_pointer');
}
