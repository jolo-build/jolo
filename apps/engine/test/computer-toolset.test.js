import { expect, test } from 'bun:test';
import { BROWSER_OPERATIONS, parseParams } from '@jolo/protocol';
import { ToolRegistry } from '../src/tools/registry.js';
import { browserTools, POINTER_ACTIONS } from '../src/tools/browser.js';
import { TOOLSET_DECLARATION, TOOLSET_REPLACES, declaresToolset, memberToTool, parseKeyCombo, toolToMember } from '../src/browser/computer-toolset.js';

test('every computer-use operation has a portable tool the public browser call surface admits', () => {
  const registry = new ToolRegistry();
  for (const operation of ['zoom', 'pointer', 'wait']) {
    expect(BROWSER_OPERATIONS).toContain(operation);
    expect(registry.get(`browser_${operation}`)).toBeDefined();
    expect(parseParams('browser.call', { workspaceId: 'ws', name: `browser_${operation}`, arguments: {} }).ok).toBe(true);
  }
  expect(browserTools.find(tool => tool.name === 'browser_wait').executionClass).toBe('browser_read');
  expect(browserTools.find(tool => tool.name === 'browser_pointer').executionClass).toBe('browser_action');
});

test('the computer-use tools validate coordinates, regions, keys and focus-based typing', () => {
  const registry = new ToolRegistry();
  expect(registry.validate('browser_pointer', { action: 'click', x: 10, y: 20 }).args).toMatchObject({ action: 'click', x: 10, y: 20, modifiers: [] });
  expect(registry.validate('browser_pointer', { action: 'drag', x: 1, y: 2, toX: 30, toY: 40, modifiers: ['Shift'] }).args.toX).toBe(30);
  expect(() => registry.validate('browser_pointer', { action: 'drag', x: 1, y: 2 })).toThrow('drag needs toX and toY');
  expect(() => registry.validate('browser_pointer', { action: 'click', x: -1, y: 2 })).toThrow();
  expect(() => registry.validate('browser_pointer', { action: 'left_click', x: 1, y: 2 })).toThrow();
  for (const action of POINTER_ACTIONS) expect(registry.validate('browser_pointer', { action, x: 1, y: 2, toX: 3, toY: 4 }).args.action).toBe(action);
  expect(registry.validate('browser_zoom', { x0: 0, y0: 0, x1: 100, y1: 50 }).args).toMatchObject({ x1: 100 });
  expect(() => registry.validate('browser_zoom', { x0: 100, y0: 0, x1: 100, y1: 50 })).toThrow('positive width');
  expect(registry.validate('browser_scroll', { x: 5, y: 6, deltaY: 300 }).args).toMatchObject({ x: 5, y: 6, deltaY: 300 });
  expect(registry.validate('browser_type', { text: 'hello' }).args.ref).toBeUndefined();
  expect(registry.validate('browser_fill', { text: '' }).args.text).toBe('');
  expect(registry.validate('browser_wait', {}).args.ms).toBe(1000);
  expect(() => registry.validate('browser_wait', { ms: 60_000 })).toThrow();
  for (const key of ['Enter', 'F5', 'a', 'Z', '?', '/', 'Space', 'PageDown']) expect(registry.validate('browser_press', { key, modifiers: ['Control'], repeat: 3 }).args.repeat).toBe(3);
  expect(() => registry.validate('browser_press', { key: 'arbitrary-code' })).toThrow();
  expect(() => registry.validate('browser_press', { key: 'ctrl+s' })).toThrow();
  // Provider declarations stay portable JSON Schema: the refinements never leak vendor keywords.
  const declared = /** @type {any} */ (registry.declarations({ browserAvailable: true }).find(tool => tool.name === 'browser_pointer'));
  expect(declared.parameters.properties.action.enum).toEqual([...POINTER_ACTIONS]);
  expect(JSON.stringify(declared.parameters)).not.toContain('additionalProperties');
});

