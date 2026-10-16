import { TERMINAL } from '@jolo/client/run-state';

export const unfinishedRuns = page => page.runs.filter(run => !TERMINAL.has(run.state));

/** Stop every unfinished turn, including older pauses hidden by newer messages. */
export async function stopAndDeleteSession(call, sessionId) {
  let page = await call('session.page', { sessionId });
  for (const run of unfinishedRuns(page).sort((a, b) => Number(b.state === 'queued') - Number(a.state === 'queued'))) {
    try { await call('run.cancel', { runId: run.id }); }
    catch (error) {
      const current = await call('run.snapshot', { runId: run.id });
      if (!TERMINAL.has(current.run.state)) throw error;
    }
  }
  const deadline = Date.now() + 10_000;
  for (;;) {
    page = await call('session.page', { sessionId });
    if (!unfinishedRuns(page).length) break;
    if (Date.now() >= deadline) throw new Error('The task is still stopping. Please retry deletion in a moment.');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return call('session.delete', { sessionId, expectedRevision: page.session.revision });
}
