const KEY = 'jolo.lastModelChoice';

const PRESET = /^[a-z][a-z0-9-]{0,38}$/;
const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const within = (value, min, max) => value === null || (Number.isInteger(value) && value >= min && value <= max);

/**
 * The saved snapshot is Jolo's own writing, read back without the protocol's schema runtime: that runtime
 * is a large share of the renderer bundle, and this would be the only reason to load it before the first
 * conversation can appear. The checks follow ModelRefSchema; the engine validates again before any run.
 *
 * @returns {{ preset: string, model: string, effort: string | null, contextWindowTokens: number | null, maxOutputTokens: number | null } | null | undefined}
 *   the reference, null for a saved null, or undefined when the value is not a model reference
 */
function modelRef(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object') return undefined;
  const { preset, model, effort = null, contextWindowTokens = null, maxOutputTokens = null } = value;
  if (typeof preset !== 'string' || !PRESET.test(preset) || typeof model !== 'string') return undefined;
  const name = model.trim();
  if (!name || name.length > 200) return undefined;
  if (effort !== null && !EFFORTS.has(effort)) return undefined;
  if (!within(contextWindowTokens, 1000, 10_000_000) || !within(maxOutputTokens, 16, 1_000_000)) return undefined;
  if (contextWindowTokens && maxOutputTokens && maxOutputTokens >= contextWindowTokens) return undefined;
  return { preset, model: name, effort, contextWindowTokens, maxOutputTokens };
}

// Shared by panes and retained across app restarts. Hosted models/efforts already
// live in engine settings; native models need their own snapshot for new tasks.
export function readLastModelChoice() {
  try {
    const value = JSON.parse(localStorage.getItem(KEY));
    if (!value || (value.agentId !== null && typeof value.agentId !== 'string')) return null;
    const model = modelRef(value.model);
    return model === undefined ? null : { agentId: value.agentId, model };
  } catch { return null; }
}

export function rememberModelChoice(agentId, model) {
  try { localStorage.setItem(KEY, JSON.stringify({ agentId: agentId === 'jolo' ? null : agentId, model: model ?? null })); }
  catch { /* Persistence is optional when browser storage is unavailable. */ }
}

export function newSessionModelChoice(agents, defaultModel, agentId = undefined) {
  const saved = readLastModelChoice();
  const selected = agentId === undefined ? saved?.agentId : agentId;
  const available = agents.some(agent => agent.id === selected && agent.transport !== 'pty' && agent.available !== false);
  const model = saved?.model ?? defaultModel;
  return { ...(available ? { agentId: selected } : {}), ...(model ? { model } : {}) };
}
