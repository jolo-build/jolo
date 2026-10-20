// Slash commands in the message bar: the picker that opens while "/" is being typed as the whole message.
//
// The commands are the chosen agent's own, read from the same agent.models answer the model menu uses, so the list is
// what that install accepts today and nothing is listed for an agent that publishes none. A command is the whole message
// or it is not one, so the picker opens only while the message is a "/" and a name being typed, and closes as soon as a
// space follows the name or anything else is in the message.

/** The command name being typed, when the message so far is nothing but "/" and it; otherwise null. */
export function typingSlashCommand(text, caret) {
  if (text.slice(caret).trim()) return null; // something after the caret: the slash is not the whole message
  const match = /^\/([a-z0-9][a-z0-9_:.-]*)?$/i.exec(text.slice(0, caret));
  return match ? { query: match[1] ?? "" } : null;
}

/**
 * The commands matching what has been typed: names that start with it first, then names that contain it, each in the
 * order the agent listed them. With nothing typed yet, the agent's list as it came.
 */
export function slashCommandChoices(commands, query, limit = 12) {
  const typed = String(query ?? "").trim().toLowerCase();
  const listed = (Array.isArray(commands) ? commands : []).filter(command => typeof command?.name === "string" && command.name);
  const starts = listed.filter(command => command.name.toLowerCase().startsWith(typed));
  const within = typed ? listed.filter(command => !starts.includes(command) && command.name.toLowerCase().includes(typed)) : [];
  return [...starts, ...within].slice(0, limit);
}

/** The message after choosing a command: the command alone, with room for its arguments. */
export const completeSlashCommand = (name) => `/${name} `;
