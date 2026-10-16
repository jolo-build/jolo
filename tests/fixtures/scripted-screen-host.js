// A scripted desktop screen host speaking the same socket protocol as the Electron main process.
// It never touches the real screen: every operation is answered from fixed data or a per-test plan.
import { SCREEN_OPERATIONS } from '@jolo/protocol';

// 1x1 JPEG
export const JPEG_BASE64 = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

/**
 * @param {any} engine a started test engine
 * @param {{ interruptOn?: string[], vanishOn?: string[], permissions?: { accessibility: boolean, screenRecording: boolean } }} [options]
 *   `interruptOn` names operations answered as if the user had touched the mouse; `vanishOn` names
 *   operations during which the desktop disconnects without answering.
 */
export async function scriptedScreenHost(engine, { interruptOn = [], vanishOn = [], permissions = { accessibility: true, screenRecording: true } } = {}) {
  const client = await engine.connect({ clientKind: 'desktop' });
  const received = [];
  client.onNotification('screen.execute', async (params) => {
    received.push(params);
    const reply = (body) => client.call('screen.result', { invocationId: params.invocationId, ...body });
    if (vanishOn.includes(params.operation)) { await client.close(); return; }
    if (interruptOn.includes(params.operation)) return reply({ status: 'interrupted', error: { code: 'user_input', message: 'The user used the mouse or keyboard.' } });
    const args = params.arguments;
    switch (params.operation) {
      case 'screenshot': return reply({ status: 'ok', result: { width: 1, height: 1, display: { width: 1800, height: 1169, scale: 2 } }, screenshot: { base64: JPEG_BASE64, width: 1, height: 1, mimeType: 'image/jpeg' } });
      case 'windows': return reply({ status: 'ok', result: { windows: [{ app: 'Helium', title: 'Google', pid: 42, onscreen: true, bounds: { x: 0, y: 0, width: 1, height: 1 } }], space: { width: 1, height: 1 } } });
      default: return reply({ status: 'ok', result: { operation: params.operation, ...args } });
    }
  });
  const { capabilityId } = await client.call('screen.register', { platform: 'darwin', display: { id: 1, width: 1800, height: 1169, scale: 2 }, operations: [...SCREEN_OPERATIONS], permissions });
  return { client, received, capabilityId };
}
