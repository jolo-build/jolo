/** Preserve the text model when adding a decision model to a chat. Older decision-model selections use the configured default. */
export function pairDecisionModel(selection, current, defaultModel) {
  if (selection.mode !== 'decisions') return selection;
  const chatModel = [current?.chatModel, current, defaultModel?.chatModel, defaultModel].find(candidate =>
    candidate && !candidate.mode && !(candidate.preset === selection.preset && candidate.model === selection.model));
  return { ...selection, ...(chatModel ? { chatModel } : {}) };
}
/** Direct decision providers start in browser mode, without a companion. */
export function decisionModeFor(preset, current) {
  if (current?.mode === 'decision-browser') return 'decision-browser';
  if (current?.preset === preset?.id && current?.mode === 'decisions') return 'decisions';
  return preset?.protocol === 'typesafe' ? 'decision-browser' : 'decisions';
}
