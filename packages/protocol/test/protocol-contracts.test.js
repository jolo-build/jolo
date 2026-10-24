import { expect, test } from 'bun:test';
import { parseParams, parseEvent, MethodSchemas } from '../src/schemas.js';
test('request validation rejects unknown nested fields instead of stripping their meaning', () => {
  const base = { sessionId: 's', requestId: 'r', prompt: 'continue', execution: { agentId: 'codex', model: 'm'.repeat(200) } };
  expect(parseParams('run.start', base).ok).toBe(true);
  expect(parseParams('run.start', { ...base, execution: { ...base.execution, sandboxMode: 'strict' } }).ok).toBe(false);
  expect(Object.isFrozen(MethodSchemas)).toBe(true);
});
test('event types, payloads and timestamps form an enforced contract', () => {
  const event = { engineBootId: 'boot', eventSeq: '1', sessionId: null, runId: null, type: 'grant.created', payload: { grantId: 'g', scope: 'inspect' }, at: new Date().toISOString() };
  expect(parseEvent(event).ok).toBe(true);
  expect(parseEvent({ ...event, at: 'aaaaaaaaaaaaaaaaaaaaaa' }).ok).toBe(false);
  expect(parseEvent({ ...event, type: 'grant.cretaed' }).ok).toBe(false);
  expect(parseEvent({ ...event, payload: {} }).ok).toBe(false);
});

test('budget patches preserve omitted fields and accept an explicit disabled hosted deadline', () => {
  for (const budgets of [{}, { maxActiveMs: 60_000 }, { hostedToolDeadlineMs: 600_000 }, { hostedToolDeadlineMs: null }]) {
    expect(parseParams('settings.update', { budgets })).toMatchObject({ ok: true, value: { budgets } });
    expect(MethodSchemas['settings.update'].params.parse({ budgets })).toEqual({ budgets });
  }
  expect(parseParams('settings.update', { budgets: { hostedToolDeadlineMs: 0 } }).ok).toBe(false);
  expect(parseParams('settings.update', { budgets: { toolDeadlineMs: null } }).ok).toBe(false);
});

test('a task\'s output and the MCP servers\' status have their own methods, and an ended process its own error code', async () => {
  const { ERROR_CODES, McpServerSchema, toRpcError, ProtocolError } = await import('../src/schemas.js');
  expect(parseParams('session.taskOutput', { sessionId: 's', taskId: 'task-1' }).ok).toBe(true);
  expect(parseParams('session.taskOutput', { sessionId: 's' }).ok).toBe(false);
  expect(MethodSchemas['session.taskOutput'].result.parse({ output: 'line 1\n', totalBytes: 7, truncated: false })).toEqual({ output: 'line 1\n', totalBytes: 7, truncated: false });
  expect(MethodSchemas['session.taskOutput'].result.safeParse({ output: 'x'.repeat(200 * 1024 + 1), totalBytes: 1, truncated: true }).success).toBe(false); // the engine keeps the last 200 KiB
  expect(parseParams('session.mcpStatus', { sessionId: 's' }).ok).toBe(true);
  const servers = [{ name: 'probe', status: 'connected', source: 'user', error: null }, { name: 'pencil', status: 'failed', source: 'user', error: 'ENOENT' }];
  expect(MethodSchemas['session.mcpStatus'].result.parse({ servers })).toEqual({ servers });
  expect(MethodSchemas['session.mcpStatus'].result.parse({ servers: null })).toEqual({ servers: null });
  expect(McpServerSchema.safeParse({ name: 'n'.repeat(201), status: 'connected', source: null, error: null }).success).toBe(false);
  expect(ERROR_CODES).toContain('no_process');
  expect(toRpcError(new ProtocolError('no_process', 'the process that ran it has ended')).data.code).toBe('no_process');
});
