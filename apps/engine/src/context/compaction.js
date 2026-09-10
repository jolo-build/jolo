// Compaction: at a complete model/tool boundary, summarize older groups into a
// structured checkpoint, persist it before activation, and continue with the checkpoint plus recent evidence.
import { collectSummary } from "../providers/retry.js";
import { buildRequest, estimateTokens, COMPACT_TARGET_RATIO } from "./builder.js";
import { newId } from "../storage/index.js";

const SUMMARY_MAX_BYTES = 16 * 1024;
const SUMMARY_INSTRUCTIONS = [
  "You are compacting the earlier part of a coding session into a checkpoint that will replace those messages.",
  "Write a structured summary with exactly these sections: Objective, Constraints, Decisions, Work completed, Unresolved questions, Verification evidence.",
  "Be specific: keep file paths, hashes you were given, command results, and anything a later step must not redo. Do not invent results.",
  "Reply with the summary only.",
].join("\n");

/**
 * Choose the oldest groups to summarize so the remaining recent groups fit COMPACT_TARGET_RATIO of the window.
 * Groups are never split; the newest group (the current request) is never summarized.
 */
export function selectForCompaction(items, capabilities, fixedTokens) {
  const usable = capabilities.contextWindowTokens - capabilities.maxOutputTokens - Math.max(4_000, Math.ceil(capabilities.contextWindowTokens * 0.02));
  const target = Math.max(0, Math.floor(usable * COMPACT_TARGET_RATIO) - fixedTokens);
  const groups = [];
  for (const item of items) {
    const last = groups.at(-1);
    if (last && last.groupId === item.groupId) last.items.push(item);
    else groups.push({ groupId: item.groupId, items: [item] });
  }
  const tokens = groups.map((g) => g.items.reduce((sum, item) => sum + estimateTokens(JSON.stringify(item.payload)) + 8, 0));
  let kept = 0;
  let cut = groups.length; // index of the first kept group
  for (let i = groups.length - 1; i >= 0; i -= 1) {
    if (i === groups.length - 1 || kept + tokens[i] <= target) { kept += tokens[i]; cut = i; }
    else break;
  }
  return { summarize: groups.slice(0, cut).flatMap((g) => g.items), keep: groups.slice(cut).flatMap((g) => g.items) };
}

function transcript(items) {
  return items.map((item) => {
    switch (item.kind) {
      case "user_message": return `USER: ${item.payload.text}`;
      case "assistant_message": return `ASSISTANT: ${item.payload.text}`;
      case "tool_call": return `TOOL CALL ${item.payload.name} ${JSON.stringify(item.payload.arguments)}`;
      case "tool_result": return `TOOL RESULT: ${String(item.payload.output).slice(0, 4_000)}`;
      case "system_note": return `NOTE: ${item.payload.text}`;
      default: return "";
    }
  }).filter(Boolean).join("\n");
}

/** The summary needs little thought, but a model that runs without reasoning must not be asked for any. */
export const compactionEffort = (effort) => (effort && !["none", "minimal", "low"].includes(effort) ? "low" : effort ?? undefined);

/**
 * Run one compaction turn. Returns the new checkpoint and the items that remain provider-facing.
 * @param {{ storage: any, provider: any, capabilities: any, session: any, run: any, items: any[], fixedTokens: number, signal: AbortSignal, reason: string, log: any, reasoningEffort?: string | null }} input
 */
export async function compact(input) {
  const { storage, provider, capabilities, session, run, items, signal, reason, log } = input;
  const { summarize, keep } = selectForCompaction(items, capabilities, input.fixedTokens);
  if (summarize.length === 0) return null;
  const previous = storage.latestCheckpoint(session.id);
  const previousSummary = previous ? readSummary(storage, previous) : null;
  const source = `${previousSummary ? `PREVIOUS CHECKPOINT:\n${previousSummary}\n\n` : ""}${transcript(summarize)}`.slice(0, 400_000);
  const request = {
    sessionId: session.id, runId: run.id, purpose: "compaction",
    instructions: SUMMARY_INSTRUCTIONS,
    items: [{ kind: "user_message", groupId: "compaction", payload: { text: source } }],
    tools: [], maxOutputTokens: Math.min(capabilities.maxOutputTokens, 4_096), reasoningEffort: compactionEffort(input.reasoningEffort),
  };
  const summary = await collectSummary(provider, request, signal, SUMMARY_MAX_BYTES);

  const before = items.reduce((sum, item) => sum + estimateTokens(JSON.stringify(item.payload)), 0);
  const checkpoint = storage.transaction(() => {
    const artifact = storage.createArtifact({ sessionId: session.id, kind: "checkpoint" });
    const writer = storage.openArtifactWriter(artifact);
    const bytes = Buffer.from(summary, "utf8");
    let committed;
    try { writer.append(bytes); committed = writer.flush(); }
    finally { writer.close(); }
    storage.finalizeArtifact(artifact.id, committed, null);
    const throughOrdinal = summarize.at(-1).ordinal;
    const created = storage.insertCheckpoint({ sessionId: session.id, throughOrdinal, summaryArtifactId: artifact.id, contextVersion: (previous?.contextVersion ?? 0) + 1 });
    // The checkpoint note is the first provider-facing item after the cut; older items stay on disk for review.
    storage.insertItem({ sessionId: session.id, runId: run.id, kind: "system_note", groupId: newId("grp"), payload: { text: `Checkpoint of earlier work in this session (older messages were compacted):\n${summary}`, checkpointId: created.id } });
    const after = keep.reduce((sum, item) => sum + estimateTokens(JSON.stringify(item.payload)), 0) + estimateTokens(summary);
    storage.appendEvent({ sessionId: session.id, runId: run.id, type: "context.compacted", payload: { checkpointId: created.id, throughOrdinal, summarizedItems: summarize.length, summaryBytes: committed, estimatedTokensBefore: before, estimatedTokensAfter: after, reason } });
    return created;
  });
  log.info("context compacted", { sessionId: session.id, checkpointId: checkpoint.id, summarizedItems: summarize.length });
  return checkpoint;
}

function readSummary(storage, checkpoint) {
  const artifact = storage.getArtifact(checkpoint.summaryArtifactId);
  if (!artifact) return null;
  return storage.readArtifact(artifact, 0, artifact.committedBytes, artifact.committedBytes).buffer.toString("utf8");
}

/** Provider-facing items: everything after the latest checkpoint (the note itself is the first item). */
export function providerItems(storage, sessionId) {
  const checkpoint = storage.latestCheckpoint(sessionId);
  return checkpoint ? storage.listItems(sessionId, { afterOrdinal: checkpoint.throughOrdinal }) : storage.listItems(sessionId);
}
