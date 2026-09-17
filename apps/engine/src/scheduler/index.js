// Schedules: a prompt posted into a session on an interval — the heartbeat a task asks for when
// it wants to check on delegated work and correct course without a person watching the clock.
//
// The shape is deliberately small, like plans. Wall-clock intervals, no cron. The next slot lives
// on the record, not in a timer, so a restart loses nothing. A due schedule fires once per wake and
// its next slot skips past every missed beat, so an engine that was asleep produces one check-in
// rather than a backlog of them. Each firing is an ordinary run: it asks permissions like any
// run, and lands on the board like any run.
//
// Two deliberate consequences. An active schedule keeps the engine resident — a heartbeat whose
// task would idle out is no heartbeat at all, so the hold lasts as long as the schedule does. And
// a beat due while the task is mid-turn is skipped, not queued: the point of a check-in is to look
// at work once it settles, and a queue of identical wake-ups is a backlog in disguise. A paused or
// permission-waiting run is not a turn in progress, so it never holds a beat back.
import { ProtocolError, SCHEDULE_LIMITS } from "@jolo/protocol";
import { newId } from "../storage/records.js";

const MAX_REARM_MS = 60_000; // self-heal bound; normally the timer lands exactly on the next slot
const ERROR_REARM_MS = 5_000; // a failed fire leaves its slot in the past; without a floor the pump tight-loops
const HEARTBEAT_PREFIX = "[scheduled check-in]";
export const PAUSED_TASK_ARCHIVED = "the task is archived";
export const PAUSED_WORKSPACE_GONE = "the task's workspace is gone";
export const CANCELLED_TASK_DELETED = "the task was deleted";
const SKIPPED_BUSY = "a check-in was already in progress";

/**
 * @param {{ storage: any, runs: any, lifetime: any, log: any, nowMs?: () => number }} deps
 * `nowMs` exists for tests; production takes the default.
 */
