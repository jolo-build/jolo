/** Keep each result's file list and counts attached to its owning turn. */
export function updateChangeCards(cards, runId, files) {
  if (!runId || !files.length) return cards;
  const signature = JSON.stringify(files);
  const previous = cards.at(-1);
  if (previous && JSON.stringify(previous.files) === signature) return cards;
  const card = { runId, files, counts: [] };
  return [...(previous?.runId === runId ? cards.slice(0, -1) : cards), card].slice(-50);
}

export function readChangeCards(sessionId) {
  try {
    const cards = JSON.parse(localStorage.getItem(`jolo.changeCards.${sessionId}`) ?? '[]');
    return Array.isArray(cards) ? cards.filter(card => typeof card?.runId === 'string' && Array.isArray(card.files) && card.files.every(file => typeof file?.path === 'string') && Array.isArray(card.counts)).slice(-50) : [];
  } catch { return []; }
}

export function saveChangeCards(sessionId, cards) {
  if (!sessionId) return;
  try { localStorage.setItem(`jolo.changeCards.${sessionId}`, JSON.stringify(cards)); } catch { /* optional history cache */ }
}
