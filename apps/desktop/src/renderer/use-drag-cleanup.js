import { useCallback, useEffect, useRef } from 'react';

/** A native webview can interrupt pointer capture; never leave the app in drag mode. */
export function useDragCleanup(finish) {
  const latest = useRef(finish);
  const captured = useRef(null);
  latest.current = finish;
  const release = useCallback(() => {
    const pointer = captured.current;
    captured.current = null;
    // Electron can reuse the embedder's last cursor while a guest navigates.
    // Reset the handle itself, not only the dragging class, before giving the
    // pointer back to the page. Restore its resize affordance on the next entry.
    if (pointer) pointer.element.style.cursor = 'auto';
    if (pointer?.element.hasPointerCapture(pointer.id)) pointer.element.releasePointerCapture(pointer.id);
  }, []);
  const end = useCallback(() => { latest.current(); release(); }, [release]);
  const capture = useCallback(event => {
    release();
    event.currentTarget.style.removeProperty('cursor');
    captured.current = { element: event.currentTarget, id: event.pointerId };
    try { event.currentTarget.setPointerCapture(event.pointerId); }
    catch { end(); }
  }, [release, end]);
  useEffect(() => {
    const idle = event => { if ((event.buttons & 1) === 0) end(); };
    const hidden = () => { if (document.hidden) end(); };
    // Let the divider apply the final pointer position before global cleanup.
    for (const type of ['pointerup', 'mouseup', 'pointercancel', 'blur', 'jolo:browser-focus']) window.addEventListener(type, end);
    for (const type of ['pointermove', 'mousemove']) window.addEventListener(type, idle, true);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      end();
      for (const type of ['pointerup', 'mouseup', 'pointercancel', 'blur', 'jolo:browser-focus']) window.removeEventListener(type, end);
      for (const type of ['pointermove', 'mousemove']) window.removeEventListener(type, idle, true);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, [end]);
  const enter = useCallback(event => { event.currentTarget.style.removeProperty('cursor'); }, []);
  const leave = useCallback(event => { if (!captured.current) event.currentTarget.style.cursor = 'auto'; }, []);
  return { capture, end, enter, leave };
}
