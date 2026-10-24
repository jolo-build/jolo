import { SessionProjection } from "@jolo/client/projection";
import { TERMINAL } from "@jolo/client/run-state";
import { dialogKind } from "@jolo/client/dialogs";
import { activityLine, newerActivity } from "@jolo/client/activity";
import { EXIT } from "./exit-codes.js";
import { dialogLines } from "./dialog-text.js";
const err = line => process.stderr.write(`${line}\n`);
const emit = (json, record) => { if (json) process.stdout.write(`${JSON.stringify(record)}\n`); };

/**
 * What a paused run tells the caller. `run.state` events and `run.snapshot` rows both carry
 * these, and both leave the reason out when the pause was the user's own doing.
 * @typedef {{ pauseReason?: string, permissionId?: string, revision?: number }} PauseDetails
 */

/**
 * The part of an engine connection this command uses. `onReconnect` belongs to the resumable
 * wrapper only, which is why the code tests for it before calling it.
 * @typedef {{
 *   call: (method: string, params?: any) => Promise<any>,
 *   subscribe: (params?: any, handlers?: any) => Promise<any>,
 *   onEvent: (handler: (event: any) => void) => any,
 *   onPreview: (handler: (preview: any) => void) => any,
 *   onActivity?: (handler: (activity: any) => void) => any,
 *   onClose: (handler: () => void) => any,
 *   onReconnect?: (handler: () => any) => any,
 * }} EngineClient
 */

/**
 * How to answer a dialog from the shell: this command cannot answer for the person (the engine takes a decision only
 * from an interactive client), so it names the `jolo dialog` command that does, as it names `jolo permission` for a
 * permission. A question too long for its event, or one that cannot be read, can only be dismissed.
 * @param {import("@jolo/client/dialogs").Dialog} dialog @param {string} runId
 */
export function dialogHint(dialog, runId) {
  const kind = dialogKind(dialog);
  const dismiss = `dismiss with: jolo dialog dismiss ${runId}`;
  if (kind === "question") return `answer with: jolo dialog answer ${runId} <choice>…   (an option's number, several as 1,2, or your own words; one per question) · ${dismiss}`;
  if (kind === "plan") return `approve with: jolo dialog approve ${runId} · send back with: jolo dialog dismiss ${runId} "<what should change>"`;
  if (kind === "other") return `allow with: jolo dialog approve ${runId} · ${dismiss}`;
  return dismiss;
}

/** The conversation's process activity now; null when it has no process, and on an engine without the method. */
const readActivity = (/** @type {EngineClient} */ client, /** @type {string} */ sessionId) => client.call("session.activity", { sessionId }).then((result) => result.activity ?? null).catch(() => null);

/**
 * Print a run as it happens and return the exit code it earned.
 *
 * `jolo run` starts the run itself and so passes `startRun`; `jolo attach` and `jolo resume`
 * join one that already exists and pass `run` instead. Exactly one of the two is given.
 *
 * @param {EngineClient} client
 * @param {{
 *   session: { id: string, [key: string]: any },
 *   cursor?: string,
 *   json?: boolean,
 *   startRun?: () => Promise<any>,
 *   run?: any,
 * }} options
 * @returns {Promise<number>} exit code
 */
