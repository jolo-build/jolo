import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Storage } from '../src/storage/index.js';
import { createRpcHandlers } from '../src/rpc/handlers.js';

/** A real store with one Claude session in it. */
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'j-continuity-'));
  const storage = new Storage({ databasePath: path.join(root, 'db'), artifactsDir: path.join(root, 'artifacts'), bootId: 'boot' });
  const project = storage.upsertProject({ identity: 'project', rootPath: root });
  const workspace = storage.ensureDirectWorkspace(project.id, root);
  const session = storage.createSession({ projectId: project.id, workspaceId: workspace.id, title: 'task', agentId: 'claude' });
  return { storage, workspace, session, close() { storage.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('a stand-in an earlier build stored for a turn Claude began by itself stays hidden on older pages too', async () => {
  const { storage, session, close } = fixture();
  try {
    const say = (run, role) => storage.insertMessage({ sessionId: session.id, runId: run.id, role, artifactId: storage.createArtifact({ sessionId: session.id, kind: 'text' }).id, ordinal: storage.nextMessageOrdinal(session.id) });
    const own = storage.insertRun({ sessionId: session.id, requestId: 'continue:old', prompt: 'Claude Code carried on by itself.' });
    say(own, 'user'); say(own, 'assistant');
    Bun.sleepSync(5); // every later run is newer: the page's run list no longer reaches this one
    for (let i = 0; i < 60; i++) { const run = storage.insertRun({ sessionId: session.id, requestId: `r${i}`, prompt: `p${i}` }); say(run, 'user'); say(run, 'assistant'); }
    const handlers = createRpcHandlers(/** @type {any} */ ({ storage }));
    const page = await handlers['session.page']({ sessionId: session.id, limit: 500 });
    expect(page.messages.filter((m) => m.runId === own.id).map((m) => m.role)).toEqual(['assistant']);
    // Paged one message at a time, as far back as it goes, the hidden stand-in never leaves an empty page behind.
    const seen = [];
    for (let before; ;) {
      const older = await handlers['session.page']({ sessionId: session.id, limit: 1, ...(before === undefined ? {} : { beforeOrdinal: before }) });
      expect(older.messages).toHaveLength(1);
      seen.push(...older.messages);
      if (!older.hasOlder) break;
      before = older.messages[0].ordinal;
    }
    expect(seen).toHaveLength(page.messages.length);
  } finally { close(); }
});

test('switching agents forgets what each dropped thread was told, while Jolo\'s own transcript keeps its place', () => {
  const { storage, session, close } = fixture();
  try {
    storage.setSessionAgentState(session.id, { claude: { sessionId: 'claude-thread' }, codex: { codexThreadId: 'codex-thread' }, _jolo: { seen: { claude: 5, codex: 3, jolo: 4 }, carriedOn: { claude: ['run_a'] } } });
    const switched = storage.setSessionAgent(session.id, 'codex');
    expect(switched.agentState).toEqual({ _jolo: { seen: { jolo: 4 }, carriedOn: {} } });
  } finally { close(); }
});

test('a process\'s grants end with it, and so do those of the agents that ran under it, but no other\'s', () => {
  const { storage, workspace, close } = fixture();
  try {
    for (const runId of ['link:s1', 'link:s1:agent-a', 'link:s10:agent-a', 'link:s1x', 'run_other']) storage.insertGrant({ scope: 'execute', constraints: { workspaceId: workspace.id, runId } });
    storage.expireRunGrants('link:s1', { andScopedUnder: true });
    const live = storage.db.query("SELECT json_extract(constraints,'$.runId') AS runId FROM grants WHERE expires_at IS NULL OR expires_at > ?1 ORDER BY runId").all(new Date().toISOString()).map((row) => row.runId);
    expect(live).toEqual(['link:s10:agent-a', 'link:s1x', 'run_other']);
  } finally { close(); }
});
