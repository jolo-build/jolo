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
