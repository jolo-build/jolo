import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveToolEnvironment } from '../src/tools/dispatcher.js';
import { createCatalog } from '../src/agents/catalog.js';

test('Finder PATH discovers a locally installed Codex and uses it to launch', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'jolo-agent-path-'));
  try {
    const bin = path.join(home, '.local/bin');
    mkdirSync(bin, { recursive: true });
    const codex = path.join(bin, 'codex');
    writeFileSync(codex, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const env = resolveToolEnvironment({ HOME: home, PATH: '/usr/bin:/bin' });
    const catalog = createCatalog({ dir: path.join(home, 'agents'), env, shell: '/bin/sh', log: null });
    expect(catalog.list().find(agent => agent.id === 'codex')).toMatchObject({ available: true, resolvedPath: codex });
    expect(catalog.command(catalog.get('codex'))[0]).toBe(codex);
    expect(env.path.split(path.delimiter)).toContain('/opt/homebrew/bin');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('caller path precedence and explicit tool restrictions are preserved', () => {
  const env = resolveToolEnvironment({ HOME: '/example', PATH: '/custom/bin:/usr/bin:/custom/bin' });
  expect(env.path.split(path.delimiter).slice(0, 2)).toEqual(['/custom/bin', '/usr/bin']);
  expect(env.path.split(path.delimiter).filter(dir => dir === '/custom/bin')).toHaveLength(1);
  for (const restricted of ['', '/restricted/bin']) {
    expect(resolveToolEnvironment({ HOME: '/example', PATH: '/custom/bin', JOLO_TOOL_PATH: restricted }).path).toBe(restricted);
  }
});
