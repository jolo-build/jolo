import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, writeFileSync, symlinkSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { TgrepService } from '../../apps/engine/src/search/tgrep.js';
import { fileTools } from '../../apps/engine/src/tools/files.js';
import { resolveToolEnvironment } from '../../apps/engine/src/tools/dispatcher.js';
import { SearchTextParams } from '@jolo/protocol';
import { searchMcpConfig } from '../../apps/engine/src/search/hosted.js';
import { tempHome, removeHome, waitFor, startEngine } from './helpers.js';

const cleanup = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const env = resolveToolEnvironment(process.env);
const nativeTest = test.skipIf(!env.tgrep);
const searchTool = fileTools.find(tool => tool.name === 'search_text');
function fixture() {
  const home = tempHome(); cleanup.push(() => removeHome(home));
  const root = path.join(home, 'repo'); mkdirSync(path.join(root, 'src'), { recursive: true });
  Bun.spawnSync(['git', 'init', '-q', root]);
  writeFileSync(path.join(root, '.gitignore'), 'ignored.txt\n');
  writeFileSync(path.join(root, 'src/a.js'), 'const needle = 42;\n// NEEDLE again\nconst literal = "[needle]";\n');
  writeFileSync(path.join(root, 'src/b.js'), '// needle two\n');
  writeFileSync(path.join(root, 'ignored.txt'), 'needle hidden by gitignore\n');
  writeFileSync(path.join(root, '.hidden'), 'needle hidden\n');
  writeFileSync(path.join(root, 'binary'), Buffer.from('needle\0binary'));
  writeFileSync(path.join(root, 'oversize'), 'needle\n' + 'x'.repeat(1024 * 1024));
  writeFileSync(path.join(home, 'outside'), 'needle secret\n');
  symlinkSync(path.join(home, 'outside'), path.join(root, 'escape'));
  const service = new TgrepService({ directory: path.join(home, 'indexes'), env });
  cleanup.push(() => service.close());
  const search = (args, signal = AbortSignal.timeout(10_000), backend = service) => searchTool.execute({ workspace: { root }, env, search: backend, signal }, SearchTextParams.parse(args));
  return { home, root, service, search };
}
async function ready(service, root) {
  return waitFor(async () => { const lease = await service.acquire(root); if (!lease) return false; lease.release(); return lease; }, { timeoutMs: 20_000, label: 'tgrep index ready' });
}

nativeTest('real index: warm-up fallback, scopes, ignore rules, regex, paging and live edits', async () => {
  const { root, service, search } = fixture();
  // Force an unavailable lease: a real index may finish warming before the first query.
  expect((await search({ pattern: 'needle' }, AbortSignal.timeout(10_000), { acquire: async () => null })).freshness).toBe('live');
  await ready(service, root);
  const indexed = await search({ pattern: 'needle' });
  expect(indexed.engine).toBe('tgrep');
  expect(indexed.matches.map(match => match.path)).toEqual(['src/a.js', 'src/a.js', 'src/a.js', 'src/b.js']);
  expect((await search({ pattern: '[needle]' })).matches).toHaveLength(1);
  expect((await search({ pattern: '^// NEEDLE', regex: true, caseSensitive: true })).matches).toHaveLength(1);
  expect((await search({ pattern: 'needle', paths: ['src/b.js'] })).matches).toHaveLength(1);
  const first = await search({ pattern: 'needle', maxMatches: 2 });
  expect(first.truncated).toBe(true);
  const next = await search({ pattern: 'needle', maxMatches: 2, cursor: first.nextCursor });
  expect([...first.matches, ...next.matches]).toEqual(indexed.matches);
  expect(next.truncated).toBe(false);
  await expect(search({ pattern: '[', regex: true })).rejects.toBeTruthy();
  await expect(search({ pattern: 'needle', paths: ['escape'] })).rejects.toMatchObject({ code: 'permission_denied' });
  await expect(search({ pattern: 'needle', paths: ['../outside'] })).rejects.toMatchObject({ code: 'permission_denied' });
  writeFileSync(path.join(root, 'new.txt'), 'newest-marker\n');
  expect((await search({ pattern: 'newest-marker' })).matches[0].path).toBe('new.txt');
  writeFileSync(path.join(root, 'src/a.js'), 'changed-on-disk\n'); unlinkSync(path.join(root, 'src/b.js'));
  expect((await search({ pattern: 'needle', fresh: true })).matches).toHaveLength(0);
  expect((await search({ pattern: 'changed-on-disk', fresh: true })).freshness).toBe('live');
  service.invalidate(root);
  expect((await search({ pattern: 'changed-on-disk' })).freshness).toBe('live');
}, 30_000);

