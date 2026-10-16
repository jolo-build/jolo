import { formatDecisionReply, DirectDecisionReply, validateDecisionAnswers } from "../src/decisions/direct.js";
import { expect, test } from 'bun:test';
import { createDecisionService } from '../src/providers/decisions.js';
import { SettingsService } from '../src/settings.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { createHostedMcpConfig } from '../src/hosted-mcp.js';
import { MethodSchemas } from '@jolo/protocol';

const args = { state: 'Hello', questions: { decision: { type: 'choice', instructions: 'Classify this message', criteria: { greeting: 'A greeting', task: 'Work to do' } } } };
const model = { preset: 'openrouter', model: '~typesafe/jev-latest' };
const reply = { model: 'jev-test', answers: { decision: { type: 'choice', choice: 'greeting', confidence: 1, probabilities: { greeting: 1, task: 0 } } }, usage: { input_tokens: 10, output_tokens: 5, cost: 0.001 } };
const config = {};
const service = fetchImpl => createDecisionService({ settings: { get: () => config }, providers: { preset: () => ({ listing: 'openrouter', baseUrl: 'https://router.example/api/v1', auth: { kind: 'bearer' } }) }, credentials: { get: async () => ({ value: 'test-secret' }) }, fetchImpl });

test('decisions use the configured OpenRouter origin, alpha endpoint and typed criteria', async () => {
  const result = await service(async (url, init) => {
    expect(url).toBe('https://router.example/api/alpha/decisions');
    expect(init.headers.authorization).toBe('Bearer test-secret');
    expect(init.redirect).toBe('error');
    expect(JSON.parse(init.body)).toEqual({ ...args, model: model.model });
    return Response.json(reply);
  }).request(args, model);
  expect(result).toMatchObject({ answers: { decision: { choice: 'greeting', confidence: 1 } }, usage: { cost: 0.001 } });
  expect(JSON.stringify(result)).not.toContain('test-secret');
});

test('decision errors are bounded and redacted; invalid choices fail', async () => {
  await expect(service(async () => new Response('test-secret', { status: 401 })).request(args, model)).rejects.toThrow('HTTP 401');
  await expect(service(async () => { throw new Error('test-secret'); }).request(args, model)).rejects.toThrow('[redacted]');
  await expect(service(async () => Response.json({ ...reply, answers: { decision: { ...reply.answers.decision, choice: 'invented' } } })).request(args, model)).rejects.toThrow('unknown or missing choices');
  const controller = new AbortController(); controller.abort();
  await expect(service(async (_url, init) => { init.signal.throwIfAborted(); return Response.json(reply); }).request(args, model, controller.signal)).rejects.toThrow('cancelled');
});

test('legacy helper settings cannot expose a decision tool or RPC', () => {
  const prefs = new Map([['decisionModel', model]]);
  const settings = new SettingsService({ getPreference: key => prefs.get(key), setPreference: (key, value) => prefs.set(key, value), transaction: fn => fn() });
  expect(Object.hasOwn(settings.get(), 'decisionModel')).toBe(false);
  expect(new ToolRegistry().names()).not.toContain('decision_choose');
  expect(new ToolRegistry().names({ decisionAvailable: true })).toContain('decision_choose');
  expect(Object.hasOwn(MethodSchemas, 'decision.call')).toBe(false);
  const issued = [];
  const hosted = createHostedMcpConfig({ paths: { socketPath: '/tmp/sock' }, capabilityTokens: { issue: (...args) => { issued.push(args); return { tokenPath: '/tmp/token' }; } }, browser: null, search: null, log: {} })({ id: 'ws' }, { id: 'run' });
  expect(hosted.server.args.at(-1)).toBe('schedule,delegation');
  expect(issued.at(-1)[2]).not.toContain('decision.call');
});

test('primary decision requests support noul, choice and score without a configured helper model', async () => {
  const request = { state: { message: 'Help! My payouts have been failing for 3 days.' }, questions: {
    urgent: { type: 'noul', instructions: 'Is this urgent?' },
    team: { type: 'choice', instructions: 'Which team?', criteria: { billing: 'Payments', technical: 'Bugs' } },
    frustration: { type: 'score', instructions: 'How frustrated?', criteria: ['Calm', 'Frustrated', 'Very angry'] },
  } };
  const response = /** @type {const} */ ({ model: '~typesafe/jev-latest', answers: {
    urgent: { type: 'noul', noul: 0.99 },
    team: { type: 'choice', choice: 'billing', confidence: 1, probabilities: { billing: 1, technical: 0 } },
    frustration: { type: 'score', score: 1.4, confidence: 0.5, probabilities: { '0': 0, '1': 0.6, '2': 0.4 }, legend: { '0': 'Calm', '1': 'Frustrated', '2': 'Very angry' } },
  }, usage: reply.usage });
  const direct = createDecisionService({ settings: { get: () => ({}) }, providers: { preset: () => ({ listing: 'openrouter', baseUrl: 'https://router.example/api/v1', auth: { kind: 'none' } }) }, credentials: {}, fetchImpl: async (url, init) => {
    expect(url).toBe('https://router.example/api/alpha/decisions');
    expect(JSON.parse(init.body)).toEqual({ ...request, model: '~typesafe/jev-latest' });
    return Response.json(response);
  } });
  expect(await direct.request(request, { preset: 'openrouter', model: '~typesafe/jev-latest' })).toEqual(response);
  expect(formatDecisionReply(DirectDecisionReply.parse(response))).toContain("1: Frustrated");
  expect(formatDecisionReply(DirectDecisionReply.parse(response))).toContain("Yes probability: 99.0%");
  expect(() => validateDecisionAnswers(request, { ...response, answers: {} })).toThrow("unknown or missing questions");
  await expect(direct.request({ ...request, questions: {} }, { preset: 'openrouter', model: 'jev' })).rejects.toThrow();
});
