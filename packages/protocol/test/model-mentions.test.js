import { expect, test } from 'bun:test';
import { modelMentions, typingModelMention, completeModelMention, modelMentionSelector, modelMentionChoices, loadModelMentionCatalog } from '../src/model-mentions.js';

test('model mentions preserve exact provider, nested model id and effort', () => {
  const selector = modelMentionSelector('provider:openrouter', 'vendor/model~v2', 'high');
  expect(selector).toBe('provider:openrouter/vendor%2Fmodel%7Ev2~high');
  expect(modelMentions(`Ask ^${selector} to review`)).toEqual([{ selector, start: 4, end: 5 + selector.length }]);
});
test('code examples, escaped carets and ordinary exponent notation do not select models', () => {
  const reference = '^agent:codex/model';
  expect(modelMentions(`\`${reference}\`\n\`\`\`\n${reference}\n\`\`\`\n\\${reference} x^2`)).toEqual([]);
  expect(typingModelMention('x^2', 3)).toBeNull();
  expect(typingModelMention('Use ^cod', 8)).toEqual({ query: 'cod', start: 4 });
});
test('completing a model in the middle of a draft retains both sides and caret', () => {
  expect(completeModelMention('Ask ^cod to review', 8, 'agent:codex/m')).toEqual({ value: 'Ask ^agent:codex/m  to review', cursor: 19 });
  const choices = modelMentionChoices([{ source: 'agent:codex', sourceName: 'Codex', model: 'm', name: 'Model', efforts: ['high'] }], 'codex');
  expect(choices.map(c => c.selector)).toEqual(['agent:codex/m', 'agent:codex/m~high']);
});

test('available agents appear while an unrelated provider is still loading', async () => {
  let release = () => {};
  const waiting = new Promise(resolve => { release = () => resolve(null); });
  const reports = [];
  const loading = loadModelMentionCatalog(async (method) => {
    if (method === 'agent.catalog') return { agents: [{ id: 'codex', available: true, supportsModel: true, transport: 'codex-app-server' }] };
    if (method === 'provider.presets') { await waiting; throw new Error('Provider unavailable'); }
    return { models: [{ source: 'agent:codex', model: 'm' }], notes: [] };
  }, report => reports.push(report));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(reports.at(-1)).toMatchObject({ loading: true, models: [{ model: 'm' }] });
  release(); await loading;
  expect(reports.at(-1)).toMatchObject({ loading: false, models: [{ model: 'm' }], notes: ['Provider unavailable'] });
});
