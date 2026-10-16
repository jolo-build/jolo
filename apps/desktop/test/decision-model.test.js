import { expect, test } from 'bun:test';
import { ModelRefSchema } from '@jolo/protocol';
import { pairDecisionModel, decisionModeFor } from '../src/renderer/decision-model.js';

test('direct decision providers start in browser mode while preserving explicit per-chat modes', () => {
  const preset = { id: 'typesafe', protocol: 'typesafe' };
  expect(decisionModeFor({ id: 'sifty', protocol: 'typesafe' }, null)).toBe('decision-browser');
  expect(decisionModeFor(preset, { preset: 'openai', model: 'text' })).toBe('decision-browser');
  expect(decisionModeFor(preset, { preset: 'typesafe', mode: 'decisions' })).toBe('decisions');
  expect(decisionModeFor(preset, { preset: 'typesafe', mode: 'decision-browser' })).toBe('decision-browser');
  expect(decisionModeFor({ id: 'openrouter', protocol: 'openai-chat' }, null)).toBe('decisions');
  const selection = { preset: 'typesafe', model: 'jev-latest', mode: decisionModeFor(preset, null) };
  expect(pairDecisionModel(selection, { preset: 'openai', model: 'text' }, null)).toEqual(selection);
});

test('decision selections preserve the chat model, including switching between decision vendors', () => {
  const chat = { preset: 'openai', model: 'text-model', effort: 'high' };
  const first = { preset: 'openrouter', model: 'vendor/decision-a', mode: 'decisions' };
  const paired = pairDecisionModel(first, chat, null);
  expect(paired.chatModel).toEqual(chat);
  expect(ModelRefSchema.parse(paired).chatModel).toMatchObject(chat);
  const second = { ...first, model: 'another/decision-b' };
  expect(pairDecisionModel(second, paired, null).chatModel).toEqual(chat);
  expect(pairDecisionModel(first, first, chat).chatModel).toEqual(chat);
  expect(pairDecisionModel(first, first, first).chatModel).toBeUndefined();
  expect(pairDecisionModel(chat, paired, null)).toEqual(chat);
});
