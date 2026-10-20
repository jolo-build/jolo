import { describe, expect, test } from 'bun:test';
import { typingMention, completeMention, mentionChoices, mentionHint, folderListingText, workspaceFileAttachment, workspaceFolderAttachment, projectPointerAttachment, FILE_ROWS } from '../src/renderer/mention-picker.js';

const agents = [
  { id: 'codex', displayName: 'Codex', model: 'gpt-6', available: true, transport: 'codex-app-server' },
  { id: 'claude', displayName: 'Claude Code', model: null, available: true, transport: 'claude-stream' },
  { id: 'shell', displayName: 'Shell', model: null, available: true, transport: 'pty' },
];
/** @type {{ path: string, kind: 'file' | 'directory' }[]} */
const entries = [{ path: 'src/components', kind: 'directory' }, { path: 'src/components/composer.jsx', kind: 'file' }];
const projects = [{ name: 'jolo', path: '/work/jolo', workspaceId: 'wsp_jolo' }, { name: 'notes', path: '/work/notes', workspaceId: 'wsp_notes' }];

describe('what "@" is being typed', () => {
  test('at the start of a message it can name an agent; after a space it brings a file in; elsewhere it is text', () => {
    expect(typingMention('@co', 3)).toEqual({ query: 'co', start: 0, atStart: true });
    expect(typingMention('  @src/app', 10)).toEqual({ query: 'src/app', start: 2, atStart: true });
    expect(typingMention('look at @src/app.js', 19)).toEqual({ query: 'src/app.js', start: 8, atStart: false });
    expect(typingMention('mail me at a@b.com', 18)).toBeNull();
    expect(typingMention('@src/app.js done', 16)).toBeNull(); // the mention ended at the space
    expect(typingMention('look at @src/app.js', 10)).toEqual({ query: 's', start: 8, atStart: false }); // only up to the caret
  });

  test('completing inserts the token with a trailing space and keeps what follows the caret', () => {
    expect(completeMention('@co', 3, typingMention('@co', 3), 'codex')).toEqual({ value: '@codex ', cursor: 7 });
    expect(completeMention('look at @src and fix it', 12, typingMention('look at @src and fix it', 12), 'src/app.js')).toEqual({ value: 'look at @src/app.js  and fix it', cursor: 20 });
  });
});

describe('one list in section order', () => {
  test('agents, then files and folders, then other projects', () => {
    const mention = { query: 'co', start: 0, atStart: true };
    const choices = mentionChoices({ mention, agents, answererId: 'jolo', entries, projects: [] });
    expect(choices.map(choice => [choice.section, choice.kind, choice.token])).toEqual([
      ['Agents', 'agent', 'codex'],
      ['Files and folders', 'folder', 'src/components/'],
      ['Files and folders', 'file', 'src/components/composer.jsx'],
    ]);
    expect(choices[0].label).toBe('Codex · GPT 6');
    expect(choices[1].name).toBe('components');
    expect(choices[2].label).toBe('');
  });

  test('agents only where a message routes: not mid-message, not for a path, never the terminal kind or the current answerer', () => {
    expect(mentionChoices({ mention: { query: 'co', start: 8, atStart: false }, agents, answererId: 'jolo', entries, projects: [] }).map(choice => choice.kind)).toEqual(['folder', 'file']);
    expect(mentionChoices({ mention: { query: 'src/co', start: 0, atStart: true }, agents, answererId: 'jolo', entries, projects: [] }).map(choice => choice.kind)).toEqual(['folder', 'file']);
    const byName = mentionChoices({ mention: { query: '', start: 0, atStart: true }, agents, answererId: 'codex', entries: [], projects: [] }).map(choice => choice.token);
    expect(byName).toEqual(['jolo', 'claude']);
  });

  test('files are capped at the picker height and folders carry a trailing slash', () => {
    const many = Array.from({ length: FILE_ROWS + 3 }, (_, index) => ({ path: `file-${index}.js`, kind: /** @type {const} */ ('file') }));
    const choices = mentionChoices({ mention: { query: 'file', start: 0, atStart: true }, agents: [], entries: [{ path: 'src', kind: /** @type {const} */ ('directory') }, ...many], projects: [] });
    expect(choices).toHaveLength(FILE_ROWS);
    expect(choices[0].token).toBe('src/');
    expect(choices[0].id).not.toBe(choices[1].id);
  });

  test('other projects match by name and carry their folder; nothing typed offers them all', () => {
    const all = mentionChoices({ mention: { query: '', start: 0, atStart: true }, agents: [], entries: [], projects });
    expect(all.map(choice => [choice.section, choice.token, choice.label])).toEqual([['Other projects', 'jolo', '/work/jolo'], ['Other projects', 'notes', '/work/notes']]);
    expect(mentionChoices({ mention: { query: 'NOT', start: 0, atStart: true }, agents: [], entries: [], projects }).map(choice => choice.id)).toEqual(['project:wsp_notes']);
    expect(mentionChoices({ mention: null, agents, entries, projects })).toEqual([]);
  });

  test('the hint says what the highlighted row does', () => {
    expect(mentionHint(undefined, 'Jolo')).toBe('answers this one message, then Jolo carries on');
    expect(mentionHint({ kind: 'agent' }, 'Claude Code')).toBe('answers this one message, then Claude Code carries on');
    expect(mentionHint({ kind: 'file' }, 'Jolo')).toContain('Attaches this file');
    expect(mentionHint({ kind: 'folder' }, 'Jolo')).toContain('top-level listing');
    expect(mentionHint({ kind: 'project' }, 'Jolo')).toContain('where this project lives');
  });
});

