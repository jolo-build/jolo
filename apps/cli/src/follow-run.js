import { SessionProjection } from "@jolo/client/projection";
import { TERMINAL } from "@jolo/client/run-state";
import { EXIT } from "./exit-codes.js";
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
 *   onClose: (handler: () => void) => any,
 *   onReconnect?: (handler: () => any) => any,
 * }} EngineClient
 */

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
      if (run && event.runId !== run.id) return;
      emit(json, { type: "event", event });
      projection.applyEvent(event);
      if (!json && event.type === "tool.started") err(`→ ${event.payload.preview}`);
      if (!json && event.type === "tool.completed" && event.payload.status !== "ok") err(`← ${event.payload.name}: ${event.payload.status}${event.payload.errorCode ? ` (${event.payload.errorCode})` : ""}`);
      if (!json && event.type === "provider.attempt" && event.payload.status === "retrying") err(`provider retry: ${event.payload.reason ?? ""}`);
      if (event.type === "permission.requested" && !json) err(`permission needed: ${event.payload.summary} (cwd ${event.payload.cwd}); approve with: jolo permission allow ${event.payload.permissionId}`);
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
    for (const message of existingRun?.messages ?? []) if (message.committedBytes > 0) await projection.fill(message.id);
    await done;
    while (projection.pendingFills.size) await Promise.allSettled([...projection.pendingFills.values()]);
    await output;
  } finally {
    process.off("SIGINT", onInterrupt);
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
