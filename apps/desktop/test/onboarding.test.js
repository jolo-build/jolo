import { afterEach, expect, test } from 'bun:test';
import { initialOnboardingState, onboardingAgentAvailable, preferredOnboardingAgent, readOnboardingState, saveOnboardingState } from '../src/renderer/onboarding.js';

const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
afterEach(() => {
  if (original) Object.defineProperty(globalThis, 'localStorage', original);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});
const agents = [{ id: 'claude', transport: 'claude-stream', available: true }, { id: 'codex', transport: 'codex-app-server', available: true }, { id: 'shell', transport: 'pty', available: true }];
const model = { preset: 'example', model: 'example-model' };
const presets = [{ id: 'example', available: true }];

test('onboarding waits for loaded data and only starts automatically for an empty profile', () => {
  expect(initialOnboardingState(null, null)).toBeNull();
  expect(initialOnboardingState(null, { projects: [] })).toBe('active');
  expect(initialOnboardingState(null, { projects: [{ standalone: false }] })).toBe('dismissed');
  expect(initialOnboardingState(null, { projects: [{ standalone: true }] })).toBe('dismissed');
  expect(initialOnboardingState('active', { projects: [{}] })).toBe('active');
  for (const saved of ['dismissed', 'completed']) expect(initialOnboardingState(saved, { projects: [] })).toBe(saved);
});

test('unavailable agents and unconfigured native providers cannot start the first task', () => {
  expect(onboardingAgentAvailable('claude', agents, null, [])).toBe(true);
  expect(onboardingAgentAvailable('shell', agents, null, [])).toBe(false);
  expect(onboardingAgentAvailable('missing', agents, model, presets)).toBe(false);
  expect(onboardingAgentAvailable('claude', [{ ...agents[0], available: false }], model, presets)).toBe(false);
  expect(onboardingAgentAvailable('jolo', agents, null, presets)).toBe(false);
  expect(onboardingAgentAvailable('jolo', agents, model, [])).toBe(false);
  expect(onboardingAgentAvailable('jolo', agents, model, [{ id: 'example', available: false }])).toBe(false);
  expect(onboardingAgentAvailable('jolo', agents, model, presets)).toBe(true);
});

test('the guide prefers the saved agent or native model and offers an installed fallback', () => {
  expect(preferredOnboardingAgent(agents, model, presets, { agentId: 'codex' })).toBe('codex');
  expect(preferredOnboardingAgent(agents, model, presets, { agentId: null })).toBe('jolo');
  expect(preferredOnboardingAgent(agents, model, presets, { agentId: 'missing' })).toBe('claude');
  expect(preferredOnboardingAgent(agents, null, [], null)).toBe('claude');
  expect(preferredOnboardingAgent([], null, [], null)).toBe('jolo');
});

test('onboarding dismissal persists and missing or inaccessible storage does not block startup', () => {
  let value = null;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => value, setItem: (_key, next) => { value = next; } } });
  expect(readOnboardingState()).toBeNull();
  saveOnboardingState('dismissed');
  expect(readOnboardingState()).toBe('dismissed');
  value = 'invalid';
  expect(readOnboardingState()).toBeNull();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('disabled'); } });
  expect(readOnboardingState()).toBeNull();
  expect(() => saveOnboardingState('completed')).not.toThrow();
});
