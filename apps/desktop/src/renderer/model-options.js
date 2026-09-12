const ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export const effortLabel = value => ({ xhigh: 'Extra high' }[value] ?? (value ? value.charAt(0).toUpperCase() + value.slice(1) : 'Default'));

// Never offer another model's effort levels for the selected model.
export function modelEfforts(report, modelId, supported = true) {
  if (!supported || !report) return [];
  const model = modelId ? report.models.find(entry => entry.id === modelId) : report.models.find(entry => entry.isDefault);
  const levels = model?.efforts ?? (report.models.length ? [] : report.efforts ?? []);
  return [...new Set(levels)].sort((a, b) => {
    const first = ORDER.indexOf(a), second = ORDER.indexOf(b);
    return (first < 0 ? ORDER.length : first) - (second < 0 ? ORDER.length : second);
  });
}
export function effortForModel(report, modelId, current) {
  return modelEfforts(report, modelId).includes(current) ? current : null;
}

// Presentation only: keep provider IDs intact when saving or running a model.
export function modelLabel(name) {
  const clean = String(name ?? '')
    .replace(/^.*\//, '')
    .replace(/\s*\([^)]*context[^)]*\)/gi, '')
    .replace(/\[(?:1m|200k)\]/gi, '')
    .replace(/^claude[ -]+/i, '')
    .replace(/[-_]\d{4}-?\d{2}-?\d{2}$/, '')
    .replace(/^(opus|sonnet|haiku)-(\d+)-(\d+)(?=$|-)/i, '$1-$2.$3')
    .trim();
  if (!clean) return '';
  return clean.split(/[-_ ]+/).map(word => {
    if (/^gpt$/i.test(word)) return 'GPT';
    if (/^(ai|cli)$/i.test(word)) return word.toUpperCase();
    if (/^o[134]$/i.test(word)) return word.toLowerCase();
    return word.charAt(0).toUpperCase() + word.slice(1);
  }).join(' ');
}
