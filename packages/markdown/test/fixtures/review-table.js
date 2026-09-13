// Regression fixture based on the reported review table.
export const reviewTable = [
  '### Verdict on the nine findings',
  '',
  "| # | Claude's call | Mine after re-checking |",
  '| --- | --- | --- |',
  "| 1 | Real bug, worse than stated | Agree it's a bug — the comments at `compaction.js:84` and `:100` describe intent the code contradicts. Two caveats below. |",
  "| 2 | Skip persistence | **Concede.** No un-learn path exists, so a mislearned window becomes permanent; restart is the natural reset. The value is already persisted per-run via `setRunProviderConfig`. |",
  '| 3 | Confirmed, wrong consequence | **Concede.** `nearLimit` is already `dropped > 0`. Real effects: inflated UI gauge and a too-large `assumed` window at `loop.js:153`. |',
  '| 4 | Hardening, thinking path only | Agree — text blocks are never replayed, but thinking blocks are (`native.block`), so `"undefined"` corruption fails signature verification on the next request. |',
  '| 5 | Confirmed | Agree — cancellation still cuts through via the shared controller signal; the exposure is a held-open error body. |',
  "| 6 | Confirmed nit | Agree, plus Claude's extension: `/exceed\\|limit/i` on arbitrary thrown messages can misclassify other errors as non-retryable `limit`. Set category in `sse.js`. |",
  "| 7 | Dead spread real; capability drop correct | **Concede.** Limits belong to a model — an override must not inherit them, and the check at `index.js:85` then fails clearly. |",
  '| 8 | Informational | Agree. No signal exists to disambiguate on. |',
  '| 9 | Deliberate | Agree. Persisted denial + resume is coherent. |',
].join('\n');
