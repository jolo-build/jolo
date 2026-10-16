// Trackpad swipes arrive as wheel events, followed by momentum.
// Lock the axis early and allow one navigation per finger stroke.
export function chatSwipe(navigate, feedback = (_direction, _progress) => {}) {
  let last = -Infinity, x = 0, y = 0, travelX = 0, travelY = 0, axis = null, fired = false, blocked = false, direction = 0, reverse = 0;
  let contact = null;
  const reset = () => { last = -Infinity; x = 0; y = 0; travelX = 0; travelY = 0; axis = null; fired = false; blocked = false; direction = 0; reverse = 0; contact = null; };
  const receive = (event, allowed = true) => {
    // macOS emits zero-motion phase events at gesture boundaries. They must
    // not claim an axis or block the following movement over a chat surface.
    if (!event.deltaX && !event.deltaY) return false;
    const gap = event.timeStamp - last;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 800 : 1;
    const magnitude = Math.abs(event.deltaX * unit);
    const verticalMagnitude = Math.abs(event.deltaY * unit);
    if (gap > 180) reset();
    // Vertical scrolling can interrupt horizontal momentum without ANY gap in
    // wheel delivery. Release horizontal ownership before the reversal logic
    // can add its sideways drift toward another navigation. This also covers
    // vertical strokes whose first small packet briefly looked horizontal.
    if (axis === 'x' && verticalMagnitude >= 8 && verticalMagnitude > magnitude * 1.5) {
      reset(); last = event.timeStamp; y = event.deltaY * unit; travelY = verticalMagnitude; axis = 'y';
      feedback(0, 0);
      return false;
    }
    // Likewise, a fresh horizontal stroke may follow vertical scrolling
    // without waiting for the old wheel transaction to time out.
    if (axis === 'y' && gap >= 24 && magnitude >= 8 && magnitude > verticalMagnitude * 1.5) reset();
    // Chromium can omit gestureScrollBegin when a new finger stroke interrupts
    // cancelled momentum. A real stroke restarts with a few small, accelerating
    // samples. Keep those samples as a candidate and only rearm after two rises;
    // a lone delayed momentum packet must never walk through the whole chat rail.
    if (fired && !contact && gap >= 24 && magnitude <= 16) {
      contact = { sign: Math.sign(event.deltaX), total: magnitude, vertical: verticalMagnitude, last: magnitude, peak: magnitude, rises: 0, started: event.timeStamp };
      last = event.timeStamp;
      return true;
    }
    if (fired && contact) {
      const sign = Math.sign(event.deltaX);
      if (gap >= 24 || !sign || sign !== contact.sign || event.timeStamp - contact.started > 120) contact = null;
      else {
        if (magnitude > contact.last * 1.2) contact.rises++;
        contact.total += magnitude;
        contact.vertical += verticalMagnitude;
        contact.last = magnitude;
        contact.peak = Math.max(contact.peak, magnitude);
        last = event.timeStamp;
        // Residual horizontal momentum often overlaps the first few packets of
        // a vertical scroll. It can accumulate past the distance threshold but
        // remains a stream of small samples. A deliberate new horizontal stroke
        // has both acceleration and a clear peak in real macOS traces.
        if (contact.vertical >= 8 && contact.vertical > contact.total * 0.5) {
          reset(); last = event.timeStamp; y = event.deltaY * unit; travelY = verticalMagnitude; axis = 'y';
          return false;
        }
        if (contact.total < 36 || contact.rises < 2 || contact.peak < 18) return true;
        const fresh = contact;
        reset();
        last = event.timeStamp;
        axis = 'x'; direction = fresh.sign; x = fresh.sign * fresh.total; y = fresh.vertical;
        travelX = fresh.total; travelY = fresh.vertical;
        feedback(direction, 1); fired = true;
        return navigate(direction) !== false;
      }
    }
    last = event.timeStamp;
    if (!allowed || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) blocked = true;
    if (blocked) return false;
    x += event.deltaX * unit; y += event.deltaY * unit;
    travelX += magnitude; travelY += verticalMagnitude;
    // Axis intent is based on total travel rather than the signed sums. During
    // an up/down scroll, opposite vertical packets can cancel numerically even
    // though the fingers have moved much farther vertically than horizontally.
    if (!axis && Math.max(travelX, travelY) >= 8) axis = travelX > travelY * 1.5 ? 'x' : 'y';
    if (axis !== 'x') return false;
    const dx = event.deltaX * unit;
    if (!direction) direction = Math.sign(x);
    // A new swipe can reverse while the previous gesture's momentum is still
    // arriving. Do not make it cancel thousands of accumulated pixels first.
    // Tiny opposite ticks are inertia/noise, not a second navigation.
    if (dx && Math.sign(dx) !== direction) {
      reverse += Math.abs(dx);
      if (reverse < 36) { feedback(Math.sign(dx), reverse / 36); return true; }
      direction = Math.sign(dx); x = direction * reverse; reverse = 0; fired = false;
    } else if (dx) reverse = 0;
    if (!fired) feedback(direction, Math.min(1, Math.abs(x) / 36));
    if (!fired && Math.abs(x) >= 36) { fired = true; return navigate(direction) !== false; }
    return true;
  };
  receive.begin = reset;
  return receive;
}

export function canSwipeChat(target, boundary) {
  if (!(target instanceof Element) || !boundary.contains(target)) return false;
  for (let element = target; element && element !== boundary; element = element.parentElement) {
    if (element.matches('input, select, [contenteditable]:not([contenteditable="false"]), webview, iframe, .xterm')) return false;
    // Reserve the entire gesture for a horizontally scrollable child, even at
    // its edge: momentum must never unexpectedly switch to a different chat.
    if (element.scrollWidth > element.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(element).overflowX)) return false;
  }
  return true;
}

// Wheel deltas are content movement; macOS can invert them relative to fingers.
export function railSwipeDirection(wheelDirection, naturalScrolling) {
  return naturalScrolling ? -wheelDirection : wheelDirection;
}
