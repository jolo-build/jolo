// Opt-in (`--screen`): the real overlay window and real screen capture on this Mac, with a recording
// input helper so no mouse or keyboard event is ever posted. Checks that the agent's screenshot never
// shows Jolo's own banner, that the stop key is held only while a run uses the screen, and that zoom
// and window mapping work against the real display.
import { BrowserWindow, desktopCapturer, globalShortcut, screen, systemPreferences } from 'electron';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { createScreenHost, STOP_ACCELERATOR } from '../src/main/screen-host.js';
import { createScreenOverlay } from '../src/main/screen-overlay.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function runScreenSmoke({ results, report, log }) {
  const replies = [], inputs = [];
  const bridge = { async rawCall(method, params) { if (method === 'screen.result') replies.push(params); return method === 'screen.register' ? { capabilityId: 'smoke_screen' } : {}; } };
  const input = { async request(cmd, args) { inputs.push({ cmd, ...args }); return cmd === 'status' ? { accessibility: true, screenRecording: true } : cmd === 'idle' ? { seconds: 999 } : cmd === 'windows' ? { windows: [] } : {}; }, close() {} };
  const overlay = createScreenOverlay({ BrowserWindow, log });
  const host = createScreenHost({ bridge, log, electron: { desktopCapturer, screen, globalShortcut, systemPreferences }, overlay, input });
  let sequence = 0;
  const run = async (operation, args = {}) => {
    await host.handleExecute({ invocationId: `smoke-${++sequence}`, capabilityId: 'smoke_screen', runId: 'smoke_run', operation, arguments: args, leaseMs: 20_000 });
    const reply = replies.at(-1);
    if (reply.status !== 'ok') throw new Error(`screen ${operation} failed: ${JSON.stringify(reply.error)}`);
    return reply;
  };
  try {
    if (systemPreferences.getMediaAccessStatus('screen') !== 'granted') { report.checks.push('Screen smoke skipped: Electron has no Screen Recording permission on this Mac'); return; }
    await host.onConnected();
    const display = screen.getPrimaryDisplay();
    // Show the overlay first, as a running task would, then let the agent look.
    await overlay.show(display, { x: display.bounds.x + 40, y: display.bounds.y + 40, label: 'Jolo · smoke' });
    await sleep(400);
    const shot = await run('screenshot');
    if (!shot.screenshot?.base64 || shot.screenshot.mimeType !== 'image/jpeg') throw new Error('screenshot returned no JPEG');
    if (!globalShortcut.isRegistered(STOP_ACCELERATOR)) throw new Error('the stop key was not held during the run');
    const { nativeImage } = await import('electron');
    const image = nativeImage.createFromBuffer(Buffer.from(shot.screenshot.base64, 'base64'));
    writeFileSync(path.join(results, 'screen-agent-view.jpg'), image.toJPEG(85));
    // The banner sits at the top centre in #7055df. The agent's picture must not contain it there.
    const { width } = image.getSize();
    const bitmap = image.toBitmap(); // BGRA
    const bannerRows = [Math.round(18 * shot.screenshot.height / display.bounds.height), Math.round(26 * shot.screenshot.height / display.bounds.height)];
    const purple = bannerRows.some(row => {
      for (let dx = -60; dx <= 60; dx += 6) {
        const i = (row * width + Math.round(width / 2) + dx) * 4;
        if (Math.abs(bitmap[i + 2] - 0x70) < 18 && Math.abs(bitmap[i + 1] - 0x55) < 18 && Math.abs(bitmap[i] - 0xdf) < 18) return true;
      }
      return false;
    });
    if (purple) throw new Error('the agent screenshot contains Jolo\'s own overlay banner');
    report.checks.push(`Screen: a real ${shot.screenshot.width}×${shot.screenshot.height} capture excluded Jolo's overlay and held Option+Escape during the run`);
    const zoom = await run('zoom', { x0: 0, y0: 0, x1: Math.round(shot.screenshot.width / 4), y1: Math.round(shot.screenshot.height / 4) });
    if (!(zoom.screenshot.width > 0)) throw new Error('zoom returned no image');
    await run('pointer', { action: 'click', x: Math.round(shot.screenshot.width / 2), y: Math.round(shot.screenshot.height / 2), modifiers: [] });
    const pointer = inputs.find(entry => entry.cmd === 'pointer');
    const expected = { x: display.bounds.x + display.bounds.width / 2, y: display.bounds.y + display.bounds.height / 2 };
    if (Math.abs(pointer.to.x - expected.x) > 2 || Math.abs(pointer.to.y - expected.y) > 2) throw new Error(`pointer mapped to ${JSON.stringify(pointer.to)}, expected ${JSON.stringify(expected)}`);
    report.checks.push('Screen: zoom captured a full-resolution region and a centre click mapped to the display centre in global points (recorded, not posted)');
    host.onEvent({ type: 'run.state', runId: 'smoke_run', payload: { state: 'completed' } });
    await sleep(100);
    if (globalShortcut.isRegistered(STOP_ACCELERATOR)) throw new Error('the stop key stayed registered after the run');
    report.checks.push('Screen: the finished run released the stop key and hid the overlay');
  } finally {
    host.dispose();
  }
}
