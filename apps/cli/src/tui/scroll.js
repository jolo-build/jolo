import { scrollHistory } from "./layout.js";

// A trackpad can send many packets in one stdin read. Preserve their full distance
// and boundary clamping, but commit just one viewport update per display frame.
/**
 * The frame handle stays opaque: `setTimeout` hands back a Node timer, a test hands back a
 * number, and this only ever passes it straight to `cancel`.
 * @param {{
 *   read: () => { lines: any[], height: number, top: number | null },
 *   write: (top: number | null) => void,
 *   schedule?: (callback: () => void) => unknown,
 *   cancel?: (handle: any) => void,
 * }} options
 */
export function createWheelScroller({ read, write, schedule = (callback) => setTimeout(callback, 16), cancel = clearTimeout }) {
  let frame = null;
  let target = null;
  return {
    push(delta) {
      const { lines, height, top } = read();
      target = scrollHistory(lines, height, frame === null ? top : target, delta);
      if (frame !== null) return;
      frame = schedule(() => {
        frame = null;
        write(target);
      });
    },
    cancel() {
      if (frame !== null) cancel(frame);
      frame = null;
    },
  };
}
