import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
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

async function upload(client, sessionId, buffer = PNG, mimeType = 'image/png') {
  const { artifactId } = await client.call('attachment.create', { sessionId, mimeType });
  for (let offset = 0; offset < buffer.length; offset += 65535) {
    const chunk = buffer.subarray(offset, offset + 65535);
    await client.call('attachment.write', { sessionId, artifactId, offset, data: chunk.toString('base64'), final: offset + chunk.length === buffer.length });
  }
  return { artifactId, name: mimeType === 'text/plain' ? 'Pasted text.txt' : 'Screenshot.png', mimeType, bytes: buffer.length };
}

test('pasted text is delivered to native and hosted agents including ACP without image support', async () => {
  const { client, session, engine } = await boot();
  let nativeSessionId;
  for (const agent of [null, 'codex', 'claude', 'no-images']) {
    const chat = await session(agent);
    const content = 'Unicode text 🙂漢字\n'.repeat(2300) + '\nATTACHED_TEXT_END';
    const file = await upload(client, chat.id, Buffer.from(content), 'text/plain');
    const { run } = await client.call('run.start', { sessionId: chat.id, requestId: 'text', prompt: 'Read the attached text', attachments: [file] });
    const result = await finish(client, run.id);
    expect(result.run.state).toBe('completed');
    const user = result.messages.find(message => message.role === 'user');
    expect((await client.call('artifact.read', { artifactId: user.artifactId })).text).toBe('Read the attached text');
    expect((await client.call('session.page', { sessionId: chat.id })).runs[0].attachments).toEqual([file]);
    // Fixture agents echo the prompt; inspect the tail rather than a limited preview.
    const reply = result.messages.find(message => message.role === 'assistant' && message.kind === 'text');
    const tail = await client.call('artifact.read', { artifactId: reply.artifactId, offset: Math.max(0, reply.committedBytes - 1000), length: 1000 });
    if (agent) expect(tail.text).toContain('ATTACHED_TEXT_END');
    else nativeSessionId = chat.id;
    const another = await session();
    await expect(client.call('run.start', { sessionId: another.id, requestId: 'foreign', prompt: 'read', attachments: [file] })).rejects.toMatchObject({ code: 'invalid_params' });
  }
  await engine.stop();
  const db = new Database(engine.paths.databasePath, { readonly: true });
  try { expect(JSON.parse(db.query("SELECT payload FROM conversation_items WHERE session_id = ? AND kind = 'user_message'").get(nativeSessionId).payload).text).toContain('Unicode text 🙂漢字\n'.repeat(2300) + '\nATTACHED_TEXT_END'); }
  finally { db.close(); }
}, 20000);

async function finish(client, runId) {
  /** @type {import('./helpers.js').RunSnapshot} */ let snapshot;
  await waitFor(async () => { snapshot = await client.call('run.snapshot', { runId }); return TERMINAL.includes(snapshot.run.state); }, { timeoutMs: 15000, label: 'image run completed' });
  const texts = await Promise.all(snapshot.messages.filter(message => message.role === 'assistant' && message.kind === 'text').map(message => client.call('artifact.read', { artifactId: message.artifactId })));
  return { ...snapshot, text: texts.map(result => result.text).join('') };
}

test('text uploads enforce UTF-8, size and count limits without finalizing invalid content', async () => {
  const { client, session } = await boot();
  const chat = await session();
  const { artifactId } = await client.call('attachment.create', { sessionId: chat.id, mimeType: 'text/plain' });
  await expect(client.call('attachment.write', { sessionId: chat.id, artifactId, offset: 0, data: Buffer.from([0xff]).toString('base64'), final: true })).rejects.toMatchObject({ code: 'invalid_params' });
  await expect(client.call('run.start', { sessionId: chat.id, requestId: 'bad-utf8', prompt: 'read', attachments: [{ artifactId, name: 'Bad.txt', mimeType: 'text/plain', bytes: 1 }] })).rejects.toMatchObject({ code: 'invalid_params' });
  await expect(upload(client, chat.id, Buffer.alloc(256 * 1024 + 1, 97), 'text/plain')).rejects.toMatchObject({ code: 'limit_exceeded' });
  const file = await upload(client, chat.id, Buffer.from('Valid UTF-8 🙂'), 'text/plain');
  await expect(client.call('run.start', { sessionId: chat.id, requestId: 'too-many', prompt: 'read', attachments: Array(5).fill(file) })).rejects.toMatchObject({ code: 'limit_exceeded' });
});

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


test('binary files reach Codex as readable persisted paths and remain scoped to their task', async () => {
  const { client, session } = await boot();
  const chat = await session('codex');
  const bytes = Buffer.from('%PDF-1.7\nBinary file\0\xff', 'latin1');
  const file = { ...await upload(client, chat.id, bytes, 'application/octet-stream'), name: 'Report.pdf' };
  const { run } = await client.call('run.start', { sessionId: chat.id, requestId: 'file', prompt: 'file-check', attachments: [file] });
  const result = await finish(client, run.id);
  expect(result.run.state).toBe('completed');
  expect(result.text).toBe(`File received: ${bytes.toString('hex')}`);
  expect((await client.call('session.page', { sessionId: chat.id })).runs[0].attachments).toEqual([file]);
  const other = await session('codex');
  await expect(client.call('run.start', { sessionId: other.id, requestId: 'foreign-file', prompt: 'file-check', attachments: [file] })).rejects.toMatchObject({ code: 'invalid_params' });
  await expect(client.call('run.start', { sessionId: chat.id, requestId: 'too-many-files', prompt: 'file-check', attachments: Array(5).fill(file) })).rejects.toMatchObject({ code: 'limit_exceeded' });
}, 20000);
