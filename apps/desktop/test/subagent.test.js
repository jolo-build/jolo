import { expect, test } from 'bun:test';
import { editedFiles, parseSubagent, shortStep } from '../src/renderer/subagent.js';

const head = 'Agent {"subagent_type":"Explore","description":"Find where tokens refresh","prompt":"Look through src/auth"}';

test("a subagent call reads back as its kind, purpose, model, tools and report", () => {
  const text = `${head}\n↳ model: claude-opus-5-5\n↳ Grep refresh\n↳ Read src/auth/session.ts\n\nTokens refresh in session.ts.\n\nSee line 40.\n`;
  expect(parseSubagent(text)).toEqual({ type: 'Explore', description: 'Find where tokens refresh', model: 'claude-opus-5-5', steps: ['Grep refresh', 'Read src/auth/session.ts'], report: 'Tokens refresh in session.ts.\n\nSee line 40.' });
});

test('a subagent that has not started yet, an older Task call and a cut-off head still read back', () => {
  expect(parseSubagent(`${head}\n`)).toEqual({ type: 'Explore', description: 'Find where tokens refresh', model: null, steps: [], report: '' });
  expect(parseSubagent('Task {"prompt":"Review the diff\\nthen report","model":"sonnet"}\nLooks good.')).toEqual({ type: 'Agent', description: 'Review the diff', model: 'sonnet', steps: [], report: 'Looks good.' });
  expect(parseSubagent('Agent {"subagent_type":"Plan","description":"Plan the \\"move\\"","prompt":"A very long prom')?.description).toBe('Plan the "move"');
});

test("a report is never read as progress, and line separators in the head do not hide the call", () => {
  expect(parseSubagent(`${head}\n↳ Grep refresh\n\n↳ quoted from the agent\nDone.`)).toMatchObject({ steps: ['Grep refresh'], report: '↳ quoted from the agent\nDone.' });
  expect(parseSubagent('Agent {"description":"Split\u2028here","prompt":"x"}')?.description).toBe('Split\u2028here');
});

test('other tool calls are not subagents', () => {
  expect(parseSubagent('Bash {"command":"ls"}\nfile.txt')).toBeNull();
  expect(parseSubagent('Agents {"description":"x"}')).toBeNull();
  expect(parseSubagent('Agent {}')).toBeNull();
  expect(parseSubagent('')).toBeNull();
});

test('the live line shows the verb and the file; the edited files are listed once each', () => {
  expect(shortStep("Bash: sed -n '600,800p' /usr/local/go/src/net/http/server.go")).toBe('sed … server.go');
  expect(shortStep('Bash: echo child-review')).toBe('echo child-review');
  expect(shortStep('Bash: bun run typecheck 2>&1')).toBe('bun …');
  expect(shortStep('Read src/auth/session.ts')).toBe('Read session.ts');
  expect(shortStep('Grep refresh')).toBe('Grep refresh');
  expect(editedFiles(['Read a.js', 'Edit src/a.js', 'Write src/b.js', 'Edit src/a.js', 'Bash: ls'])).toEqual(['src/a.js', 'src/b.js']);
});