export function createScheduler({ storage, runs, lifetime, log, nowMs = () => Date.now() }) {
  let timer = null;
  /** A schedule is work the user asked for: while any is active the engine must not idle out. */
  let holding = false;

  const syncLifetime = () => {
    const active = storage.countSchedules({ state: "active" }) > 0;
    if (active && !holding) { holding = true; lifetime.workStarted(); }
    else if (!active && holding) { holding = false; lifetime.workFinished(); }
  };

  /** The timer lands on the next due slot; mutations re-arm it so a sooner wake is not missed. */
  const rearm = (floor = 0) => {
    if (timer === null) return;
    clearTimeout(timer);
    const due = storage.nextScheduleDueAt();
    const delay = due ? Math.max(floor, Math.min(MAX_REARM_MS, Date.parse(due) - nowMs())) : MAX_REARM_MS;
    timer = setTimeout(tick, delay);
    timer.unref?.();
  };

  const publish = (schedule) => {
    storage.appendEvent({ sessionId: schedule.sessionId, type: "schedule.updated", payload: { schedule } });
    return schedule;
  };

  /**
   * @param {string} scheduleId @param {{ sessionId?: string } | null} [scope] a scoped caller —
   * the credential a hosted agent holds, or a tool bound to its task — may only touch its own.
   */
  const requireSchedule = (scheduleId, scope = null) => {
    const schedule = storage.getSchedule(scheduleId);
    if (!schedule || (scope?.sessionId && schedule.sessionId !== scope.sessionId)) throw new ProtocolError("not_found", "unknown schedule for this task");
    return schedule;
  };

  /** The first slot after every missed beat: a due schedule fires once, never in a burst. */
  const nextSlot = (schedule, fromMs) => {
    const next = Date.parse(schedule.nextFireAt);
    const beats = Math.max(1, Math.floor((fromMs - next) / schedule.everyMs) + 1);
    return new Date(next + beats * schedule.everyMs).toISOString();
  };

  /** One firing attempt: start a run, skip a busy task, or say on the record why neither happened. */
  const fire = (schedule) => {
    let ok = true;
    try {
      storage.transaction(() => {
        const current = storage.getSchedule(schedule.id);
        if (!current || current.state !== "active") return;
        const session = storage.getSession(current.sessionId);
        // Nothing to wake: a deleted task ends the schedule, an archived one holds it until restored.
        if (!session) {
          publish(storage.updateScheduleState(current.id, "cancelled", { error: CANCELLED_TASK_DELETED }));
          return;
        }
        if (session.state === "archived") {
          publish(storage.updateScheduleState(current.id, "paused", { error: PAUSED_TASK_ARCHIVED }));
          return;
        }
        const workspace = storage.getWorkspace(session.workspaceId);
        if (!workspace || workspace.removedAt) {
          publish(storage.updateScheduleState(current.id, "paused", { error: PAUSED_WORKSPACE_GONE }));
          return;
        }
        const nextFireAt = nextSlot(current, nowMs());
        // A turn in progress has not been reviewed yet; another identical wake-up adds nothing.
        // A paused or permission-waiting run is settled work — the beat still fires.
        if (storage.sessionHasBusyRuns(session.id)) {
          publish(storage.advanceSchedule(current.id, { nextFireAt, error: SKIPPED_BUSY }));
          return;
        }
        try {
          const { run } = runs.start({ sessionId: current.sessionId, requestId: newId("sch"), prompt: `${HEARTBEAT_PREFIX}\n\n${current.prompt}` });
          const updated = storage.advanceSchedule(current.id, { nextFireAt, runId: run.id });
          storage.appendEvent({ sessionId: current.sessionId, runId: run.id, type: "schedule.fired", payload: { scheduleId: current.id, runId: run.id, fireCount: updated.fireCount } });
          publish(updated);
          log.info("schedule fired", { scheduleId: current.id, sessionId: current.sessionId, runId: run.id, fireCount: updated.fireCount });
        } catch (error) {
          publish(storage.advanceSchedule(current.id, { nextFireAt, error: String(error?.message ?? error).slice(0, 300) }));
          log.warn("a scheduled wake-up could not start a run", { scheduleId: current.id, error: String(error?.message ?? error) });
        }
      });
    } catch (error) {
      ok = false;
      // Best effort: push the slot forward so a healthy store does not refire the same beat.
      try { storage.advanceSchedule(schedule.id, { nextFireAt: nextSlot(schedule, nowMs()), error: String(error?.message ?? error).slice(0, 300) }); } catch { /* the store is still wedged */ }
      log.error("a scheduled wake-up failed", { scheduleId: schedule.id, error: String(error?.message ?? error) });
    } finally {
      syncLifetime();
    }
    return ok;
  };

  /** Fire every schedule whose slot has passed. Exposed for tests and for the boot catch-up. */
  const pump = () => {
    let due;
    try { due = storage.dueSchedules(new Date(nowMs()).toISOString()); }
    catch (error) { log.error("the scheduler could not read due schedules", { error: String(error?.message ?? error) }); return false; }
    let ok = true;
    for (const schedule of due) ok = fire(schedule) && ok;
    return ok;
  };

  const tick = () => {
    const ok = pump();
    rearm(ok ? 0 : ERROR_REARM_MS);
  };

  /** Re-evaluate a task's schedules after it is renamed, archived, restored, or deleted. */
  const reconcileSession = (sessionId) => {
    const session = storage.getSession(sessionId);
    storage.transaction(() => {
      for (const schedule of storage.listSchedules({ sessionId })) {
        if (!session) {
          if (schedule.state !== "cancelled") publish(storage.updateScheduleState(schedule.id, "cancelled", { error: CANCELLED_TASK_DELETED }));
        } else if (session.state === "archived" && schedule.state === "active") {
          publish(storage.updateScheduleState(schedule.id, "paused", { error: PAUSED_TASK_ARCHIVED }));
        } else if (session.state === "open" && schedule.state === "paused" && schedule.lastError === PAUSED_TASK_ARCHIVED) {
          // Held only because the task was archived — restoring the task restarts the heartbeat.
          storage.reschedule(schedule.id, new Date(nowMs() + schedule.everyMs).toISOString());
          publish(storage.updateScheduleState(schedule.id, "active", { error: null }));
        }
      }
    });
    syncLifetime();
    rearm();
  };

  return {
    start() {
      syncLifetime();
      pump(); // beats missed while the engine was down each produce exactly one check-in
      timer = setTimeout(tick, 0);
      timer.unref?.();
      rearm();
    },

    stop() {
      if (timer) { clearTimeout(timer); timer = null; }
      if (holding) { holding = false; lifetime.workFinished(); }
    },

    pump,

    reconcileSession,

    /** @param {{ sessionId: string, prompt: string, everyMs: number }} params */
    create({ sessionId, prompt, everyMs }) {
      const session = storage.getSession(sessionId);
      if (!session) throw new ProtocolError("not_found", "unknown task; schedules wake an existing task");
      if (session.state === "archived") throw new ProtocolError("conflict", "restore this task before scheduling a wake-up");
      if (storage.countSchedules({ sessionId, state: "active" }) >= SCHEDULE_LIMITS.maxActivePerSession) {
        throw new ProtocolError("limit_exceeded", `a task holds at most ${SCHEDULE_LIMITS.maxActivePerSession} active schedules`);
      }
      const schedule = storage.transaction(() => publish(storage.insertSchedule({
        sessionId, prompt, everyMs, nextFireAt: new Date(nowMs() + everyMs).toISOString(),
      })));
      syncLifetime();
      rearm();
      return { schedule };
    },

    /** @param {{ sessionId?: string | null }} [query] */
    list({ sessionId } = {}) {
      return { schedules: storage.listSchedules({ sessionId: sessionId ?? null }) };
    },

    /** @param {string} scheduleId @param {{ sessionId?: string } | null} [scope] */
    pause(scheduleId, scope = null) {
      const schedule = requireSchedule(scheduleId, scope);
      if (schedule.state === "cancelled") throw new ProtocolError("conflict", "this schedule is cancelled");
      const updated = schedule.state === "paused" ? schedule : storage.transaction(() => publish(storage.updateScheduleState(scheduleId, "paused")));
      syncLifetime();
      rearm();
      return { schedule: updated };
    },

    /** @param {string} scheduleId @param {{ sessionId?: string } | null} [scope] */
    resume(scheduleId, scope = null) {
      const schedule = requireSchedule(scheduleId, scope);
      if (schedule.state === "cancelled") throw new ProtocolError("conflict", "this schedule is cancelled");
      // Already active keeps its slot: a resume must not push the next wake out by an interval.
      if (schedule.state === "active") return { schedule };
      // The engine pauses schedules whose task cannot run; resume must not override that.
      const session = storage.getSession(schedule.sessionId);
      if (!session) throw new ProtocolError("conflict", CANCELLED_TASK_DELETED);
      if (session.state === "archived") throw new ProtocolError("conflict", `${PAUSED_TASK_ARCHIVED}; restore it to resume this schedule`);
      const workspace = storage.getWorkspace(session.workspaceId);
      if (!workspace || workspace.removedAt) throw new ProtocolError("conflict", PAUSED_WORKSPACE_GONE);
      const updated = storage.transaction(() => {
        storage.reschedule(scheduleId, new Date(nowMs() + schedule.everyMs).toISOString());
        return publish(storage.updateScheduleState(scheduleId, "active", { error: null }));
      });
      syncLifetime();
      rearm();
      return { schedule: updated };
    },

    /** @param {string} scheduleId @param {{ sessionId?: string } | null} [scope] */
    cancel(scheduleId, scope = null) {
      const schedule = requireSchedule(scheduleId, scope);
      const updated = schedule.state === "cancelled" ? schedule : storage.transaction(() => publish(storage.updateScheduleState(scheduleId, "cancelled")));
      syncLifetime();
      rearm();
      return { schedule: updated };
    },
  };
}