test('toolset member calls translate into portable tool calls and back', () => {
  expect(memberToTool('screenshot', {})).toEqual({ name: 'browser_screenshot', arguments: {} });
  expect(memberToTool('left_click', { coordinate: [512, 742] })).toEqual({ name: 'browser_pointer', arguments: { action: 'click', x: 512, y: 742, modifiers: [] } });
  expect(memberToTool('right_click', { coordinate: [5.4, 6.6], text: 'ctrl+shift' })).toEqual({ name: 'browser_pointer', arguments: { action: 'right_click', x: 5, y: 7, modifiers: ['Control', 'Shift'] } });
  expect(memberToTool('double_click', { coordinate: [1, 1] }).arguments.action).toBe('double_click');
  expect(memberToTool('mouse_move', { coordinate: [9, 8] }).arguments).toMatchObject({ action: 'move', x: 9, y: 8 });
  expect(memberToTool('left_click_drag', { start_coordinate: [1, 2], coordinate: [3, 4] }).arguments).toMatchObject({ action: 'drag', x: 1, y: 2, toX: 3, toY: 4 });
  expect(memberToTool('zoom', { region: [100, 200, 400, 350] })).toEqual({ name: 'browser_zoom', arguments: { x0: 100, y0: 200, x1: 400, y1: 350 } });
  expect(memberToTool('scroll', { scroll_direction: 'down', scroll_amount: 3, coordinate: [50, 60] })).toEqual({ name: 'browser_scroll', arguments: { x: 50, y: 60, deltaY: 360 } });
  expect(memberToTool('scroll', { scroll_direction: 'left', scroll_amount: 1 }).arguments).toEqual({ deltaX: -120 });
  expect(memberToTool('type', { text: 'hi' })).toEqual({ name: 'browser_type', arguments: { text: 'hi' } });
  expect(memberToTool('key', { text: 'ctrl+s' })).toEqual({ name: 'browser_press', arguments: { key: 's', modifiers: ['Control'] } });
  expect(memberToTool('key', { text: 'Return', repeat: 2 })).toEqual({ name: 'browser_press', arguments: { key: 'Enter', modifiers: [], repeat: 2 } });
  expect(memberToTool('wait', { duration: 2 })).toEqual({ name: 'browser_wait', arguments: { ms: 2000 } });
  expect(memberToTool('wait', { duration: 400 }).arguments.ms).toBe(10_000);
  expect(memberToTool('hold_key', { text: 'a', duration: 1 })).toBeNull();
  // Every translation is a call the registry admits.
  const registry = new ToolRegistry();
  for (const [member, input] of [['left_click', { coordinate: [1, 2] }], ['zoom', { region: [0, 0, 10, 10] }], ['scroll', { scroll_direction: 'up', scroll_amount: 2 }], ['key', { text: 'alt+Page_Down' }], ['type', { text: 'x' }], ['wait', { duration: 1 }]]) {
    const call = memberToTool(member, input);
    expect(() => registry.validate(call.name, call.arguments)).not.toThrow();
  }
  expect(parseKeyCombo('super+shift+Left')).toEqual({ key: 'ArrowLeft', modifiers: ['Meta', 'Shift'] });
  expect(parseKeyCombo('space')).toEqual({ key: 'Space', modifiers: [] });
  expect(parseKeyCombo('BackSpace')).toEqual({ key: 'Backspace', modifiers: [] });
  // The inverse expresses portable calls as members, so a transcript replays with the toolset declared.
  expect(toolToMember('browser_pointer', { action: 'click', x: 1, y: 2, modifiers: ['Control', 'Meta'] })).toEqual({ name: 'left_click', input: { coordinate: [1, 2], text: 'ctrl+super' } });
  expect(toolToMember('browser_pointer', { action: 'drag', x: 1, y: 2, toX: 3, toY: 4, modifiers: [] })).toEqual({ name: 'left_click_drag', input: { start_coordinate: [1, 2], coordinate: [3, 4] } });
  expect(toolToMember('browser_pointer', { action: 'triple_click', x: 0, y: 0 }).name).toBe('triple_click');
  expect(toolToMember('browser_zoom', { x0: 1, y0: 2, x1: 3, y1: 4 })).toEqual({ name: 'zoom', input: { region: [1, 2, 3, 4] } });
  expect(toolToMember('browser_wait', { ms: 2500 })).toEqual({ name: 'wait', input: { duration: 2.5 } });
  expect(toolToMember('browser_click', { ref: 'e1' })).toBeNull();
  for (const name of TOOLSET_REPLACES) expect(toolToMember(name, { action: 'click', x: 0, y: 0 })).not.toBeNull();
  expect(TOOLSET_DECLARATION.type).toBe('computer_toolset_20260801');
  expect(declaresToolset(registry.declarations({ browserAvailable: true }))).toBe(true);
  expect(declaresToolset(registry.declarations({ browserAvailable: false }))).toBe(false);
});
