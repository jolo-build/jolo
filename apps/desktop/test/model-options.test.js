import { expect, test } from 'bun:test';
import { modelEfforts, effortForModel, modelLabel } from '../src/renderer/model-options.js';

test('effort stops follow the selected model and never borrow another model’s capabilities', () => {
  const report = { models: [
    { id: 'large', isDefault: true, efforts: ['ultra', 'low', 'high', 'low'] },
    { id: 'small', efforts: ['low'] },
    { id: 'plain', efforts: [] },
  ], efforts: ['low', 'high', 'ultra'] };
  expect(modelEfforts(report, null)).toEqual(['low','high','ultra']);
  expect(modelEfforts(report, 'small')).toEqual(['low']);
  expect(modelEfforts(report, 'plain')).toEqual([]);
  expect(modelEfforts(report, 'custom')).toEqual([]);
  expect(modelEfforts(report, 'large', false)).toEqual([]);
  expect(effortForModel(report, 'small', 'high')).toBeNull();
  expect(effortForModel(report, 'large', 'high')).toBe('high');
  expect(modelEfforts({models:[],efforts:['high','low']},null)).toEqual(['low','high']);
});

test('model labels are readable without provider IDs or context suffixes', () => {
  for (const [id, label] of [
    ['gpt-6-astra', 'GPT 6 Astra'], ['gpt-5.6-sol', 'GPT 5.6 Sol'],
    ['opus[1m]', 'Opus'], ['Opus (1M context)', 'Opus'],
    ['claude-sonnet-4-6', 'Sonnet 4.6'], ['claude-opus-4-20250514', 'Opus 4'],
    ['gemini-2.5-pro', 'Gemini 2.5 Pro'], ['grok-4.6', 'Grok 4.6'],
    ['openai/gpt-6-astra', 'GPT 6 Astra'], ['o3', 'o3'], ['test-model', 'Test Model'],
  ]) expect(modelLabel(id)).toBe(label);
  expect(modelLabel(null)).toBe('');
});
