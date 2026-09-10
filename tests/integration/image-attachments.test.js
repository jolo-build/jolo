import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { startEngine, tempHome, removeHome, ROOT, waitFor, TERMINAL } from './helpers.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const engines = [], homes = [];
afterEach(async () => { for (const engine of engines.splice(0)) await engine.stop(); for (const home of homes.splice(0)) removeHome(home); });

async function boot() {
  const home = tempHome(); homes.push(home);
  const repo = path.join(home, 'repo'), dir = path.join(home, 'data/t/agents');
  mkdirSync(repo); mkdirSync(dir, { recursive: true });
  for (const [id, transport] of [['claude', 'claude-stream'], ['codex', 'codex-app-server'], ['acp', 'acp'], ['no-images', 'acp']]) {
    const binary = path.join(home, `agent-${id}`);
    const fixture = id === 'no-images' ? 'acp' : id;
    writeFileSync(binary, `#!/bin/sh\n${id === 'acp' ? 'export FAKE_ACP_IMAGES=1\n' : ''}exec "${process.execPath}" "${path.join(ROOT, 'tests/fixtures', `fake-${fixture}.js`)}" "$@"\n`);
    chmodSync(binary, 0o755);
    writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, displayName: id, binary, transport, ...(transport === 'acp' ? { args: ['--acp'] } : {}) }));
  }
  const engine = await startEngine({ home, idleMs: 30000 }); engines.push(engine);
  const client = await engine.connect();
  const project = await client.call('project.open', { path: repo });
  const session = async agentId => (await client.call('session.create', { projectId: project.projectId, workspaceId: project.workspaceId, ...(agentId ? { agentId } : {}) })).session;
  return { client, engine, session, home };
}

async function upload(client, sessionId, buffer = PNG) {
  const { artifactId } = await client.call('attachment.create', { sessionId, mimeType: 'image/png' });
  for (let offset = 0; offset < buffer.length; offset += 65535) {
    const chunk = buffer.subarray(offset, offset + 65535);
    await client.call('attachment.write', { sessionId, artifactId, offset, data: chunk.toString('base64'), final: offset + chunk.length === buffer.length });
  }
  return { artifactId, name: 'Screenshot.png', mimeType: 'image/png', bytes: buffer.length };
}

async function finish(client, runId) {
  let snapshot;
  await waitFor(async () => { snapshot = await client.call('run.snapshot', { runId }); return TERMINAL.includes(snapshot.run.state); }, { timeoutMs: 15000, label: 'image run completed' });
  const texts = await Promise.all(snapshot.messages.filter(message => message.role === 'assistant' && message.kind === 'text').map(message => client.call('artifact.read', { artifactId: message.artifactId })));
  return { ...snapshot, text: texts.map(result => result.text).join('') };
}

test('uploads larger than a frame reach queued agents and remain readable after engine restart', async () => {
  const { client, engine, session, home } = await boot();
  const s = await session('acp');
  const first = (await client.call('run.start', { sessionId: s.id, requestId: 'first', prompt: 'sleep' })).run;
  await waitFor(async () => (await client.call('run.snapshot', { runId: first.id })).run.state === 'model');
  const bytes = Buffer.concat([PNG, Buffer.alloc(350000)]);
  const image = await upload(client, s.id, bytes);
  const started = await client.call('run.start', { sessionId: s.id, requestId: 'attached', prompt: 'image-check', attachments: [image] });
  expect(started.run.state).toBe('queued');
  expect((await client.call('session.page', { sessionId: s.id })).runs.find(run => run.id === started.run.id).attachments).toEqual([image]);
  expect((await client.call('run.start', { sessionId: s.id, requestId: 'attached', prompt: 'image-check', attachments: [image] })).deduplicated).toBe(true);
  const tail = await client.call('artifact.read', { artifactId: image.artifactId, offset: PNG.length, length: 100, encoding: 'base64' });
  expect(Buffer.from(tail.text, 'base64')).toEqual(Buffer.alloc(100));
  await client.call('run.sendNow', { runId: started.run.id });
  const result = await finish(client, started.run.id);
  expect(result.run.state).toBe('completed');
  expect(result.text).toContain(`Images received: image/png:${bytes.length}`);
  await engine.stop();
  const restarted = await startEngine({ home, idleMs: 30000 }); engines.push(restarted);
  const reopened = await restarted.connect();
  expect((await reopened.call('session.page', { sessionId: s.id })).runs.find(run => run.id === started.run.id).attachments).toEqual([image]);
  const saved = await reopened.call('artifact.read', { artifactId: image.artifactId, length: PNG.length, encoding: 'base64' });
  expect(Buffer.from(saved.text, 'base64')).toEqual(PNG);
}, 30000);

test('unfinished, cross-task, invalid-type and oversized uploads are rejected; acknowledged chunks are idempotent', async () => {
  const { client, session } = await boot();
  const s = await session(), other = await session();
  const { artifactId } = await client.call('attachment.create', { sessionId: s.id, mimeType: 'image/png' });
  const params = { sessionId: s.id, artifactId, offset: 0, data: PNG.toString('base64'), final: false };
  await client.call('attachment.write', params);
  expect((await client.call('attachment.write', params)).bytes).toBe(PNG.length);
  const image = { artifactId, name: 'test.png', mimeType: 'image/png', bytes: PNG.length };
  await expect(client.call('run.start', { sessionId: s.id, requestId: 'incomplete', prompt: 'inspect', attachments: [image] })).rejects.toMatchObject({ code: 'invalid_params' });
  await client.call('attachment.write', { ...params, final: true });
  await expect(client.call('run.start', { sessionId: other.id, requestId: 'foreign', prompt: 'inspect', attachments: [image] })).rejects.toMatchObject({ code: 'invalid_params' });
  await expect(client.call('attachment.write', { ...params, sessionId: other.id })).rejects.toMatchObject({ code: 'not_found' });
  await expect(client.call('attachment.write', { ...params, data: Buffer.from('not an image').toString('base64') })).rejects.toMatchObject({ code: 'invalid_params' });
  await expect(client.call('attachment.write', { ...params, offset: 5 * 1024 * 1024 })).rejects.toMatchObject({ code: 'limit_exceeded' });
}, 30000);

test('Claude, Codex and image-capable ACP receive actual images; unsupported ACP fails explicitly', async () => {
  const { client, session } = await boot();
  for (const agent of ['claude', 'codex', 'acp', 'no-images']) {
    const s = await session(agent);
    const image = await upload(client, s.id);
    const { run } = await client.call('run.start', { sessionId: s.id, requestId: `image-${agent}`, prompt: 'image-check', attachments: [image] });
    const result = await finish(client, run.id);
    if (agent === 'no-images') {
      expect(result.run.state).toBe('failed');
      expect(result.run.failure).toContain('does not support image attachments');
    } else {
      expect(result.run.state, `${agent}: ${result.run.failure}`).toBe('completed');
      expect(result.text).toContain(`Images received: ${agent === 'codex' ? '' : 'image/png:'}${PNG.length}`);
    }
    expect(result.run.attachments).toEqual([image]);
  }
}, 60000);
