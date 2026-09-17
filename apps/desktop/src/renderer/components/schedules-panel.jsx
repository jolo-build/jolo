import { useEffect, useState } from "react";
import { Icon } from "./icon.jsx";
import { everyLabel, untilLabel } from "../presentation.js";

// Heartbeats on the selected task: durable intervals that post the prompt back in as an
// ordinary run. Everything shown comes from the engine's schedule records, so a heartbeat
// set from chat, the terminal, or here reads the same.

const MARK = Object.freeze({
  active: { label: "Active", tone: "good" },
  paused: { label: "Paused", tone: "muted" },
});

const EVERY = [60_000, 300_000, 900_000, 1_800_000, 3_600_000, 14_400_000, 86_400_000, 604_800_000];

function ScheduleRow({ schedule, onCall }) {
  const mark = MARK[schedule.state] ?? { label: schedule.state, tone: "muted" };
  const meta = [`every ${everyLabel(schedule.everyMs)}`];
  if (schedule.state === "active") meta.push(`next ${untilLabel(schedule.nextFireAt)}`);
  if (schedule.fireCount) meta.push(`fired ${schedule.fireCount}×`);
  return (
    <li className="schedule-row" data-state={schedule.state}>
      <span className={`plan-mark ${mark.tone}`}>{mark.label}</span>
      <span className="schedule-prompt" title={schedule.prompt}>{schedule.prompt}</span>
      <span className="schedule-meta">{meta.join(" · ")}</span>
      <span className="schedule-actions">
        {schedule.state === "active" && <button onClick={() => onCall("schedule.pause")}>Pause</button>}
        {schedule.state === "paused" && <button onClick={() => onCall("schedule.resume")}>Resume</button>}
        <button onClick={() => onCall("schedule.cancel")}>Cancel</button>
      </span>
      {schedule.lastError && <span className="schedule-error" role="alert">{schedule.lastError}</span>}
    </li>
  );
}

/** A new heartbeat: what to post, and how often. */
function NewSchedule({ onCreate, onCancel }) {
  const [prompt, setPrompt] = useState("");
  const [everyMs, setEveryMs] = useState(900_000);
  const [busy, setBusy] = useState(false);
  const ready = prompt.trim().length > 0 && !busy;
  return (
    <form
      className="plan-new"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!ready) return;
        setBusy(true);
        try { await onCreate({ prompt: prompt.trim(), everyMs }); setPrompt(""); }
        finally { setBusy(false); }
      }}
    >
      <label>Check-in<input value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Check the board and course-correct" aria-label="Heartbeat prompt" /></label>
      <label>Every
        <select value={everyMs} onChange={(event) => setEveryMs(Number(event.target.value))} aria-label="Heartbeat interval">
          {EVERY.map((ms) => <option key={ms} value={ms}>{everyLabel(ms)}</option>)}
        </select>
      </label>
      <div className="plan-new-actions">
        <span className="grow" />
        <button type="button" onClick={onCancel}>Cancel</button>
        <button className="primary" type="submit" disabled={!ready}>Set heartbeat</button>
      </div>
    </form>
  );
}

export function SchedulesPanel({ sessionId, schedules, call, refresh }) {
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => { setWriting(false); setError(null); if (sessionId) void refresh(sessionId); }, [sessionId, refresh]);

  const onCall = async (method, schedule) => {
    setError(null);
    try { await call(method, { scheduleId: schedule.id }); await refresh(sessionId); }
    catch (failure) { setError(failure.message); }
  };
  const onCreate = async ({ prompt, everyMs }) => {
    setError(null);
    try { await call("schedule.create", { sessionId, prompt, everyMs }); setWriting(false); await refresh(sessionId); }
    catch (failure) { setError(failure.message); }
  };

  return (
    <div className="plan-pane">
      <div className="plan-pane-head">
        <span>Heartbeats</span>
        <span className="grow" />
        {sessionId && !writing && <button className="primary" onClick={() => setWriting(true)}><Icon name="plus" size={13} />New heartbeat</button>}
      </div>
      {error && <p className="plan-failure" role="alert">{error}</p>}
      {!sessionId && <p className="muted plan-empty">Open a task to give it a heartbeat. A heartbeat posts your check-in back into the task on an interval — it keeps firing while the app is closed. Archiving the task pauses it; restoring starts it again.</p>}
      {sessionId && writing && <NewSchedule onCreate={onCreate} onCancel={() => setWriting(false)} />}
      {sessionId && !writing && schedules.length === 0 && <p className="muted plan-empty">No heartbeats on this task. Set one here, or just ask in the chat — "check the delegated tasks every 15 minutes".</p>}
      <ul className="schedule-list">
        {schedules.map((schedule) => <ScheduleRow key={schedule.id} schedule={schedule} onCall={(method) => onCall(method, schedule)} />)}
      </ul>
    </div>
  );
}
