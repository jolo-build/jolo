import { afterEach, expect, test } from 'bun:test';
import { newSessionModelChoice, readLastModelChoice, rememberModelChoice } from '../src/renderer/last-model-choice.js';

const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
afterEach(() => {
  if (original) Object.defineProperty(globalThis, 'localStorage', original);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});
function storage(value = null) {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: () => value, setItem: (_key, next) => { value = next; },
  } });
}
const model = { preset: 'openai', model: 'chosen-model', effort: /** @type {const} */ ('high'), contextWindowTokens: null, maxOutputTokens: null };
const agents = [{ id: 'codex', transport: 'codex-app-server', available: true }];

test('new tasks restore the saved agent and native model snapshot across reads', () => {
  storage();
  rememberModelChoice('codex', model);
  expect(newSessionModelChoice(agents, null)).toEqual({ agentId: 'codex', model });
  expect(readLastModelChoice()).toEqual({ agentId: 'codex', model });
  expect(newSessionModelChoice(agents, null, null)).toEqual({ model });
  rememberModelChoice('jolo', model);
  expect(newSessionModelChoice(agents, null)).toEqual({ model });
});

test('unavailable or removed agents fall back to the native model', () => {
  storage();
  rememberModelChoice('codex', model);
  expect(newSessionModelChoice([], null)).toEqual({ model });
  expect(newSessionModelChoice([{ ...agents[0], available: false }], null)).toEqual({ model });
  expect(newSessionModelChoice([{ ...agents[0], transport: 'pty' }], null)).toEqual({ model });
});

test('missing, malformed or inaccessible storage keeps normal creation working', () => {
  for (const value of [null, '{', '{}', JSON.stringify({ agentId: 42, model }), JSON.stringify({ agentId: null, model: {} })]) {
    storage(value);
    expect(newSessionModelChoice(agents, model)).toEqual({ model });
  }
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('disabled'); } });
  expect(() => rememberModelChoice(null, model)).not.toThrow();
  expect(newSessionModelChoice(agents, null)).toEqual({});
});
