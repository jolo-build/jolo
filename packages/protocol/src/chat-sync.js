// Portable history and folder identities; never local paths, execution state or files.
export const CHAT_BYTES = 1024 * 1024;
const identity = value => value && /^[a-f0-9-]{36}$/.test(value.id) && typeof value.name === 'string' && value.name.length > 0 && value.name.length <= 500;
export function validChatContext(value) {
  return value && identity(value.project) && identity(value.workspace)
    && ['direct', 'worktree'].includes(value.workspace.mode)
    && (value.workspace.branch === null || (typeof value.workspace.branch === 'string' && value.workspace.branch.length <= 500));
}
export function validChat(value) {
  return value && (value.version === 1 || (value.version === 2 && validChatContext(value.context))) && typeof value.title === 'string' && value.title.length <= 500
    && Array.isArray(value.messages) && value.messages.length <= 10000
    && value.messages.every(m => m && ['user', 'assistant'].includes(m.role) && typeof m.text === 'string')
    && new TextEncoder().encode(JSON.stringify(value)).byteLength <= CHAT_BYTES;
}
