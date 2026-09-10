import { ProtocolError } from '@jolo/protocol';
const INTERACTIVE_KINDS = new Set(['desktop', 'tui', 'test']);
// Client kind describes a frontend, not an OS identity. Scoped guest credentials
// can never gain this capability by claiming an interactive kind in hello.
export const isInteractive = conn => !conn.capability && INTERACTIVE_KINDS.has(conn.kind);
export function requireInteractive(conn, message = 'this operation requires an interactive client') {
  if (!isInteractive(conn)) throw new ProtocolError('permission_denied', message);
}
