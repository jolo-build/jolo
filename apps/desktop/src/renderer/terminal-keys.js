/** emacs backward-word / forward-word. bash, zsh, and fish bind these. Kitty sends the same for Option+arrow. */
const WORD_BACKWARD = '\u001bb';
const WORD_FORWARD = '\u001bf';
/** Modified cursor keys. PSReadLine and Git Bash's inputrc bind these on Windows. */
const CTRL_LEFT = '\u001b[1;5D';
const CTRL_RIGHT = '\u001b[1;5C';
const ALT_LEFT = '\u001b[1;3D';
const ALT_RIGHT = '\u001b[1;3C';

/**
 * Ctrl+arrow and Alt/Option+arrow move by word.
 * Unix shells already bind the emacs sequences. Windows shells bind the modified cursor keys instead.
 * Shift stays with xterm so a selection can still grow by cells.
 * @param {Pick<KeyboardEvent, 'type' | 'key' | 'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey'>} event
 * @param {string} [platform] `process.platform`: `darwin`, `linux`, or `win32`
 * @returns {string | null}
 */
export function wordMotion(event, platform = 'linux') {
  if (event.type !== 'keydown' || event.metaKey || event.shiftKey) return null;
  const alt = event.altKey && !event.ctrlKey;
  const ctrl = event.ctrlKey && !event.altKey;
  if (!alt && !ctrl) return null;
  const left = event.key === 'ArrowLeft';
  const right = event.key === 'ArrowRight';
  if (!left && !right) return null;
  if (platform === 'win32') {
    if (ctrl) return left ? CTRL_LEFT : CTRL_RIGHT;
    return left ? ALT_LEFT : ALT_RIGHT;
  }
  return left ? WORD_BACKWARD : WORD_FORWARD;
}
