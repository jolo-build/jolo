// Durable review projections are independent of the bounded reconnect feed.
export class EventRepository {
  constructor(db) {
    this.db = db;
    this.statements = {
      upsertSummary: db.query('INSERT INTO run_event_summary(run_id,last_at) VALUES(?1,?2) ON CONFLICT(run_id) DO UPDATE SET last_at=excluded.last_at'),
      deleteChangedPath: db.query('DELETE FROM run_changed_paths WHERE run_id=?1 AND path=?2'),
      insertChangedPath: db.query('INSERT OR IGNORE INTO run_changed_paths(run_id,path) VALUES(?1,?2)'),
      upsertTool: db.query("INSERT OR REPLACE INTO run_tool_activity(invocation_id,run_id,name,preview,status,at,seq) VALUES(?1,?2,?3,?4,'running',?5,?6)"),
      completeTool: db.query('UPDATE run_tool_activity SET status=?1 WHERE invocation_id=?2'),
      recentTools: db.query('SELECT invocation_id AS invocationId,name,preview,status,at FROM run_tool_activity WHERE run_id=?1 ORDER BY seq DESC LIMIT ?2'),
      changedPaths: db.query('SELECT path FROM run_changed_paths WHERE run_id=?1 ORDER BY path'),
      lastAt: db.query('SELECT last_at FROM run_event_summary WHERE run_id=?1'),
    };
  }
  project(event) {
    if (!event.runId) return;
    const p = event.payload;
    this.statements.upsertSummary.run(event.runId, event.at);
    if (event.type === 'files.changed') {
      for (const change of p.changes ?? []) {
        if (change.newPath) this.statements.deleteChangedPath.run(event.runId, change.path);
        this.statements.insertChangedPath.run(event.runId, change.newPath ?? change.path);
      }
    } else if (event.type === 'tool.started') {
      this.statements.upsertTool.run(p.invocationId, event.runId, p.name, p.preview ?? '', event.at, Number(event.eventSeq));
    } else if (event.type === 'tool.completed') {
      this.statements.completeTool.run(p.status, p.invocationId);
    }
  }
  bootstrap() {
    // Transactional once-only backfill before the first pruning pass.
    if (this.db.query("SELECT 1 FROM preferences WHERE key='event-projections-v1'").get()) return;
    this.db.transaction(() => {
      for (const row of this.db.query('SELECT * FROM events ORDER BY seq').iterate()) {
        this.project({ runId: row.run_id, type: row.type, payload: JSON.parse(row.payload), at: row.at, eventSeq: String(row.seq) });
      }
      this.db.query("INSERT INTO preferences(key,value) VALUES('event-projections-v1','true')").run();
    })();
  }
  prune(keep = 10000) {
    const high = this.db.query("SELECT seq FROM sqlite_sequence WHERE name='events'").get()?.seq ?? 0;
    this.db.query('DELETE FROM events WHERE seq <= ?1').run(high - keep);
  }
  recentTools(runId, limit) {
    return this.statements.recentTools.all(runId, limit).reverse();
  }
  changedPaths(runId) { return this.statements.changedPaths.all(runId).map(row => row.path); }
  lastAt(runId) { return this.statements.lastAt.get(runId)?.last_at ?? null; }
}