nativeTest('server death, cancellation, cached restart and shutdown', async () => {
  const { root, service, search } = fixture();
  const lease = await ready(service, root);
  const controller = new AbortController(); controller.abort();
  await expect(search({ pattern: 'needle' }, controller.signal)).rejects.toMatchObject({ code: 'interrupted' });
  const entry = service.entries.get(root);
  await service.stop(entry);
  expect(entry.done).toBe(true);
  writeFileSync(path.join(root, 'src/a.js'), 'offline-marker\n');
  await ready(service, root);
  expect((await search({ pattern: 'offline-marker' })).matches[0].path).toBe('src/a.js');
  const restarted = service.entries.get(root);
  restarted.child.kill('SIGKILL'); await restarted.child.exited;
  expect((await search({ pattern: 'offline-marker' })).freshness).toBe('live');
  expect(lease.alive()).toBe(false);
  await service.close();
  expect(service.entries.size).toBe(0);
}, 30_000);

test('missing tgrep and missing ripgrep retain bounded live search without following symlinks', async () => {
  const { root } = fixture();
  const result = await searchTool.execute({ workspace: { root }, env: { ...env, tgrep: null, ripgrep: null }, signal: AbortSignal.timeout(1000) }, SearchTextParams.parse({ pattern: 'needle', maxMatches: 2 }));
  expect(result.engine).toBe('builtin'); expect(result.truncated).toBe(true); expect(result.matches).toHaveLength(2);
  expect(result.matches.some(match => match.path === 'escape')).toBe(false);
  expect(resolveToolEnvironment({ ...process.env, JOLO_TGREP: '' }).tgrep).toBeNull();
});

nativeTest('cancelling an indexed request terminates both the query and its owned server', async () => {
  const { home, root, service } = fixture();
  await ready(service, root);
  const entry = service.entries.get(root);
  const slowQuery = path.join(home, 'slow-query');
  writeFileSync(slowQuery, '#!/bin/sh\nexec sleep 10\n'); chmodSync(slowQuery, 0o755);
  const controller = new AbortController();
  const pending = searchTool.execute({ workspace: { root }, env: { ...env, tgrep: slowQuery }, search: service, signal: controller.signal }, SearchTextParams.parse({ pattern: 'needle' }));
  await waitFor(() => entry.users === 1);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: 'interrupted' });
  await waitFor(() => entry.done);
  expect(entry.users).toBe(0);
  expect(service.entries.has(root)).toBe(false);
}, 5000);

nativeTest('idle cleanup keeps a leased server alive and stops it after release', async () => {
  const { home, root } = fixture();
  const service = new TgrepService({ directory: path.join(home, 'idle-index'), env, idleMs: 100 });
  cleanup.push(() => service.close());
  await ready(service, root);
  const lease = await service.acquire(root);
  expect(lease).not.toBeNull();
  const entry = service.entries.get(root);
  await new Promise(resolve => setTimeout(resolve, 220));
  expect(entry.done).toBe(false);
  lease.release();
  await waitFor(() => entry.done, { timeoutMs: 2000 });
  expect(service.entries.size).toBe(0);
}, 5000);

test('hosted stdio MCP searches only its pinned workspace through the engine', async () => {
  const { home, root } = fixture();
  const engine = await startEngine({ home, idleMs: 30_000, env: { JOLO_TGREP: '' } }); cleanup.push(() => engine.stop());
  const client = await engine.connect(); cleanup.push(() => client.close());
  const project = await client.call('project.open', { path: root });
  const config = searchMcpConfig(engine.paths, project.workspaceId, true);
  const proc = Bun.spawn([config.command, ...config.args], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  cleanup.push(async () => { if (proc.exitCode === null) proc.kill(); await proc.exited; });
  const stdout = new Response(proc.stdout).text(), stderr = new Response(proc.stderr).text();
  const send = value => proc.stdin.write(JSON.stringify(value) + '\n');
  send(null);
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_text', arguments: { pattern: 'needle', workspaceId: 'cannot-replace-workspace' } } });
  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'search_text', arguments: { pattern: 'needle', paths: ['../outside'] } } });
  proc.stdin.end();
  expect(await proc.exited).toBe(0); expect(await stderr).toBe('');
  const responses = (await stdout).trim().split('\n').map(JSON.parse);
  expect(responses.find(message => message.id === null).error.code).toBe(-32600);
  expect(responses.find(message => message.id === 1).result.serverInfo.name).toBe('jolo-search');
  expect(responses.find(message => message.id === 2).result.tools[0].name).toBe('search_text');
  const output = responses.find(message => message.id === 3).result;
  expect(output.isError).toBe(false); expect(output.structuredContent.matches).toHaveLength(4);
  expect(responses.find(message => message.id === 4).result.isError).toBe(true);
}, 20_000);