describe('what a picked row attaches', () => {
  const decode = attachment => Buffer.from(attachment.dataUrl.slice(attachment.dataUrl.indexOf(',') + 1), 'base64');

  test('a text file becomes a text attachment named by its path, the way a dropped file does', async () => {
    const calls = [];
    const call = async (method, params) => { calls.push([method, params]); return { path: params.path, text: 'export const answer = 42;\n', bytes: 26, truncated: false, binary: false }; };
    const attachment = await workspaceFileAttachment(call, 'wsp_1', 'src/app.js');
    expect(attachment).toMatchObject({ name: 'src/app.js', mimeType: 'text/plain', bytes: 26, text: 'export const answer = 42;\n' });
    expect(decode(attachment).toString('utf8')).toBe('export const answer = 42;\n');
    expect(calls).toEqual([['workspace.readFile', { workspaceId: 'wsp_1', path: 'src/app.js', maxBytes: 1024 * 1024 }]]);
  });

  test('a binary file is read again as bytes; an oversized or empty one leaves only its path in the message', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x00, 0x47]);
    const call = async (method, params) => params.encoding === 'base64' ? { text: bytes.toString('base64'), bytes: 4, truncated: false, binary: true } : { text: '', bytes: 4, truncated: false, binary: true };
    const attachment = await workspaceFileAttachment(call, 'wsp_1', 'logo.png');
    expect(attachment).toMatchObject({ name: 'logo.png', mimeType: 'application/octet-stream', bytes: 4 });
    expect(decode(attachment)).toEqual(bytes);
    await expect(workspaceFileAttachment(async () => ({ text: '', bytes: 1024 * 1024, truncated: true, binary: false }), 'wsp_1', 'huge.log')).rejects.toThrow('larger than 1 MB');
    await expect(workspaceFileAttachment(async () => ({ text: '', bytes: 0, truncated: false, binary: false }), 'wsp_1', 'empty.txt')).rejects.toThrow('empty');
  });

  test('a folder carries its location and top-level names only, capped and saying so', async () => {
    const listing = { entries: [{ path: 'src/components', kind: 'directory' }, { path: 'src/app.js', kind: 'file' }], truncated: true, total: 9, source: 'listing' };
    const call = async (method, params) => { expect([method, params]).toEqual(['workspace.files', { workspaceId: 'wsp_1', path: 'src', limit: 200 }]); return listing; };
    const attachment = await workspaceFolderAttachment(call, { id: 'wsp_1', path: '/work/app' }, 'src');
    expect(attachment.name).toBe('src/');
    expect(attachment.text).toBe('Folder src/ of this project, at /work/app/src.\nTop-level entries (names only; first 2 of 9):\ncomponents/\napp.js\n');
    expect(folderListingText({ heading: 'Here.', listing: { ...listing, truncated: false, total: 2 } })).toBe('Here.\nTop-level entries (names only; 2):\ncomponents/\napp.js\n');
  });

  test('another project carries its folder path and top level under its own name', async () => {
    const call = async (method, params) => { expect([method, params]).toEqual(['workspace.files', { workspaceId: 'wsp_notes', path: '.', limit: 200 }]); return { entries: [{ path: 'README.md', kind: 'file' }], truncated: false, total: 1, source: 'listing' }; };
    const attachment = await projectPointerAttachment(call, projects[1]);
    expect(attachment.name).toBe('notes');
    expect(attachment.text).toBe('Project notes is the folder /work/notes. It is a separate project from the one this task runs in.\nTop-level entries (names only; 1):\nREADME.md\n');
  });
});
