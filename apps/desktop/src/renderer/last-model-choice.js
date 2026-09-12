import { ModelRefSchema } from '@jolo/protocol/schemas';

const KEY = 'jolo.lastModelChoice';

// Shared by panes and retained across app restarts. Hosted models/efforts already
// live in engine settings; native models need their own snapshot for new tasks.
export function readLastModelChoice() {
  try {
    const value = JSON.parse(localStorage.getItem(KEY));
    if (!value || (value.agentId !== null && typeof value.agentId !== 'string')) return null;
    const model = ModelRefSchema.nullable().safeParse(value.model);
    return model.success ? { agentId: value.agentId, model: model.data } : null;
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
