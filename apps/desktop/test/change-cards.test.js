import { expect, test } from 'bun:test';
import { SessionProjection } from '@jolo/client/projection';
import { fileDiffSections, readChangeCards, saveChangeCards, updateChangeCards } from '../src/renderer/change-cards.js';
import { diffSummary } from '../src/renderer/diff-lines.js';

const edited = (id, path = 'own.txt') => ({ id, state: 'completed', changedPaths: [path], changeEvents: [{ diffArtifactId: `diff-${id}`, changes: [{ path, op: 'create', beforeHash: null, afterHash: id }] }] });

test('only the run with recorded edits gets a card, including repeated edits to the same file', () => {
  let cards = updateChangeCards([], [edited('a'), { id: 'read-only', state: 'completed', changedPaths: [] }]);
  expect(cards.map(card => card.runId)).toEqual(['a']);
  cards[0].counts = [['a', { added: 1, removed: 0 }]];
  cards = updateChangeCards(cards, [edited('a'), edited('b')]);
  expect(cards.map(card => card.runId)).toEqual(['a', 'b']);
  expect(cards[0].counts).toEqual([['a', { added: 1, removed: 0 }]]);
  expect(cards[1].files[0].diffArtifactIds).toEqual(['diff-b']);
  expect(updateChangeCards([], [{ id: 'old-engine', state: 'completed' }])).toEqual([]);
});

test('reopened history uses durable paths and preserves cached immutable diff references', () => {
  const cards = updateChangeCards([], [edited('a')]);
  expect(updateChangeCards(cards, [{ id: 'a', state: 'completed', changedPaths: ['own.txt'] }])).toEqual(cards);
  expect(updateChangeCards(cards, [{ id: 'a', state: 'completed', changedPaths: [] }])).toEqual([]);
  expect(updateChangeCards([], [{ id: 'a', state: 'completed', changedPaths: ['saved.txt'] }])[0].files[0].path).toBe('saved.txt');
});

test('run projection attributes changes without requiring a tool message and survives reseeding', () => {
  const projection = new SessionProjection({ readArtifact: async () => ({ text: '', bytes: 0, eof: true }) });
  projection.seed({ runs: [{ id: 'a', state: 'tools' }, { id: 'b', state: 'completed', changedPaths: [] }], cursor: '1' });
  projection.applyEvent({ eventSeq: '2', sessionId: 's', runId: 'a', type: 'files.changed', payload: { invocationId: 'i', tool: 'apply_patch', diffArtifactId: 'diff', changes: [{ path: 'before.txt', newPath: 'after.txt', op: 'rename', beforeHash: 'a', afterHash: 'a' }] } });
  projection.seed({ runs: [{ id: 'a', state: 'completed', changedPaths: ['after.txt'] }], cursor: '3' });
  const cards = updateChangeCards([], [...projection.runs.values()]);
  expect(cards).toHaveLength(1);
  expect(cards[0].runId).toBe('a');
  expect(cards[0].files[0]).toMatchObject({ path: 'before.txt', newPath: 'after.txt', diffArtifactIds: ['diff'] });
});

test('per-file counts come only from that file in the saved tool diff', () => {
  const text = 'diff --git a/own.txt b/own.txt\n--- a/own.txt\n+++ b/own.txt\n-old\n+new\n+more\ndiff --git a/else.txt b/else.txt\n--- a/else.txt\n+++ b/else.txt\n+unrelated\n';
  expect(diffSummary(fileDiffSections(text, 'own.txt'))).toMatchObject({ files: 1, added: 2, removed: 1 });
  expect(fileDiffSections(text, 'missing.txt')).toBe('');
});

test('legacy workspace cards are discarded and new run-scoped cards survive reload', () => {
  const original = globalThis.localStorage;
  const data = new Map();
  globalThis.localStorage = /** @type {Storage} */ ({ getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: key => { data.delete(key); } });
  try {
    data.set('jolo.changeCards.s', JSON.stringify([{ runId: 'readonly', files: [{ path: 'another-chat.txt' }], counts: [] }]));
    expect(readChangeCards('s')).toEqual([]);
    expect(data.has('jolo.changeCards.s')).toBe(false);
    const cards = updateChangeCards([], [edited('a')]);
    saveChangeCards('s', cards);
    expect(readChangeCards('s')).toEqual(cards);
    expect(readChangeCards('other-chat')).toEqual([]);
  } finally { globalThis.localStorage = original; }
});
