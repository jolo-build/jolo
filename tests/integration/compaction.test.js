import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { startEngine, tempHome, waitFor, removeHome } from "./helpers.js";

const engines = [];
const homes = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
  for (const dir of homes.splice(0)) removeHome(dir);
});

describe("context compaction", () => {
  test("summarizes older groups into a checkpoint when usage approaches the window and keeps the run going", async () => {
    const home = tempHome(); homes.push(home);
    const repo = path.join(home, "repo"); mkdirSync(path.join(repo, "src"), { recursive: true });
    writeFileSync(path.join(repo, "src", "big.txt"), Array.from({ length: 400 }, (_, i) => `line ${i} ${"x".repeat(60)}`).join("\n"));
    // Six reads of ~25 KB each (~6k tokens each) against a 30k window: compaction must trigger before the last turns.
    const script = [
      ...Array.from({ length: 6 }, () => ({ toolCalls: [{ name: "read_file", arguments: { path: "src/big.txt" } }] })),
      { text: ["All reads done.\n"] },
    ];
    const scriptPath = path.join(home, "script.json"); writeFileSync(scriptPath, JSON.stringify(script));
    const engine = await startEngine({ home, env: { JOLO_FAKE_SCRIPT: scriptPath } }); engines.push(engine);
    const client = await engine.connect();
    await client.call("settings.update", { provider: { name: "fake", model: "fake", contextWindowTokens: 30_000, maxOutputTokens: 2_000 } });
    const project = await client.call("project.open", { path: repo });
    const { session, cursor } = await client.call("session.create", { projectId: project.projectId, workspaceId: project.workspaceId, title: "compact" });
    const events = [];
    await client.subscribe({ after: cursor, sessionId: session.id }, { onEvent: (e) => events.push(e) });
    const { run } = await client.call("run.start", { sessionId: session.id, requestId: "req_c", prompt: "read the big file six times" });
    await waitFor(() => events.some((e) => e.type === "run.state" && ["completed", "failed", "paused"].includes(e.payload.state)), { label: "run finished", timeoutMs: 40_000 });
    const snapshot = await client.call("run.snapshot", { runId: run.id });
    expect(snapshot.run.state).toBe("completed");
    const compactions = events.filter((e) => e.type === "context.compacted").map((e) => e.payload);
    expect(compactions.length).toBeGreaterThanOrEqual(1);
    expect(compactions[0].summarizedItems).toBeGreaterThan(0);
    expect(compactions[0].estimatedTokensAfter).toBeLessThan(compactions[0].estimatedTokensBefore);
    expect(compactions[0].reason).toMatch(/window/);
    const reads = events.filter((e) => e.type === "tool.completed" && e.payload.name === "read_file");
    expect(reads).toHaveLength(6); // the script continued past the compaction with a stable turn index
    const assistant = snapshot.messages.filter((m) => m.role === "assistant" && m.kind === "text");
    expect((await client.call("artifact.read", { artifactId: assistant.at(-1).artifactId })).text).toBe("All reads done.\n");
    // The checkpoint summary is a stored artifact and the session's provider-facing transcript starts after it.
    const summary = await client.call("artifact.read", { artifactId: (await (async () => { const { messages } = await client.call("session.page", { sessionId: session.id }); return messages; })()).at(-1).artifactId });
    expect(summary.text.length).toBeGreaterThan(0);
  }, 60_000);
});
