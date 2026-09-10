import { scrollHistory } from "./layout.js";

// A trackpad can send many packets in one stdin read. Preserve their full distance
// and boundary clamping, but commit just one viewport update per display frame.
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
