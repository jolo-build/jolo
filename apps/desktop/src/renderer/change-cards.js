const FINISHED = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'paused']);
const cacheKey = sessionId => `jolo.runChangeCards.v2.${sessionId}`;

/** Only explicit run records can attribute a file. Working-tree status is shared by all chats. */
export function updateChangeCards(cards, runs) {
  const next = new Map(cards.map(card => [card.runId, card]));
  for (const run of runs) {
    if (!FINISHED.has(run.state)) continue;
    const previous = next.get(run.id);
    if (!run.changedPaths) continue; // Older engines cannot reconstruct this history.
    const files = new Map(run.changedPaths.map(path => {
      const saved = previous?.files.find(file => (file.newPath ?? file.path) === path);
      return [path, saved ?? { path, op: 'replace', invocationId: run.id, tool: 'run', diffArtifactIds: [] }];
    }));
    for (const event of run.changeEvents ?? []) for (const change of event.changes) {
      const path = change.newPath ?? change.path;
      if (!files.has(path)) continue;
      const ids = new Set(files.get(path).diffArtifactIds ?? []);
      if (event.diffArtifactId) ids.add(event.diffArtifactId);
      files.set(path, { ...change, invocationId: run.id, tool: 'run', diffArtifactIds: [...ids], revision: [...ids].join(':') });
    }
    if (!files.size) { next.delete(run.id); continue; }
    const list = [...files.values()];
    if (previous && JSON.stringify(previous.files) === JSON.stringify(list)) continue;
    next.set(run.id, { runId: run.id, files: list, counts: [] });
  }
  return [...next.values()].slice(-50);
}

/** Extract this file's sections from immutable per-tool diffs, never the live Git diff. */
export function fileDiffSections(text, path) {
  return text.split(/(?=^diff --git )/m).filter(section => {
    const header = section.split('\n', 1)[0];
    return header.endsWith(` b/${path}`);
  }).join('');
}

export function readChangeCards(sessionId) {
  try {
    // v1 cached whole-workspace snapshots under replies and cannot be trusted as attribution.
    localStorage.removeItem(`jolo.changeCards.${sessionId}`);
    const cards = JSON.parse(localStorage.getItem(cacheKey(sessionId)) ?? '[]');
    return Array.isArray(cards) ? cards.filter(card => typeof card?.runId === 'string' && Array.isArray(card.files) && card.files.every(file => typeof file?.path === 'string' && Array.isArray(file.diffArtifactIds)) && Array.isArray(card.counts)).slice(-50) : [];
  } catch { return []; }
}

export function saveChangeCards(sessionId, cards) {
  if (!sessionId) return;
  try { localStorage.setItem(cacheKey(sessionId), JSON.stringify(cards)); } catch { /* optional history cache */ }
}
