import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createModelChoiceStore, restoreModelAgent } from '../src/tui/model-choice.js';

test('terminal agent choice survives new stores, is profile scoped, and can return to Jolo', async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'jolo-choice-'));
  try {
    const store = createModelChoiceStore({ dataDir });
    expect(store.read()).toBeNull();
    store.write('codex');
    const reopened = createModelChoiceStore({ dataDir });
    expect(reopened.read()).toBe('codex');
    expect(createModelChoiceStore({ dataDir: path.join(dataDir, 'other-profile') }).read()).toBeNull();
    const client = agents => ({ call: async () => ({ agents }) });
    expect(await restoreModelAgent(client([{ id: 'codex', available: true, transport: 'codex-app-server' }]), reopened)).toBe('codex');
    for (const agents of [[], [{ id: 'codex', available: false, transport: 'codex-app-server' }], [{ id: 'codex', available: true, transport: 'pty' }]]) {
      expect(await restoreModelAgent(client(agents), reopened)).toBeNull();
    }
    expect(await restoreModelAgent({ call: async () => { throw new Error('offline'); } }, reopened)).toBeNull();
    store.write(null);
    expect(reopened.read()).toBeNull();
    writeFileSync(path.join(dataDir, 'cli', 'model-choice.json'), '{broken');
    expect(reopened.read()).toBeNull();
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
