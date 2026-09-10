// Chat-compatible APIs expose reasoning as text aliases or ordered structured blocks.
// Keep wire data separate from display text: signatures and encrypted blocks are opaque.
const TEXT_FIELDS = ['reasoning_content', 'reasoning'];

export function chatReasoningFields(value = {}) {
  const fields = {};
  for (const key of TEXT_FIELDS) if (typeof value?.[key] === 'string') fields[key] = value[key];
  if (Array.isArray(value?.reasoning_details)) fields.reasoning_details = value.reasoning_details;
  return fields;
}

export function createChatReasoningCollector() {
  const fields = {};
  let displayedPlainText = false;
  return {
    add(delta) {
      for (const key of TEXT_FIELDS) if (typeof delta[key] === 'string') fields[key] = (fields[key] ?? '') + delta[key];
      // Preserve the complete sequence of streamed detail objects, without rewriting their IDs,
      // indexes, signatures, or provider-specific fields. Repeated indexes can be stream fragments.
      if (Array.isArray(delta.reasoning_details)) (fields.reasoning_details ??= []).push(...delta.reasoning_details);
      const plain = delta.reasoning_content || delta.reasoning;
      if (typeof plain === 'string' && plain) { displayedPlainText = true; return plain; }
      if (displayedPlainText) return '';
      return (Array.isArray(delta.reasoning_details) ? delta.reasoning_details : []).map(detail => {
        if (detail?.type === 'reasoning.text' && typeof detail.text === 'string') return detail.text;
        if (detail?.type === 'reasoning.summary' && typeof detail.summary === 'string') return detail.summary;
        return '';
      }).join('');
    },
    native() { return Object.keys(fields).length ? { type: 'reasoning', chat: fields } : null; },
  };
}

export function applyChatReasoning(body, effort, options) {
  if (!effort) return;
  const config = options.chatReasoning;
  // Older persisted OpenRouter run snapshots predate the explicit wire option.
  const parameter = config?.effortParameter ?? (options.listing === 'openrouter' ? 'reasoning.effort' : 'reasoning_effort');
  if (config?.thinkingToggle) {
    body.thinking = { type: effort === 'none' ? 'disabled' : 'enabled' };
    if (effort === 'none') return;
  }
  if (parameter === 'reasoning.effort') body.reasoning = { effort };
  else body.reasoning_effort = effort;
}
