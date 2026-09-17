import { expect } from 'bun:test';
import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { waitFor } from './helpers.js';

// All hosted transports must open a closed pane and control it on first and resumed turns.
export async function checkHostedBrowser({ client, engine, project, runTo, messagesOf, text, repo }, { attachAfterStart = false } = {}) {
  const host = await engine.connect({ clientKind: 'desktop' });
  const received = [];
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  let capabilityId;
  host.onNotification('browser.execute', async params => {
    received.push(params.operation);
    await host.call('browser.result', { invocationId: params.invocationId, status: 'ok', result: { snapshotId: 'snapshot', nodes: [{ ref: 'e2', role: 'textbox' }] },
      ...(params.operation === 'screenshot' ? { screenshot: { base64: png, width: 1, height: 1, mimeType: 'image/png' } } : {}) });
  });
  host.onNotification('browser.open', async params => {
    received.push('open');
    ({ capabilityId } = await host.call('browser.register', { workspaceId: project.workspaceId, tabId: 'hosted-tab', navigationRevision: 0, operations: ['snapshot', 'fill', 'screenshot'] }));
    await host.call('browser.openResult', { invocationId: params.invocationId, capabilityId });
  });
  if (attachAfterStart) writeFileSync(path.join(repo, '.fake-browser-reconnect'), '1');
  else await host.call('browser.setOpener', { workspaceIds: [project.workspaceId] });
  try {
    for (const requestId of ['browser-first', 'browser-resumed']) {
      const running = runTo(requestId, 'browser-check');
      if (attachAfterStart && requestId === 'browser-first') {
        await waitFor(() => existsSync(path.join(repo, '.fake-browser-unavailable')), { label: 'hosted run attempted browser_open without a desktop host' });
        await host.call('browser.setOpener', { workspaceIds: [project.workspaceId] });
        writeFileSync(path.join(repo, '.fake-browser-connected'), '1');
        unlinkSync(path.join(repo, '.fake-browser-reconnect'));
      }
      const run = await running;
      if (run.state !== 'completed') throw new Error(`browser run ${run.state}: ${run.failure}`);
      expect(run.state).toBe('completed');
      expect(await text((await messagesOf(run.id)).at(-1))).toBe('Browser controlled; screenshot received as an image');
      await host.call('browser.unregister', { capabilityId });
    }
    expect(received).toEqual(['open', 'snapshot', 'fill', 'screenshot', 'open', 'snapshot', 'fill', 'screenshot']);
  } finally { await host.close(); await client.close(); }
}
