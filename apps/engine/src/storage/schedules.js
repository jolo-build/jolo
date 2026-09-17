// SQL for the schedules aggregate, sharing Storage's exclusive connection and transactions.
import { newId, now, mapSchedule } from "./records.js";

export class ScheduleRepository {
  constructor(storage) { this.storage = storage; this.db = storage.db; }

  /** @param {{ sessionId: string, prompt: string, everyMs: number, nextFireAt: string }} fields */
  insertSchedule({ sessionId, prompt, everyMs, nextFireAt }) {
    const id = newId("sch");
    const at = now();
    this.db.query("INSERT INTO schedules (id, session_id, prompt, every_ms, state, next_fire_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'active', ?5, ?6, ?6)")
      .run(id, sessionId, prompt, everyMs, nextFireAt, at);
    return this.getSchedule(id);
  }

  getSchedule(id) {
    return mapSchedule(this.db.query("SELECT * FROM schedules WHERE id = ?1").get(id));
  }

  /** What a client should see: live and paused wake-ups, not cancelled ones. @param {{ sessionId?: string | null }} [query] */
  listSchedules({ sessionId = null } = {}) {
    const rows = sessionId
      ? this.db.query("SELECT * FROM schedules WHERE session_id = ?1 AND state != 'cancelled' ORDER BY created_at").all(sessionId)
      : this.db.query("SELECT * FROM schedules WHERE state != 'cancelled' ORDER BY created_at").all();
    return rows.map(mapSchedule);
  }

  /** Active schedules whose slot has passed, oldest first. */
  dueSchedules(at) {
    return this.db.query("SELECT * FROM schedules WHERE state = 'active' AND next_fire_at <= ?1 ORDER BY next_fire_at").all(at).map(mapSchedule);
  }

  /** Earliest pending wake across active schedules — drives the scheduler's adaptive timer. */
  nextDueAt() {
    return this.db.query("SELECT MIN(next_fire_at) AS due FROM schedules WHERE state = 'active'").get()?.due ?? null;
  }

  countSchedules(/** @type {{ sessionId?: string | null, state?: string }} */ { sessionId = null, state = "active" } = {}) {
    return this.db.query("SELECT COUNT(*) AS n FROM schedules WHERE state = ?1 AND (?2 IS NULL OR session_id = ?2)").get(state, sessionId).n;
  }

  /** @param {string} id @param {string} state @param {{ error?: string | null }} [options] an error is written only when named */
  updateScheduleState(id, state, { error } = {}) {
    const sets = ["state = ?1", "updated_at = ?2"];
    const values = [state, now()];
    if (error !== undefined) { values.push(error); sets.push(`last_error = ?${values.length}`); }
    values.push(id);
    this.db.query(`UPDATE schedules SET ${sets.join(", ")} WHERE id = ?${values.length}`).run(...values);
    return this.getSchedule(id);
  }

  /** Reset the next slot without touching state or counts — a resume starts a fresh interval. */
  reschedule(id, nextFireAt) {
    this.db.query("UPDATE schedules SET next_fire_at = ?1, updated_at = ?2 WHERE id = ?3").run(nextFireAt, now(), id);
    return this.getSchedule(id);
  }

  /**
   * Move a due schedule to its next slot and record how the firing went. A run that started
   * counts and clears any earlier error; a skipped beat records why without counting.
   */
  advanceSchedule(/** @type {string} */ id, /** @type {{ nextFireAt: string, runId?: string | null, error?: string | null }} */ { nextFireAt, runId = null, error = null }) {
    if (runId) {
      this.db.query("UPDATE schedules SET fire_count = fire_count + 1, next_fire_at = ?1, last_run_id = ?2, last_error = NULL, updated_at = ?3 WHERE id = ?4").run(nextFireAt, runId, now(), id);
    } else {
      this.db.query("UPDATE schedules SET next_fire_at = ?1, last_error = ?2, updated_at = ?3 WHERE id = ?4").run(nextFireAt, error, now(), id);
    }
    return this.getSchedule(id);
  }
}
