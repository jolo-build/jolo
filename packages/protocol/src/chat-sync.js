// Portable conversation history only: never execution state, credentials or files.
export const CHAT_BYTES = 1024 * 1024;
export function validChat(value) {
  return value && value.version === 1 && typeof value.title === 'string' && value.title.length <= 500
    && Array.isArray(value.messages) && value.messages.length <= 10000
    && value.messages.every(m => m && ['user', 'assistant'].includes(m.role) && typeof m.text === 'string')
    && new TextEncoder().encode(JSON.stringify(value)).byteLength <= CHAT_BYTES;
}
