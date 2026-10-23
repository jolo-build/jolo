// SQL for the questions an agent asks the person (dialogs), sharing Storage's exclusive connection and transactions.
import { newId, now, mapDialog } from "./records.js";

export class DialogRepository {
  constructor(storage) { this.db = storage.db; }

  insert({ sessionId, runId, requestId, tool, toolUseId = null, input }) {
    const id = newId("dlg");
    this.db.query("INSERT INTO dialogs (id, session_id, run_id, request_id, tool, tool_use_id, input, state, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'requested', ?8)")
      .run(id, sessionId, runId, requestId, tool, toolUseId, JSON.stringify(input), now());
    return this.get(id);
  }

  get(id) { return mapDialog(this.db.query("SELECT * FROM dialogs WHERE id = ?1").get(id)); }

  /** Settle a dialog still waiting on the person; null when it was already settled. */
  settle(id, { state, response = null }) {
    const changed = this.db.query("UPDATE dialogs SET state = ?1, response = ?2, resolved_at = ?3 WHERE id = ?4 AND state = 'requested'")
      .run(state, response === null ? null : JSON.stringify(response), now(), id).changes;
    return changed ? this.get(id) : null;
  }

  requested() { return this.db.query("SELECT * FROM dialogs WHERE state = 'requested' ORDER BY created_at, id").all().map(mapDialog); }
}
