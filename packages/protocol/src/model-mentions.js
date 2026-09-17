// Canonical model references are explicit about the agent or API provider that will run them.
const part = value => encodeURIComponent(value).replaceAll('~', '%7E');
export const modelMentionSelector = (source, model, effort = null) => `${source}/${part(model)}${effort ? `~${part(effort)}` : ''}`;

/** Ignore examples in fenced/inline code and escaped carets. Offsets still address the original text. */
function prose(text) {
  return text.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`|\\\^/g, match => ' '.repeat(match.length));
}
export function modelMentions(text) {
  return [...prose(text).matchAll(/(?:^|\s)\^((?:agent|provider):[a-z0-9._-]+\/[^\s`<>()[\]{},;!?]+)/gi)]
    .map(match => ({ selector: match[1], start: match.index + match[0].indexOf('^'), end: match.index + match[0].length }));
}
export function typingModelMention(text, caret) {
  const match = /(?:^|\s)\^([^\s^]*)$/.exec(prose(text.slice(0, caret)));
  return match ? { query: match[1], start: caret - match[1].length - 1 } : null;
}
export function completeModelMention(text, caret, selector) {
  const mention = typingModelMention(text, caret);
  if (!mention) return { value: text, cursor: caret };
  const token = `^${selector} `;
  return { value: text.slice(0, mention.start) + token + text.slice(caret), cursor: mention.start + token.length };
}
export function modelMentionChoices(models, query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return models.flatMap(model => [null, ...model.efforts].map(effort => ({
    ...model, effort, selector: modelMentionSelector(model.source, model.model, effort),
    label: `${model.name} · ${model.sourceName}${effort ? ` · ${effort}` : ' · default effort'}`,
  }))).filter(choice => words.every(word => `${choice.selector} ${choice.label}`.toLowerCase().includes(word))).slice(0, 80);
}

/** Publish each source as it arrives, so one slow provider cannot hide an available agent. */
export async function loadModelMentionCatalog(call, onReport) {
  const models = [], notes = [];
  const publish = loading => onReport({ models: [...models], notes: [...notes], loading });
  const source = async id => {
    try { const report = await call('delegation.models', { source: id }); models.push(...report.models); notes.push(...report.notes); }
    catch (error) { notes.push(error.message); }
    publish(true);
  };
  publish(true);
  await Promise.all([
    call('agent.catalog', {}).then(({ agents }) => Promise.all(agents.filter(agent => agent.available && agent.supportsModel && agent.transport !== 'pty').map(agent => source(`agent:${agent.id}`)))).catch(error => { notes.push(error.message); }),
    call('provider.presets', {}).then(({ presets }) => Promise.all(presets.filter(preset => preset.available).map(preset => source(`provider:${preset.id}`)))).catch(error => { notes.push(error.message); }),
  ]);
  publish(false);
}