export async function followRun(client, { session, cursor, json, startRun, run: existingRun }) {
  let run = existingRun ?? null;
  let finalState = null;
  /** @type {PauseDetails | null} */
  let pause = null;
  let cancelRequested = false;
  /** The conversation's process activity, the newest snapshot seen from any source; what it says of background work is told once per change. */
  /** @type {import("@jolo/client/activity").Activity | null} */
  let activity = null;
  let shownRunning = 0;
  const noteActivity = (/** @type {import("@jolo/client/activity").Activity} */ next) => {
    activity = newerActivity(activity, next);
    if (json) return;
    const line = activityLine(activity, { now: Date.now() });
    const running = line?.running ?? 0;
    if (running === shownRunning) return;
    shownRunning = running;
    err(line ? line.text : "background work ended");
  };
  const announceDialog = (/** @type {any} */ payload) => {
    const runId = run?.id ?? payload.runId;
    const kind = dialogKind(payload);
    if (json) { emit(json, { type: "dialog_required", runId, dialogId: payload.dialogId, tool: payload.tool, kind, answerArgv: ["jolo", "dialog", kind === "question" ? "answer" : "approve", runId], dismissArgv: ["jolo", "dialog", "dismiss", runId] }); return; }
    for (const line of dialogLines(payload)) err(line);
    err(dialogHint(payload, runId));
  };
  // Writers hand back whatever they hand back (`process.stdout.write` returns a boolean); the
  // chain exists only to keep the order, so the resolved value is never looked at.
  /** @type {Promise<unknown>} */
  let output = Promise.resolve();
  const print = fn => { output = output.then(fn).catch(error => err(`output error: ${error.message}`)); };
  const projection = new SessionProjection({
    retainText: false,
    readArtifact: (artifactId, offset, length) => client.call("artifact.read", { artifactId, offset, length }),
    onError: (/** @type {Error} */ error) => err(`output error: ${error.message}`),
    onText: ({ message, byteOffset, text }) => {
      if (!json && !(message.role === "assistant" && message.kind === "text")) return;
      print(() => json ? emit(json, { type: "preview", role: message.role, kind: message.kind, sessionId: session.id, runId: message.runId, messageId: message.id, byteOffset, text }) : process.stdout.write(text));
    },
  });
  if (existingRun?.messages) projection.seed({ messages: existingRun.messages });
  const done = new Promise((resolve) => {
    client.onEvent((event) => {
      // The process's activity belongs to the conversation, not to this run: it is followed whichever run it names.
      if (event.type === "session.activity") { if (event.sessionId === session.id) { emit(json, { type: "event", event }); noteActivity(event.payload); } return; }
      if (run && event.runId !== run.id) return;
      emit(json, { type: "event", event });
      projection.applyEvent(event);
      if (!json && event.type === "tool.started") err(`→ ${event.payload.preview}`);
      if (!json && event.type === "tool.completed" && event.payload.status !== "ok") err(`← ${event.payload.name}: ${event.payload.status}${event.payload.errorCode ? ` (${event.payload.errorCode})` : ""}`);
      if (!json && event.type === "provider.attempt" && event.payload.status === "retrying") err(`provider retry: ${event.payload.reason ?? ""}`);
      if (event.type === "permission.requested" && !json) err(`permission needed: ${event.payload.summary} (cwd ${event.payload.cwd}); approve with: jolo permission allow ${event.payload.permissionId}`);
      if (event.type === "dialog.requested") announceDialog(event.payload);
      if (event.type === "files.changed" && !json) for (const change of event.payload.changes) err(`✎ ${change.op} ${change.path}${change.newPath ? ` → ${change.newPath}` : ""}`);
      if (event.type === "run.verification" && !json) err(`verification: ${event.payload.status}`);
      if (event.type === "context.compacted" && !json) err(`context compacted: ${event.payload.summarizedItems} items summarized (${event.payload.reason})`);
      if (event.type === "run.state") {
        const { state } = event.payload;
        if (!json) err(`run ${run?.id ?? event.runId}: ${state}`);
        if (TERMINAL.has(state)) { finalState = state; resolve(); }
        if (state === "paused") { pause = event.payload; resolve(); }
      }
    });
    client.onPreview(preview => { if (!run || preview.runId === run.id) projection.applyPreview(preview); });
    client.onActivity?.((notification) => { if (notification.sessionId === session.id) noteActivity(notification.activity); });
    client.onClose(() => {
      if (client.onReconnect) { if (!json) err("engine connection lost; reconnecting…"); }
      else if (!finalState) { finalState = "interrupted"; resolve(); }
    });
    client.onReconnect?.(async () => {
      if (!run) return;
      try {
        const snapshot = await client.call("run.snapshot", { runId: run.id });
        projection.seed({ messages: snapshot.messages, runs: [snapshot.run], cursor: snapshot.cursor });
        for (const message of snapshot.messages) await projection.fill(message.id);
        if (TERMINAL.has(snapshot.run.state)) { finalState = snapshot.run.state; resolve(); }
        else if (snapshot.run.state === "paused") { pause = snapshot.run; resolve(); }
      } catch (error) { err(`could not restore run: ${error.message}`); finalState = "interrupted"; resolve(); }
    });
  });
  const onInterrupt = () => {
    if (cancelRequested || !run) return;
    cancelRequested = true;
    err("cancelling run…");
    client.call("run.cancel", { runId: run.id }).catch((error) => err(`cancel failed: ${error.message}`));
  };
  process.on("SIGINT", onInterrupt);
  try {
    await client.subscribe({ after: cursor ?? "0", sessionId: session.id });
    if (startRun) run = await startRun();
    // Joining late: the process may already run background work that no event in this stream will tell of.
    void readActivity(client, session.id).then((current) => { if (current) noteActivity(current); });
    for (const message of existingRun?.messages ?? []) if (message.committedBytes > 0) await projection.fill(message.id);
    await done;
    while (projection.pendingFills.size) await Promise.allSettled([...projection.pendingFills.values()]);
    await output;
  } finally {
    process.off("SIGINT", onInterrupt);
  }
  // The run is over, but the conversation's process may still run background work: say so, and how to stop it.
  const left = activityLine(newerActivity(activity, await readActivity(client, session.id)), { now: Date.now() });
  if (left) {
    emit(json, { type: "background_work", sessionId: session.id, running: left.running, stopArgv: ["jolo", "background", "stop", session.id] });
    if (!json) err(`${left.text} · stop with: jolo background stop ${session.id}`);
  }
  if (pause) {
    if (pause.pauseReason === "permission" && pause.permissionId) emit(json, { type: "permission_required", runId: run.id, permissionId: pause.permissionId, resumeArgv: ["jolo", "attach", run.id] });
    emit(json, { type: "run.paused", runId: run.id, runRevision: pause.revision, reason: pause.pauseReason ?? "user", ...(pause.permissionId ? { permissionId: pause.permissionId } : {}), resumeArgv: pause.pauseReason === "permission" ? ["jolo", "permission", "allow", pause.permissionId] : ["jolo", "resume", run.id] });
    if (!json) err(pause.pauseReason === "permission" ? `run paused for permission; approve with: jolo permission allow ${pause.permissionId}   (then: jolo attach ${run.id})` : `run paused (${pause.pauseReason ?? "user"}); resume with: jolo resume ${run.id}`);
    return pause.pauseReason === "permission" ? EXIT.pausedPermission : pause.pauseReason === "budget" ? EXIT.pausedBudget : EXIT.pausedOther;
  }
  const code = finalState === "completed" ? EXIT.completed : finalState === "cancelled" ? EXIT.cancelled : EXIT.failed;
  emit(json, { type: "result", runId: run.id, state: finalState, exitCode: code });
  if (!json && finalState !== "completed") err(`run ${finalState}`);
  return code;
}
