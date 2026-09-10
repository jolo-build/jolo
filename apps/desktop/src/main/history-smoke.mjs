import { writeFileSync } from 'node:fs';
import path from 'node:path';

// Exercise real renderer scrolling with a saved transcript larger than one page.
export async function runHistorySmoke({ window, bridge, results, evaluate, waitFor, report }) {
  await evaluate('window.__joloSmoke.newTask()');
  const sessionId = await evaluate('window.__joloSmoke.state().sessionId');
  const snapshot = await bridge.rawCall('session.page', { sessionId });
  const bodies = Array.from({ length: 388 }, (_, i) => `Saved message ${i}\n\nThis is earlier conversation text retained on disk.\n\nThe task history should remain accessible after reopening.`);
  const messages = bodies.map((text, ordinal) => ({ id: `history-${ordinal}`, artifactId: `history-${ordinal}`, runId: 'history-run', ordinal,
    role: ordinal % 2 ? 'assistant' : 'user', kind: 'text', status: 'complete', committedBytes: Buffer.byteLength(text) }));
  const original = bridge.call.bind(bridge);
  let failPage = true, olderRequests = 0;
  bridge.call = async (method, params) => {
    if (method === 'session.page' && params.sessionId === sessionId) {
      const end = params.beforeOrdinal ?? messages.length;
      if (params.beforeOrdinal !== undefined) {
        olderRequests++;
        await new Promise(resolve => setTimeout(resolve, 100));
        if (failPage) { failPage = false; return { ok: false, error: { code: 'unavailable', message: 'History fixture offline' } }; }
      }
      return { ok: true, result: { ...snapshot, messages: messages.slice(Math.max(0, end - 100), end), hasOlder: end > 100 } };
    }
    if (method === 'artifact.read' && params.artifactId.startsWith('history-')) {
      await new Promise(resolve => setTimeout(resolve, 4)); // progressive text must not shift the reading position
      const body = Buffer.from(bodies[Number(params.artifactId.slice(8))]);
      const offset = params.offset ?? 0;
      const text = body.subarray(offset, offset + (params.length ?? 65536));
      return { ok: true, result: { artifactId: params.artifactId, offset, text: text.toString(), bytes: text.length, committedBytes: body.length, eof: offset + text.length >= body.length, kind: 'text' } };
    }
    return original(method, params);
  };
  try {
    await evaluate(`window.__joloSmoke.selectSession(${JSON.stringify(sessionId)})`);
    await waitFor("document.querySelector('[data-message-id=\"history-387\"]')?.textContent.includes('Saved message 387')", 'latest page filled');
    await waitFor("document.querySelector('[data-message-id=\"history-288\"]')?.textContent.includes('Saved message 288')", 'first saved entry filled');
    const scrollTop = () => evaluate("(() => { const el = document.querySelector('.conversation'); el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); })()");
    await scrollTop();
    await waitFor("document.querySelector('.history-loader [role=alert]')", 'failed page offers retry');
    await new Promise(resolve => setTimeout(resolve, 150));
    if (olderRequests !== 1) throw new Error('failed history automatically retried in a loop');
    const anchorBefore = await evaluate("document.querySelector('[data-message-id=\"history-288\"]').getBoundingClientRect().top");
    await evaluate("document.querySelector('.history-loader button').click()");
    await waitFor("window.__joloSmoke.state().messageCount === 200 && !document.querySelector('.history-loader button')?.disabled", 'retry loads previous page');
    const anchorAfter = await evaluate("document.querySelector('[data-message-id=\"history-288\"]').getBoundingClientRect().top");
    if (Math.abs(anchorAfter - anchorBefore) > 2) throw new Error(`history moved the reading position: ${anchorBefore} -> ${anchorAfter}`);
    report.checks.push('failed history pages show a retry action and loading preserves the reading position');
    await scrollTop();
    await waitFor("window.__joloSmoke.state().messageCount === 300 && !document.querySelector('.history-loader button')?.disabled", 'scroll loads another page');
    await scrollTop();
    await waitFor("window.__joloSmoke.state().messageCount === 388 && document.querySelector('[data-message-id=\"history-0\"]')?.textContent.includes('Saved message 0')", 'earliest saved message restored');
    if (await evaluate("Boolean(document.querySelector('.history-loader'))")) throw new Error('history control remained after the first page');
    await scrollTop();
    writeFileSync(path.join(results, 'history.png'), (await window.webContents.capturePage()).toPNG());
    report.checks.push('scrolling back restores all 388 saved messages and removes the loader at the beginning');
  } finally { bridge.call = original; }
}
