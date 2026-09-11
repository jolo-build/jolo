import { describe, expect, test } from "bun:test";
import { buildHandoff, createSummarizer, describeAnswerer, goalOf, handoffPrompt, joloPrompt, planHandoff, renderHandoff, workLogOf, GOAL_MAX_BYTES, SUMMARY_MAX_BYTES } from "../src/agents/handoff.js";
import { recentHistory } from "../src/agents/history.js";
import { handoffParties } from '../src/agents/hosted.js';

/**
 * A storage double with the four things a handoff reads: messages in order, their artifacts, the runs with
 * their notes, and the files each run changed. Every read is counted so bounds can be asserted.
 */
function fixture({ messages = [], runs = [], changed = {} } = {}) {
  const buffers = new Map();
  const rows = messages.map((entry, index) => {
    const id = `m${index}`;
    buffers.set(id, Buffer.from(entry.text ?? ""));
    return { id, artifactId: id, runId: entry.runId ?? "old", role: entry.role ?? "assistant", kind: entry.kind ?? "text", ordinal: index, committedBytes: buffers.get(id).length, status: "complete" };
  });
  const reads = [];
  return {
    reads,
    storage: {
      listMessagesForSession: (_id, { limit, afterOrdinal = -1 }) => { const eligible = rows.filter(row => row.ordinal > afterOrdinal); return { messages: eligible.slice(-limit), hasOlder: eligible.length > limit }; },
      lastMessageOrdinal: (_id, runId = null) => rows.filter(row => !runId || row.runId === runId).at(-1)?.ordinal ?? -1,
      /** @param {any} _id @param {{ role?: string }} [filter] */
      firstMessageForSession: (_id, { role } = {}) => rows.find((row) => !role || row.role === role) ?? null,
      listRunsForSession: (_id, limit) => runs.slice(-limit),
      getRun: id => runs.find(run => run.id === id) ?? null,
      changedPathsForRun: (runId) => changed[runId] ?? [],
      getArtifact: (id) => ({ storageKey: id }),
      readArtifact(artifact, offset, length) { reads.push(length); return { buffer: buffers.get(artifact.storageKey).subarray(offset, offset + length) }; },
    },
  };
}

const codex = { id: "codex", displayName: "Codex", model: "gpt-5.3-codex" };
const claude = { id: "claude", displayName: "Claude Code", model: null };
const note = (summary, nextStep = "Review it.") => ({ summary, nextStep, outcome: "completed", writtenAt: "2026-09-09T00:00:00.000Z" });

