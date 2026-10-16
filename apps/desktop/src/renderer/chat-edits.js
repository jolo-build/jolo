import { fileDiffSections } from './change-cards.js';

/** In-flight deduplication and a bounded cache of immutable artifacts shared by both review surfaces. */
const artifacts = new Map();
export function readEditArtifact(artifactId) {
  if (artifacts.has(artifactId)) return artifacts.get(artifactId);
  const result = (async () => {
    let offset = 0, text = '', eof = false;
    const decoder = new TextDecoder();
    while (!eof && offset < 256 * 1024) {
      const response = await window.jolo.call('artifact.read', { artifactId, offset, length: 64 * 1024, encoding: 'base64' });
      if (!response.ok) throw new Error(response.error.message);
      const bytes = Uint8Array.from(atob(response.result.text), character => character.charCodeAt(0));
      text += decoder.decode(bytes, { stream: true });
      offset += response.result.bytes;
      eof = response.result.eof;
      if (!response.result.bytes) break;
    }
    text += decoder.decode();
    return { text, eof };
  })().catch(error => { artifacts.delete(artifactId); throw error; });
  artifacts.set(artifactId, result);
  if (artifacts.size > 32) artifacts.delete(artifacts.keys().next().value);
  return result;
}
export async function loadRecordedDiff(path, file) {
  if (!file?.diffArtifactIds?.length) return { source: 'none', diff: '', truncated: false };
  let diff = '', truncated = false;
  // Each section is a separate edit, not a net diff against today's working tree.
  for (const id of file.diffArtifactIds) {
    const result = await readEditArtifact(id);
    diff += fileDiffSections(result.text, path) + '\n';
    truncated ||= !result.eof || /^… /m.test(result.text);
  }
  return { source: 'artifact', diff: diff.trimEnd(), truncated };
}
export const editViewKey = sessionId => `jolo.chatEdits.${sessionId}`;
export function readEditView(sessionId) {
  try { return JSON.parse(localStorage.getItem(editViewKey(sessionId)) ?? '{}') ?? {}; } catch { return {}; }
}
export function saveEditView(sessionId, patch) {
  if (!sessionId) return;
  try { localStorage.setItem(editViewKey(sessionId), JSON.stringify({ ...readEditView(sessionId), ...patch })); } catch { /* optional view preference */ }
}
