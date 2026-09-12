/** Keep conversation identity when the composer chooses a different answerer.
 * Read the current revision before switching; a conflict leaves the draft intact. */
export async function sessionForSend({ call, sessionId, agentId, prompt, newSession }) {
  if (!sessionId) return newSession(prompt.slice(0, 80), { agentId });
  if (agentId === undefined) return { id: sessionId };
  const { session } = await call('session.page', { sessionId });
  if ((session.agentId ?? null) === agentId) return session;
  const { session: updated } = await call('session.setAgent', { sessionId, agentId, expectedRevision: session.revision });
  return updated;
}

// A queued turn can choose a guest without changing the active session's agent.
// Explicit @mentions still belong to the engine's normal prompt router.
export function queuedExecution(agentId, sessionAgentId, prompt) {
  if (agentId === undefined || agentId === (sessionAgentId ?? null) || /^\s*@/.test(prompt)) return undefined;
  return { agentId: agentId ?? 'jolo' };
}
