export const SLASH_COMMANDS = Object.freeze([
  { command: '/model', description: 'Choose or configure a model' },
  { command: '/sessions', description: 'Open a saved conversation' },
  { command: '/themes', description: 'Choose a color theme' },
  { command: '/theme create', description: 'Create a custom theme', arguments: true },
  { command: '/theme install', description: 'Install a theme from a file or URL', arguments: true },
  { command: '/theme use', description: 'Apply a theme by ID', arguments: true },
  { command: '/theme show', description: 'Inspect theme colors' },
  { command: '/theme remove', description: 'Remove an installed theme', arguments: true },
  { command: '/session restore', description: 'Restore a conversation by ID', arguments: true },
  { command: '/session delete', description: 'Delete a saved conversation', arguments: true },
]);

export function slashCommands(input) {
  if (!input.startsWith('/')) return [];
  return SLASH_COMMANDS.filter((item) => item.command.startsWith(input));
}
