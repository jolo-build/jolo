// The hosted-agent path end to end: a real engine socket, a real capability token bound to a run,
// and the schedule-mcp bridge spawned exactly as a hosted transport would spawn it.
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Storage } from '../src/storage/index.js';
import { createRpcServer } from '../src/rpc/server.js';
import { createRpcHandlers } from '../src/rpc/handlers.js';
import { CapabilityTokens } from '../src/rpc/capabilities.js';
import { createScheduler } from '../src/scheduler/index.js';
import { RunService } from '../src/runs/service.js';
import { SCHEDULE_METHODS } from '../src/scheduler/mcp.js';
import { hostedMcpConfig, codexMcpArgs, acpMcpServers } from '../src/hosted-mcp.js';
import { ENGINE_ENTRY } from '../../../tests/integration/helpers.js';

test('a hosted agent sets a heartbeat on its own task through the jolo_schedule tools', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'jolo-schedule-mcp-'));
  const storage = new Storage({ databasePath: path.join(root, 'db'), artifactsDir: path.join(root, 'artifacts'), bootId: 'boot' });
  const capabilities = new CapabilityTokens(path.join(root, 'caps'));
  const runs = new RunService({ storage, log: { error() {}, warn() {} }, lifetime: { workStarted() {}, workFinished() {} }, executor: { execute: async () => ({ outcome: 'completed' }) } });
  const scheduler = createScheduler({ storage, runs, lifetime: { workStarted() {}, workFinished() {} }, log: { info() {}, warn() {}, error() {} } });
  const handlers = createRpcHandlers(/** @type {any} */ ({ storage, runs, schedules: scheduler, dispatcher: { registry: { get: () => null } }, settingsService: { get: () => ({ budgets: {} }) } }));
  const server = createRpcServer({ token: 'owner-token-1234567890', capabilityTokens: capabilities, bootId: 'boot', build: 'test', storage, previews: new EventEmitter(), lifetime: { clientConnected() {}, clientDisconnected() {} }, log: { error() {}, warn() {} }, handlers });
  const socketPath = path.join(root, 's');
  await server.listen(socketPath);

  const project = storage.upsertProject({ identity: root, rootPath: root });
  const workspace = storage.ensureDirectWorkspace(project.id, root);
  const session = storage.createSession({ projectId: project.id, workspaceId: workspace.id, title: 'orchestrator' });
  const other = storage.createSession({ projectId: project.id, workspaceId: workspace.id, title: 'other' });
  const run = storage.insertRun({ sessionId: session.id, requestId: 'r1', prompt: 'work' });
  const { tokenPath } = capabilities.issue(run.id, workspace.id, SCHEDULE_METHODS);

  const child = Bun.spawn([process.execPath, ENGINE_ENTRY, 'jolo-mcp', '--socket', socketPath, '--token-file', tokenPath, '--workspace', workspace.id, '--tools', 'schedule'], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  const responses = [];
  const pendingLines = { text: '' };
  const reader = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) {
      pendingLines.text += decoder.decode(chunk, { stream: true });
      let end;
      while ((end = pendingLines.text.indexOf('\n')) >= 0) {
        const line = pendingLines.text.slice(0, end); pendingLines.text = pendingLines.text.slice(end + 1);
        if (line.trim()) responses.push(JSON.parse(line));
      }
    }
  })();
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const answer = async (id) => {
    for (let i = 0; i < 200; i++) {
      const found = responses.find((r) => r.id === id);
      if (found) return found;
      await Bun.sleep(25);
    }
    throw new Error(`no response to ${id}; stderr: ${await new Response(child.stderr).text()}`);
  };

  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    expect((await answer(1)).result.serverInfo.name).toBe('jolo');
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const toolNames = (await answer(2)).result.tools.map((tool) => tool.name);
    expect(toolNames).toEqual(['schedule_create', 'schedule_list', 'schedule_pause', 'schedule_resume', 'schedule_cancel']);

    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'schedule_create', arguments: { every: '15m', prompt: 'check the board and course-correct' } } });
    const created = (await answer(3)).result.structuredContent.schedule;
    // The credential named the session; the tool never saw a session id.
    expect(created.sessionId).toBe(session.id);
    expect(created.everyMs).toBe(900_000);
    expect(created.state).toBe('active');

    send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'schedule_list', arguments: {} } });
    const listed = (await answer(4)).result.structuredContent.schedules;
    expect(listed.map((s) => s.id)).toEqual([created.id]);

    send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'schedule_create', arguments: { every: 'bogus', prompt: 'x' } } });
    expect((await answer(5)).result.isError).toBe(true);

    send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'schedule_cancel', arguments: { scheduleId: created.id } } });
    expect((await answer(6)).result.structuredContent.schedule.state).toBe('cancelled');
  } finally {
    child.kill();
    await reader.catch(() => {});
    scheduler.stop();
    await runs.stopAll();
    await server.close();
    storage.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

test('every hosted transport gets the jolo schedule tools through the one bridge', () => {
  const config = hostedMcpConfig({ socketPath: '/tmp/e.sock', tokenPath: '/tmp/t' }, 'ws_1', ['schedule']);
  expect(config.args[0]).toBe(ENGINE_ENTRY);
  expect(config.args).toContain('jolo-mcp');
  expect(config.args.at(-1)).toBe('schedule');
  expect(config.args.at(-3)).toBe('ws_1');
  const codex = codexMcpArgs(config);
  const parsed = /** @type {{ mcp_servers: Record<string, any> }} */ (Bun.TOML.parse([codex[1], codex[3]].join('\n')));
  expect(parsed.mcp_servers.jolo).toEqual(config);
  expect(acpMcpServers(config)).toEqual([{ name: 'jolo', ...config, env: [] }]);
});
