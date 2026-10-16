import { expect, test } from 'bun:test';
import { acceptsPromptImages } from '../src/agents/acp.js';

test('an ACP agent accepts images when it says so, and Grok does even though its flag stays false', () => {
  expect(acceptsPromptImages({ agentCapabilities: { promptCapabilities: { image: true } } })).toBe(true);
  expect(acceptsPromptImages({ agentCapabilities: { promptCapabilities: { image: false } }, _meta: { grokShell: true } })).toBe(true);
  expect(acceptsPromptImages({ agentCapabilities: { promptCapabilities: { image: false } } }, { id: 'grok' })).toBe(true);
  expect(acceptsPromptImages({ agentCapabilities: { promptCapabilities: { image: false } } })).toBe(false);
  expect(acceptsPromptImages({ _meta: { grokShell: false } })).toBe(false);
  expect(acceptsPromptImages(null)).toBe(false);
});
