import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProcessSupervisor } from '../src/processes/supervisor.js';

test('command spool failures reject the tool and close its writer without crashing the engine', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jolo-spool-')); let closed = 0;
  const supervisor = new ProcessSupervisor({ recoveryDir: dir, env: { path: process.env.PATH }, log: { warn() {} }, storage: {
    createArtifact: () => ({ id: 'a', storageKey: 'a' }), finalizeArtifact() {},
    openArtifactWriter: () => ({ append() { throw new Error('disk full'); }, close() { closed++; return 0; } }),
  } });
  try {
    await expect(supervisor.run({ invocationId: 'i', sessionId: 's', command: [process.execPath, '-e', 'console.log("output"); setInterval(() => {}, 1000)'], cwd: dir, timeoutMs: 1000, signal: new AbortController().signal })).rejects.toThrow('disk full');
    expect(closed).toBeGreaterThan(0); expect(supervisor.active.size).toBe(0);
  } finally { await supervisor.stopAll(); rmSync(dir, { recursive: true, force: true }); }
});
