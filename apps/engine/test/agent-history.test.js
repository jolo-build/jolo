import { expect, test } from "bun:test";
import { conversationHistory, hostedPrompt } from "../src/agents/history.js";
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Storage } from '../src/storage/index.js';

function fixture(entries) {
  const buffers = new Map(entries.map((entry, index) => [String(index), Buffer.from(entry.text)]));
  const messages = entries.map((entry, index) => ({ id: String(index), ordinal: index, artifactId: String(index), runId: "old", role: "assistant", kind: "text", committedBytes: buffers.get(String(index)).length, ...entry }));
  const reads = [];
  return { reads, storage: {
    listMessagesForSession: (_sessionId, { limit, afterOrdinal = -1, excludeRunId = null, handoffKind = null }) => {
      const eligible = messages.filter(row => row.ordinal > afterOrdinal && row.runId !== excludeRunId && (!handoffKind || row.kind !== 'reasoning' && row.committedBytes > 0 && (row.role === 'tool') === (handoffKind === 'tool')));
      return { messages: eligible.slice(-limit), hasOlder: eligible.length > limit };
    },
    getArtifact: (id) => ({ storageKey: id }),
    readArtifact(artifact, offset, length) { reads.push(length); return { buffer: buffers.get(artifact.storageKey).subarray(offset, offset + length) }; },
  } };
}

test("a fresh agent receives prior messages in order, without private reasoning or the current turn", () => {
  const { storage, reads } = fixture([
    { role: "user", text: "Keep changes in app.js" },
    { kind: "reasoning", text: "private thinking" },
    { role: "tool", kind: "tool", text: "tests passed" },
    { text: "Updated the app" },
    { role: "user", runId: "now", text: "continue" },
  ]);
  const run = { id: "now", sessionId: "chat", prompt: "continue" };
  const prompt = hostedPrompt(storage, run, false);
  expect(prompt).toContain('"role":"user","text":"Keep changes in app.js"');
  expect(prompt).toContain('"role":"tool","text":"tests passed"');
  expect(prompt).not.toContain("private thinking");
  expect(prompt.indexOf("Keep changes")).toBeLessThan(prompt.indexOf("Updated the app"));
  expect(prompt.split("continue")).toHaveLength(2);
  expect(prompt.endsWith("Current request:\ncontinue")).toBe(true);
  const before = reads.length;
  expect(hostedPrompt(storage, run, true)).toBe("continue");
  expect(reads).toHaveLength(before); // A native continuation already has its history.
});

test("handoff reads and output stay bounded, preserve Unicode, and identify omitted history", () => {
  const entries = Array.from({ length: 150 }, (_, i) => ({ text: `message ${i}: ${"🐈".repeat(4000)}` }));
  const { storage, reads } = fixture(entries);
  const history = conversationHistory(storage, "chat");
  expect(history).toContain("message 149:");
  expect(history).not.toContain("message 0:");
  expect(history).toContain("Earlier conversation omitted");
  expect(history).toContain("message truncated");
  expect(history).not.toContain("\uFFFD");
  expect(Buffer.byteLength(history)).toBeLessThan(49 * 1024);
  expect(reads.reduce((sum, length) => sum + length, 0)).toBeLessThanOrEqual(7 * 8 * 1024);
});

test('stored handoffs find a review beyond tool and reasoning pages without changing chat pagination', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'jolo-history-'));
  const storage = new Storage({ databasePath: path.join(root, 'db'), artifactsDir: path.join(root, 'artifacts'), bootId: 'test' });
  try {
    const project = storage.upsertProject({ identity: root, rootPath: root });
    const workspace = storage.ensureDirectWorkspace(project.id, root);
    const session = storage.createSession({ projectId: project.id, workspaceId: workspace.id, title: 'Review' });
    const run = storage.insertRun({ sessionId: session.id, requestId: 'review', prompt: 'review', execution: { agentId: 'claude' } });
    let ordinal = 0;
    const add = (role, kind, text, runId = run.id) => {
      const artifact = storage.createArtifact({ sessionId: session.id, kind: 'message' });
      const writer = storage.openArtifactWriter(artifact);
      writer.append(Buffer.from(text));
      const bytes = writer.close();
      storage.commitArtifactBytes(artifact.id, bytes);
      const message = storage.insertMessage({ sessionId: session.id, runId, role, kind, artifactId: artifact.id, ordinal: ordinal++ });
      storage.finishMessage(message.id, 'complete', bytes);
    };
    add('user', 'text', 'Imported objective', null);
    add('assistant', 'text', 'REVIEW: keep guard.go findings for the next agent.');
    for (let i = 0; i < 150; i++) {
      add('tool', 'tool', `OUTPUT_${i}: ${'x'.repeat(2000)}`);
      add('assistant', 'reasoning', 'Private thinking');
    }
    const current = storage.insertRun({ sessionId: session.id, requestId: 'now', prompt: 'fix the review' });
    add('user', 'text', 'CURRENT_REQUEST', current.id);
    const history = conversationHistory(storage, session.id, { excludeRunId: current.id });
    expect(history).toContain('REVIEW: keep guard.go findings');
    expect(history).toContain('"agent":"claude"');
    expect(history).toContain('Imported objective');
    expect(history).toContain('OUTPUT_149:');
    expect(history).not.toContain('Private thinking');
    expect(history).not.toContain('CURRENT_REQUEST');
    expect(conversationHistory(storage, session.id, { afterOrdinal: 1 })).not.toContain('REVIEW:');
    const page = storage.listMessagesForSession(session.id, { limit: 100 });
    expect(page.messages).toHaveLength(100);
    expect(page.hasOlder).toBe(true);
    expect(page.messages.some(message => message.kind === 'reasoning')).toBe(true);
  } finally { storage.close(); rmSync(root, { recursive: true, force: true }); }
});
