// The "@" picker: who a message can call in, which of the project's files and folders it can bring
// along, and which other project it can point at, in one list the arrow keys walk top to bottom.
import { IMAGE_LIMITS as LIMITS } from '@jolo/protocol/attachments';
import { modelLabel } from './model-options.js';

export const FILE_ROWS = 8;
const AGENT_ROWS = 6;
const PROJECT_ROWS = 6;
/** How many names a folder or project pointer carries: enough to orient an agent, never a full tree. */
export const LISTING_NAMES = 200;
const READ_MAX_BYTES = 1024 * 1024;

/**
 * The "@…" at the caret, or null. At the start of the message it can also name an agent, because that
 * is where a message routes; after a space it brings a file, folder or project into the message.
 * @param {string} value
 * @param {number} caret
 */
export function typingMention(value, caret) {
  const before = value.slice(0, caret);
  const match = /(?:^|\s)@([^\s@]*)$/.exec(before);
  if (!match) return null;
  const start = caret - match[1].length - 1;
  return { query: match[1], start, atStart: !before.slice(0, start).trim() };
}

/** The message with its mention completed and the caret placed after it. */
export function completeMention(text, caret, mention, token) {
  const insert = `@${token} `;
  return { value: text.slice(0, mention.start) + insert + text.slice(caret), cursor: mention.start + insert.length };
}

/** The agents a message can call in by name, matching what has been typed after "@" (§6.5). */
export function mentionableAgents(agents, typed, answerer) {
  const options = [{ id: 'jolo', name: 'Jolo', detail: "Jolo's own loop" }, ...agents.filter(entry => entry.available && entry.transport !== 'pty').map(entry => ({ id: entry.id, name: entry.displayName, detail: modelLabel(entry.model) }))];
  const query = typed.toLowerCase();
  return options.filter(option => option.id !== (answerer ?? 'jolo') && (option.id.startsWith(query) || option.name.toLowerCase().startsWith(query))).slice(0, AGENT_ROWS)
    .map(option => ({ kind: /** @type {const} */ ('agent'), section: 'Agents', id: option.id, token: option.id, name: option.name, label: `${option.name}${option.detail ? ` · ${option.detail}` : ''}` }));
}

/**
 * One flat list in section order: agents (only where a message routes), then the project's files and
 * folders as the engine ranked them, then the other projects the sidebar lists.
 * @param {{ mention: { query: string, start: number, atStart: boolean } | null, agents?: any[], answererId?: string | null, entries?: { path: string, kind: 'file' | 'directory' }[], projects?: { name: string, path: string, workspaceId: string }[] }} input
 */
export function mentionChoices({ mention, agents = [], answererId = null, entries = [], projects = [] }) {
  if (!mention) return [];
  const query = mention.query.toLowerCase();
  const agentRows = mention.atStart && !query.includes('/') ? mentionableAgents(agents, query, answererId) : [];
  const fileRows = entries.slice(0, FILE_ROWS).map(entry => ({
    kind: entry.kind === 'directory' ? /** @type {const} */ ('folder') : /** @type {const} */ ('file'), section: 'Files and folders',
    id: `${entry.kind}:${entry.path}`, token: entry.kind === 'directory' ? `${entry.path}/` : entry.path, path: entry.path, name: entry.path.slice(entry.path.lastIndexOf('/') + 1), label: '',
  }));
  const projectRows = projects.filter(project => !query || project.name.toLowerCase().includes(query)).slice(0, PROJECT_ROWS)
    .map(project => ({ kind: /** @type {const} */ ('project'), section: 'Other projects', id: `project:${project.workspaceId}`, token: project.name, name: project.name, label: project.path, path: project.path, workspaceId: project.workspaceId }));
  return [...agentRows, ...fileRows, ...projectRows];
}

/** What picking the highlighted row does, said under the list. */
export function mentionHint(choice, answererName) {
  if (!choice || choice.kind === 'agent') return `answers this one message, then ${answererName} carries on`;
  if (choice.kind === 'file') return 'Attaches this file to the message';
  if (choice.kind === 'folder') return 'Attaches the folder’s top-level listing, so the agent knows where to look';
  return 'Tells the agent where this project lives';
}

const base64 = bytes => {
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
};
const textAttachment = (name, text) => {
  const bytes = new TextEncoder().encode(text);
  return { id: crypto.randomUUID(), name: name.slice(-200), mimeType: 'text/plain', bytes: bytes.length, dataUrl: `data:text/plain;base64,${base64(bytes)}`, text };
};

/**
 * The chosen file as the message attaches it: the way a dropped file is, text when it reads as text and
 * bytes otherwise. The path is already in the message; a file the engine will not hand over leaves it there.
 * @param {(method: string, params: any) => Promise<any>} call
 */
export async function workspaceFileAttachment(call, workspaceId, filePath) {
  const read = await call('workspace.readFile', { workspaceId, path: filePath, maxBytes: READ_MAX_BYTES });
  if (read.truncated) throw new Error(`${filePath} is larger than 1 MB, so only its path is in the message.`);
  if (!read.bytes) throw new Error(`${filePath} is empty, so only its path is in the message.`);
  if (!read.binary && read.bytes <= LIMITS.textAttachmentBytes) return textAttachment(filePath, read.text);
  const bytes = await call('workspace.readFile', { workspaceId, path: filePath, maxBytes: READ_MAX_BYTES, encoding: 'base64' });
  return { id: crypto.randomUUID(), name: filePath.slice(-200), mimeType: 'application/octet-stream', bytes: bytes.bytes, dataUrl: `data:application/octet-stream;base64,${bytes.text}` };
}

/** The text a folder pointer carries: where the folder is and what sits at its top level, names only. */
export function folderListingText({ heading, listing }) {
  const names = listing.entries.map(entry => entry.kind === 'directory' ? `${entry.path.slice(entry.path.lastIndexOf('/') + 1)}/` : entry.path.slice(entry.path.lastIndexOf('/') + 1));
  const count = listing.truncated ? `first ${listing.entries.length} of ${listing.total}` : `${listing.entries.length}`;
  return `${heading}\nTop-level entries (names only; ${count}):\n${names.join('\n')}\n`;
}

/**
 * A folder of this project as the message attaches it.
 * @param {(method: string, params: any) => Promise<any>} call
 */
export async function workspaceFolderAttachment(call, workspace, folder) {
  const listing = await call('workspace.files', { workspaceId: workspace.id, path: folder, limit: LISTING_NAMES });
  return textAttachment(`${folder}/`, folderListingText({ heading: `Folder ${folder}/ of this project, at ${workspace.path}/${folder}.`, listing }));
}

/**
 * Another project as the message attaches it: the folder's path, and its top level so the agent can tell what is there.
 * @param {(method: string, params: any) => Promise<any>} call
 */
export async function projectPointerAttachment(call, project) {
  const listing = await call('workspace.files', { workspaceId: project.workspaceId, path: '.', limit: LISTING_NAMES });
  return textAttachment(project.name, folderListingText({ heading: `Project ${project.name} is the folder ${project.path}. It is a separate project from the one this task runs in.`, listing }));
}
