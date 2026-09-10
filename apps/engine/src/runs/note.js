// The "where was I" note: written once when a run stops, from durable records only (no model call).
// It is what the board row, `jolo board <project>`, and notifications read when the user comes back.

const SUMMARY_MAX = 600;
const NEXT_MAX = 400;
const clip = (text, max) => { const t = String(text ?? "").replace(/\s+/g, " ").trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };

/** First paragraph of the run's last assistant message, read from its committed artifact. */
function assistantTail(storage, runId) {
  const message = storage.listMessagesForRun(runId).filter((m) => m.role === "assistant" && m.kind === "text" && m.committedBytes > 0).at(-1);
  if (!message) return null;
  const artifact = storage.getArtifact(message.artifactId);
  if (!artifact) return null;
  try {
    const { buffer } = storage.readArtifact(artifact, 0, Math.min(artifact.committedBytes, 4096), artifact.committedBytes);
    const text = buffer.toString("utf8");
    const paragraph = text.split(/\n\s*\n/).map((p) => p.trim()).find((p) => p.length > 0 && !p.startsWith("```"));
    return paragraph ? paragraph.replace(/^#+\s*/, "") : null;
  } catch {
    return null;
  }
}

function afterCompletion(verification, changed) {
  const files = changed === 1 ? "the changed file" : `the ${changed} changed files`;
  if (changed === 0) return "Nothing was changed. Send the next instruction when ready.";
  if (verification?.status === "passed") return `Checks passed. Review ${files}, then commit or ask for follow-up changes.`;
  if (verification?.status === "failed") return `The last check failed. Review ${files} and ask for a fix, or run the checks yourself.`;
  if (verification?.status === "stale") return `Files changed after the last check. Rerun the checks before relying on ${files}.`;
  return `No checks ran. Review ${files} and run the tests before relying on them.`;
}

/**
 * @param {{ storage: any, run: any, state: string, pauseReason?: string | null, failure?: string | null, permissionId?: string | null }} input
 */
export function buildRunNote({ storage, run, state, pauseReason = null, failure = null, permissionId = null }) {
  const changed = storage.changedPathsForRun(run.id).length;
  const verification = run.verification;
  let summary;
  let nextStep;
  switch (state) {
    case "completed": {
      const tail = assistantTail(storage, run.id);
      summary = tail ? clip(tail, SUMMARY_MAX) : "Finished without a written summary.";
      nextStep = afterCompletion(verification, changed);
      break;
    }
    case "paused": {
      const pending = (permissionId && storage.getPermission(permissionId)) || storage.pendingPermissionForRun(run.id);
      if (pauseReason === "permission") {
        summary = `Waiting for your approval: ${pending?.request?.summary ?? "a command"}`;
        nextStep = "Approve or deny the request. The task continues on its own after an approval.";
      } else if (pauseReason === "budget") {
        summary = `Paused before finishing: ${failure ?? "the budget was reached"}.`;
        nextStep = "Resume the task to continue with a fresh budget, or narrow the request.";
      } else if (pauseReason === "user") {
        summary = `Stopped after you declined a step${failure ? ` (${failure})` : ""}.`;
        nextStep = "Resume the task with the step skipped, or send different instructions.";
      } else {
        summary = `Paused: ${failure ?? pauseReason ?? "waiting on a resource"}.`;
        nextStep = "Reopen what the task needs, then resume it.";
      }
      break;
    }
    case "failed":
      summary = `Failed: ${failure ?? "unknown error"}.`;
      nextStep = /provider|credential|auth|api key/i.test(failure ?? "") ? "Check the provider settings and credentials, then resume or retry." : "Fix the cause, then resume the task or send a new instruction.";
      break;
    case "cancelled":
      summary = changed ? `Stopped by you after changing ${changed} file${changed === 1 ? "" : "s"}.` : "Stopped by you before any file changed.";
      nextStep = changed ? "Review or revert the changes, then start a new instruction." : "Start a new instruction when ready.";
      break;
    case "interrupted":
      summary = `Interrupted: ${failure ?? "the engine stopped"}.`;
      nextStep = "Resume the task; it continues from its saved transcript.";
      break;
    default:
      summary = `Stopped in state ${state}.`;
      nextStep = "Open the task to see what happened.";
  }
  return { summary: clip(summary, SUMMARY_MAX), nextStep: clip(nextStep, NEXT_MAX), outcome: state, writtenAt: new Date().toISOString() };
}
