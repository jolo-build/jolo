export const ONBOARDING_KEY = 'jolo.onboarding.v1';

export function readOnboardingState() {
  try {
    const value = localStorage.getItem(ONBOARDING_KEY);
    return ['active', 'dismissed', 'completed'].includes(value) ? value : null;
  } catch { return null; }
}

export function saveOnboardingState(value) {
  try { localStorage.setItem(ONBOARDING_KEY, value); } catch { /* Optional persistence. */ }
}

// Wait for the board before deciding whether this is a new installation. Existing
// projects and standalone chats both count as prior use; an active guide can resume.
export function initialOnboardingState(saved, board) {
  if (saved) return saved;
  if (!board) return null;
  return board.projects.length ? 'dismissed' : 'active';
}

export function onboardingAgentAvailable(id, agents, model, presets) {
  return id === 'jolo'
    ? Boolean(model?.model && presets.some(preset => preset.id === model.preset && preset.available))
    : agents.some(agent => agent.id === id && agent.transport !== 'pty' && agent.available);
}

export function preferredOnboardingAgent(agents, model, presets, saved) {
  const preferred = saved ? saved.agentId ?? 'jolo' : 'jolo';
  if (onboardingAgentAvailable(preferred, agents, model, presets)) return preferred;
  return agents.find(agent => agent.transport !== 'pty' && agent.available)?.id ?? 'jolo';
}

export const FIRST_TASKS = [
  { id: 'explore', title: 'Understand this project', description: 'Find the entry points and learn how the pieces fit together.', prompt: 'Explain how this project is organized. Identify the main entry points, how to run it, and where its tests live. Keep the explanation concise and reference the relevant files. Do not change any files.' },
  { id: 'review', title: 'Find a small improvement', description: 'Get one concrete suggestion you can review before making changes.', prompt: 'Review this project and suggest one small, useful improvement. Explain the problem, identify the relevant files, and describe how you would verify the change. Do not change any files yet.' },
  { id: 'tests', title: 'Plan a useful test', description: 'Find a behavior worth testing and decide what to check.', prompt: 'Look at this project and its existing tests. Identify one important behavior that could use a test, explain why it matters, and outline a focused test for it. Do not change any files yet.' },
];
