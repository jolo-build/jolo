// Calling another agent into a conversation by name.
//
// Writing "@codex review the last change" in a task answered by Claude sends THAT ONE TURN to Codex, in the
// same conversation, and leaves the task answered by Claude afterwards. It is how a second opinion, a review,
// or a handover is asked for without leaving the thread or starting a task somewhere else.
//
// A mention only counts at the START of a message. Anywhere else it is ordinary text: routing a turn to a
// different agent is too consequential to trigger on a name mentioned in passing.

/** Jolo's own loop, mentionable like any other answerer so a hosted task can ask Jolo for one turn. */
export const SELF_MENTION = "jolo";

const MENTION = /^\s*@([a-z0-9][a-z0-9._-]{0,63})\b[ \t]*/i;

/** The name a message opens with, or null. Says nothing about whether such an agent exists. */
export function mentionOf(prompt) {
  const match = MENTION.exec(String(prompt ?? ""));
  return match ? match[1].toLowerCase() : null;
}

/** The message without its opening mention: what the agent is actually asked. */
export function withoutMention(prompt) {
  const text = String(prompt ?? "");
  const rest = text.replace(MENTION, "");
  return rest.trim() ? rest : text;
}

/**
 * Who a message asks for, as a run's execution choice.
 * @param {{ prompt: string, catalog: any, sessionAgentId: string | null }} options
 * @returns {{ agentId: string } | null} null when the message names nobody Jolo can route to
 */
export function routeFor({ prompt, catalog, sessionAgentId }) {
  const name = mentionOf(prompt);
  if (!name) return null;
  if (name === SELF_MENTION) return sessionAgentId ? { agentId: SELF_MENTION } : null; // already Jolo's task
  let manifest;
  try { manifest = catalog.get(name); } catch { return null; } // an unknown name is just text
  if (manifest.transport === "pty") return null; // a terminal agent is watched, not conversed with (§4.3)
  return manifest.id === sessionAgentId ? null : { agentId: manifest.id };
}
