import { expect, test } from 'bun:test';
import { completeSlashCommand, slashCommandChoices, typingSlashCommand } from '../src/renderer/slash-commands.js';

const COMMANDS = [
  { name: 'compact', description: 'Free up context', argumentHint: '' },
  { name: 'review', description: 'Review the working tree', argumentHint: '[what to review]' },
  { name: 'code-review', description: 'Review the branch', argumentHint: '' },
  { name: 'plugin:deploy', description: 'Ship it', argumentHint: '<environment>' },
];

test('the picker opens only while "/" and a name are the whole message', () => {
  expect(typingSlashCommand('/', 1)).toEqual({ query: '' });
  expect(typingSlashCommand('/rev', 4)).toEqual({ query: 'rev' });
  expect(typingSlashCommand('/plugin:dep', 11)).toEqual({ query: 'plugin:dep' });
  expect(typingSlashCommand('/review ', 8)).toBeNull(); // a space ends the name: the command is chosen, arguments follow
  expect(typingSlashCommand('/review x', 7)).toBeNull(); // text after the caret: not the whole message
  expect(typingSlashCommand(' /review', 8)).toBeNull(); // nothing may come before the slash
  expect(typingSlashCommand('see /review', 11)).toBeNull();
  expect(typingSlashCommand('/usr/bin', 8)).toBeNull(); // a path is not a command
  expect(typingSlashCommand('', 0)).toBeNull();
  expect(typingSlashCommand('/review', 0)).toBeNull(); // Escape parks the caret at 0, which closes the list
});

test('choices are the agent’s list, then names starting with what was typed before names containing it', () => {
  expect(slashCommandChoices(COMMANDS, '').map(command => command.name)).toEqual(['compact', 'review', 'code-review', 'plugin:deploy']);
  expect(slashCommandChoices(COMMANDS, 'rev').map(command => command.name)).toEqual(['review', 'code-review']);
  expect(slashCommandChoices(COMMANDS, 'REV').map(command => command.name)).toEqual(['review', 'code-review']);
  expect(slashCommandChoices(COMMANDS, 'deploy').map(command => command.name)).toEqual(['plugin:deploy']);
  expect(slashCommandChoices(COMMANDS, 'zzz')).toEqual([]);
  expect(slashCommandChoices(COMMANDS, '', 2).map(command => command.name)).toEqual(['compact', 'review']);
  expect(slashCommandChoices([{ name: '' }, { description: 'nameless' }, null], '')).toEqual([]);
  expect(slashCommandChoices(undefined, 'x')).toEqual([]);
});

test('completing a command leaves the message ready for its arguments', () => {
  expect(completeSlashCommand('review')).toBe('/review ');
  expect(typingSlashCommand(completeSlashCommand('review'), 8)).toBeNull(); // and the list is closed
});
