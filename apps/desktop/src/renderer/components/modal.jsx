import { useEffect, useRef } from 'react';
/**
 * Native dialog supplies keyboard trapping, an inert background, and focus restoration.
 *
 * @param {{
 *   children: import('react').ReactNode,
 *   label: string,
 *   onClose: () => void,
 *   onKeyDown?: import('react').KeyboardEventHandler<HTMLDialogElement>,
 *   initialFocus?: { current: HTMLElement | null },
 *   className?: string,
 *   style?: import('react').CSSProperties,
 * }} props `onKeyDown` and `initialFocus` belong to dialogs with a primary action; most have neither.
 */
export function Modal({ children, label, onClose, onKeyDown, initialFocus, className = '', style }) {
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
    // Whatever had focus before the dialog opened; only elements that can take focus back matter here.
    const previous = /** @type {HTMLElement} */ (document.activeElement);
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
  return <dialog ref={dialog} className={`modal ${className}`} style={style} aria-label={label}
    onKeyDown={onKeyDown}
    onPointerDown={(event) => { backdropPress.current = event.button === 0 && isBackdrop(event); }}
    onPointerCancel={() => { backdropPress.current = false; }}
    onClick={(event) => {
      const dismiss = backdropPress.current && isBackdrop(event);
      backdropPress.current = false;
      if (dismiss) { event.stopPropagation(); close.current?.(); }
    }}>{children}</dialog>;
}
