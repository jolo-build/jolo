import { useEffect, useRef } from 'react';
/** Native dialog supplies keyboard trapping, an inert background, and focus restoration. */
export function Modal({ children, label, onClose, onKeyDown, initialFocus, className = '' }) {
  const dialog = useRef(null);
  const backdropPress = useRef(false);
  const close = useRef(onClose);
  close.current = onClose;
  const isBackdrop = (event) => {
    if (event.target !== event.currentTarget) return false;
    const bounds = event.currentTarget.getBoundingClientRect();
    return event.clientX < bounds.left || event.clientX >= bounds.right || event.clientY < bounds.top || event.clientY >= bounds.bottom;
  };
  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement;
    element.showModal();
    initialFocus?.current?.focus();
    const cancel = (event) => { event.preventDefault(); close.current?.(); };
    element.addEventListener('cancel', cancel);
    return () => {
      element.removeEventListener('cancel', cancel);
      element.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return <dialog ref={dialog} className={`modal ${className}`} aria-label={label}
    onKeyDown={onKeyDown}
    onPointerDown={(event) => { backdropPress.current = event.button === 0 && isBackdrop(event); }}
    onPointerCancel={() => { backdropPress.current = false; }}
    onClick={(event) => {
      const dismiss = backdropPress.current && isBackdrop(event);
      backdropPress.current = false;
      if (dismiss) { event.stopPropagation(); close.current?.(); }
    }}>{children}</dialog>;
}