describe("what a new answerer is told about a conversation it did not hold", () => {
  test("says who held it and who takes over, naming the model when one was chosen", () => {
    expect(describeAnswerer(codex)).toBe("Codex (gpt-5.3-codex)");
    expect(describeAnswerer(claude)).toBe("Claude Code");
    expect(describeAnswerer(null)).toBe("Jolo");
    const { storage } = fixture({ messages: [{ role: "user", text: "build the parser" }, { text: "Built it." }] });
    const rendered = renderHandoff(planHandoff(storage, { sessionId: "s", from: codex, to: claude }));
    expect(rendered.text.startsWith("Conversation handed from Codex (gpt-5.3-codex) to Claude Code.")).toBe(true);
  });

  test("when everything fits, the goal is not repeated: it is already the first recent message", () => {
    const { storage } = fixture({ messages: [{ role: "user", text: "build the parser" }, { text: "Built it." }] });
    const rendered = renderHandoff(planHandoff(storage, { sessionId: "s", from: codex, to: claude }));
    expect(rendered.goalPinned).toBe(false);
    expect(rendered.omittedMessages).toBe(0);
    expect(rendered.text).not.toContain("Goal —");
    expect(rendered.text.indexOf('"role":"user","text":"build the parser"')).toBeGreaterThan(0);
    expect(rendered.text).not.toContain("earlier messages are not shown");
  });

  test("when the transcript no longer fits, the goal is pinned verbatim and the gap is declared in numbers", () => {
    const filler = Array.from({ length: 60 }, (_, i) => ({ text: `step ${i}: ${"x".repeat(3_000)}` }));
    const { storage } = fixture({ messages: [{ role: "user", text: "make the tests pass on main" }, ...filler] });
    const rendered = renderHandoff(planHandoff(storage, { sessionId: "s", from: codex, to: claude }));
    expect(rendered.goalPinned).toBe(true);
    expect(rendered.text).toContain("Goal — the first request in this conversation, verbatim:\nmake the tests pass on main");
    expect(rendered.omittedMessages).toBeGreaterThan(0);
    expect(rendered.text).toContain(`${rendered.omittedMessages} earlier messages are not shown below and no summary of them could be written`);
    expect(rendered.text).toContain("step 59:"); // the newest survives
    expect(rendered.text).not.toContain('"text":"step 0:'); // the oldest did not, but the goal above it did
    // The goal sits above the work log and the recent messages, in that order.
    expect(rendered.text.indexOf("Goal —")).toBeLessThan(rendered.text.indexOf("Recent messages"));
  });

  test("a goal longer than its reserve is clamped and says so, rather than eating the rest of the package", () => {
    const { storage } = fixture({ messages: [{ role: "user", text: "g".repeat(GOAL_MAX_BYTES * 3) }, ...Array.from({ length: 40 }, () => ({ text: "y".repeat(4_000) }))] });
    const goal = goalOf(storage, "s");
    expect(Buffer.byteLength(goal)).toBeLessThanOrEqual(GOAL_MAX_BYTES + 32);
    expect(goal.endsWith("[goal truncated]")).toBe(true);
  });

  test("the work log comes from run notes and changed files, oldest first, and needs no model", () => {
    const runs = [
      { id: "r1", state: "completed", note: note("Wrote the parser.") },
      { id: "r2", state: "paused", note: note("Waiting for your approval: rm -rf build", "Approve or deny the request.") },
      { id: "r3", state: "completed", note: note("Tests pass.") },
      { id: "now", state: "queued", note: null },
    ];
    const { storage } = fixture({ messages: [{ role: "user", text: "go" }], runs, changed: { r1: ["src/parser.js", "tests/parser.test.js"], r3: ["src/parser.js"] } });
    const log = workLogOf(storage, "s", { excludeRunId: "now" });
    expect(log.runs).toBe(3);
    const lines = log.text.split("\n");
    expect(lines[0]).toBe("1. completed · Wrote the parser. · files: src/parser.js, tests/parser.test.js");
    expect(lines[1]).toContain("2. paused · Waiting for your approval: rm -rf build");
    expect(lines[1]).toContain("next: Approve or deny the request."); // an unfinished run keeps its next step
    expect(lines[2]).toBe("3. completed · Tests pass. · files: src/parser.js");
    const rendered = renderHandoff(planHandoff(storage, { sessionId: "s", excludeRunId: "now", from: codex, to: claude }));
    expect(rendered.workLogRuns).toBe(3);
    expect(rendered.text).toContain("Work so far, from Jolo's record of each run (oldest first):");
  });

  test("a summary of the omitted middle is asked for only when something was omitted, and is used when given", async () => {
    const asked = [];
    const summarize = async (source) => { asked.push(source); return "Handoff note: the parser was written; next, run the tests."; };
    const small = fixture({ messages: [{ role: "user", text: "build it" }, { text: "done" }] });
    const fits = await buildHandoff(small.storage, { sessionId: "s", from: codex, to: claude, summarize });
    expect(asked).toHaveLength(0);
    expect(fits.summarized).toBe(false);

    const filler = Array.from({ length: 60 }, (_, i) => ({ text: `step ${i}: ${"x".repeat(3_000)}` }));
    const big = fixture({ messages: [{ role: "user", text: "build it" }, ...filler] });
    const rendered = await buildHandoff(big.storage, { sessionId: "s", from: codex, to: claude, summarize });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("USER: build it"); // the summariser sees the omitted middle, oldest first
    expect(asked[0]).toContain("step 0:");
    expect(asked[0]).not.toContain("step 59:"); // and not the part the reader will see verbatim
    expect(rendered.summarized).toBe(true);
    expect(rendered.text).toContain(`Summary of the ${rendered.omittedMessages} earlier messages that are not shown below`);
    expect(rendered.text).toContain("Handoff note: the parser was written");
  });

  test("a summariser that fails or answers nothing leaves an honest gap, never a made-up note", async () => {
    const filler = Array.from({ length: 60 }, (_, i) => ({ text: `step ${i}: ${"x".repeat(3_000)}` }));
    const { storage } = fixture({ messages: [{ role: "user", text: "build it" }, ...filler] });
    const failed = await buildHandoff(storage, { sessionId: "s", from: codex, to: claude, summarize: async () => { throw new Error("no provider"); } });
    expect(failed.summarized).toBe(false);
    expect(failed.text).toContain("no summary of them could be written");
    const empty = await buildHandoff(storage, { sessionId: "s", from: codex, to: claude, summarize: async () => "   " });
    expect(empty.summarized).toBe(false);
    const long = await buildHandoff(storage, { sessionId: "s", from: codex, to: claude, summarize: async () => "s".repeat(SUMMARY_MAX_BYTES * 4) });
    expect(long.summarized).toBe(true);
    expect(Buffer.byteLength(long.text)).toBeLessThan(64 * 1024); // the summary respects its reserve
  });

  test("an unconfigured provider writes no note, so a fake one can never pose as a real handoff", async () => {
    const factory = { create: async (settings) => ({ configured: Boolean(settings), settings: settings ?? { model: "fake" }, provider: { capabilities: () => ({ maxOutputTokens: 4096 }), async *stream() { yield { type: "text_delta", text: "made up" }; yield { type: "finished" }; } } }) };
    const unconfigured = createSummarizer({ providerFactory: factory, settings: { get: () => ({ provider: null }) }, log: null, sessionId: "s", runId: "r" });
    expect(await unconfigured("anything")).toBeNull();
    const configured = createSummarizer({ providerFactory: factory, settings: { get: () => ({ provider: { name: "fake", model: "fake" } }) }, log: null, sessionId: "s", runId: "r" });
    expect(await configured("anything")).toBe("made up");
    expect(createSummarizer({ providerFactory: null })).toBeNull();
  });

  test("an agent continuing its own thread gets the request alone; one arriving gets the package first", async () => {
    const { storage } = fixture({ messages: [{ role: "user", text: "build it" }, { text: "done" }, { role: "user", runId: "now", text: "@claude review it" }] });
    const run = { id: "now", sessionId: "s", prompt: "@claude review it", execution: { agentId: "claude" } };
    const session = { agentState: { _jolo: { seen: { claude: 1, jolo: 1 } } } };
    expect(await handoffPrompt({ storage, run, session, resumed: true, from: codex, to: claude })).toBe("review it");
    // Older saved vendor threads have no delivery position. Give them context once.
    expect(await handoffPrompt({ storage, run, resumed: true, from: codex, to: claude })).toContain('"text":"done"');
    const arriving = await handoffPrompt({ storage, run, resumed: false, from: codex, to: claude });
    expect(arriving.startsWith("Conversation handed from Codex (gpt-5.3-codex) to Claude Code.")).toBe(true);
    expect(arriving.endsWith("Current request:\nreview it")).toBe(true);
    expect(arriving).not.toContain("@claude review it"); // the mention was addressed to Jolo, not the guest
    // Jolo called into a hosted conversation gets the same shape, without a model-written summary.
    const jolo = joloPrompt(storage, { ...run, execution: { agentId: "jolo" } }, { agentId: "codex" }, { from: codex });
    expect(jolo.startsWith("Conversation handed from Codex (gpt-5.3-codex) to Jolo.")).toBe(true);
    expect(joloPrompt(storage, { ...run, execution: null }, { ...session, agentId: null })).toBe("@claude review it"); // Nothing new since Jolo's own completed turn.
  });

  test("the recent layer reports what it kept and what it left out, in a number a reader can trust", () => {
    const { storage, reads } = fixture({ messages: Array.from({ length: 120 }, (_, i) => ({ text: `m${i} ${"🐈".repeat(2_000)}` })) });
    const recent = recentHistory(storage, "s", { budgetBytes: 20 * 1024 });
    expect(recent.keptCount).toBeGreaterThan(0);
    expect(recent.omittedCount).toBeGreaterThan(0);
    expect(recent.keptCount + recent.omittedCount).toBeGreaterThanOrEqual(100); // the page, plus the unknown beyond it
    expect(recent.text).toContain("m119 ");
    expect(recent.text).not.toContain("�");
    expect(reads.every((length) => length <= 8 * 1024)).toBe(true);
  });

  test('legacy vendor threads recover the latest guest and catch up, while current threads exclude already-seen history', async () => {
    const { storage } = fixture({
      runs: [{ id: 'guest', state: 'completed', execution: { agentId: 'claude', model: 'fable' }, note: note('Wrote docs/design.md.') }],
      messages: [
        { role: 'user', text: 'Old request already delivered to Codex.' },
        { text: 'Old reply already in the vendor thread.' },
        { runId: 'guest', text: 'Architecture: use a durable queue. Saved in docs/design.md.' },
        { runId: 'now', role: 'user', text: 'Implement that architecture.' },
      ],
    });
    const session = { id: 's', agentId: 'codex', agentState: { codex: { codexThreadId: 'old-thread' } } };
    const run = { id: 'now', sessionId: 's', prompt: 'Implement that architecture.' };
    const parties = handoffParties({ storage, run, session, manifest: codex, catalog: { get: id => ({ id, displayName: 'Claude Code' }) } });
    const legacy = await handoffPrompt({ storage, run, session, resumed: true, ...parties });
    expect(legacy).toContain('Claude Code (fable) to Codex');
    expect(legacy).toContain('docs/design.md');
    expect(legacy).toContain('"agent":"claude"');
    const current = await handoffPrompt({ storage, run, session: { ...session, agentState: { ...session.agentState, _jolo: { seen: { codex: 1 } } } }, resumed: true, ...parties });
    expect(current).toContain('docs/design.md');
    expect(current).not.toContain('Old request');
    expect(current).not.toContain('Old reply');
    expect(current).not.toContain('omitted');
  });
});
