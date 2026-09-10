// Per-file revert from recorded preimages: current-hash preconditions, never a
// blanket reset. The revert is itself a patch transaction with its own manifest, so it can be undone.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { ProtocolError } from "@jolo/protocol";
import { applyPatchTransaction } from "./patches.js";

const hashBuffer = (buffer) => `sha256:${createHash("sha256").update(buffer).digest("hex")}`;

function readArtifactText(storage, artifactId) {
  const artifact = storage.getArtifact(artifactId);
  if (!artifact) throw new ProtocolError("not_found", "preimage artifact is missing");
  const { buffer } = storage.readArtifact(artifact, 0, artifact.committedBytes, artifact.committedBytes);
  return buffer.toString("utf8");
}

export function revertPatchPath({ storage, invocationId, relative, patchesDir }) {
  const patch = storage.getPatch(invocationId);
  if (!patch || patch.status !== "applied") throw new ProtocolError("not_found", "no applied patch for that invocation");
  const invocation = storage.getInvocation(invocationId);
  const run = storage.getRun(invocation.runId);
  const session = storage.getSession(run.sessionId);
  const workspace = storage.getWorkspace(session.workspaceId);
  const manifest = JSON.parse(readFileSync(path.join(patchesDir, patch.manifestKey), "utf8"));
  const op = manifest.operations.find((o) => o.path === relative || o.newPath === relative);
  if (!op) throw new ProtocolError("not_found", "that path is not part of the patch");
  const absolute = (rel) => path.join(workspace.path, rel);
  const currentHash = (rel) => (existsSync(absolute(rel)) ? hashBuffer(readFileSync(absolute(rel))) : null);

  let operation;
  if (op.op === "replace") {
    if (currentHash(op.path) !== op.afterHash) throw new ProtocolError("conflict", "the file changed after the patch; revert manually", { currentHash: currentHash(op.path) });
    operation = { op: "replace", path: op.path, expectedHash: op.afterHash, content: readArtifactText(storage, op.preimageArtifactId) };
  } else if (op.op === "create") {
    if (currentHash(op.path) !== op.afterHash) throw new ProtocolError("conflict", "the created file changed after the patch; revert manually", { currentHash: currentHash(op.path) });
    operation = { op: "delete", path: op.path, expectedHash: op.afterHash };
  } else if (op.op === "delete") {
    if (existsSync(absolute(op.path))) throw new ProtocolError("conflict", "a file exists at that path again; revert manually");
    operation = { op: "create", path: op.path, content: readArtifactText(storage, op.preimageArtifactId) };
  } else if (op.op === "rename") {
    if (currentHash(op.newPath) !== op.afterHash || existsSync(absolute(op.path))) throw new ProtocolError("conflict", "the renamed file changed or the original path is occupied; revert manually");
    operation = { op: "rename", path: op.newPath, expectedHash: op.afterHash, newPath: op.path };
  } else {
    throw new ProtocolError("invalid_params", `unknown operation ${op.op}`);
  }

  const revert = storage.transaction(() => {
    const created = storage.insertInvocation({ runId: run.id, providerCallId: "user", name: "revert_patch", argumentDigest: `sha256:${createHash("sha256").update(JSON.stringify({ invocationId, relative })).digest("hex")}`, grantId: null });
    storage.appendEvent({ sessionId: session.id, runId: run.id, type: "tool.started", payload: { invocationId: created.id, callId: "user", name: "revert_patch", argumentDigest: "user", preview: `revert ${relative} from ${invocationId}` } });
    return created;
  });
  const startedAt = Date.now();
  try {
    const { changes } = applyPatchTransaction({ storage, workspace: { id: workspace.id, root: workspace.path }, sessionId: session.id, invocationId: revert.id, operations: [operation], patchesDir });
    storage.transaction(() => {
      storage.updateInvocation(revert.id, { state: "completed", exitData: { status: "ok", durationMs: Date.now() - startedAt } });
      storage.appendEvent({ sessionId: session.id, runId: run.id, type: "files.changed", payload: { invocationId: revert.id, tool: "revert_patch", changes } });
      storage.appendEvent({ sessionId: session.id, runId: run.id, type: "tool.completed", payload: { invocationId: revert.id, callId: "user", name: "revert_patch", status: "ok", durationMs: Date.now() - startedAt, resultBytes: 0, truncated: false } });
    });
    return { invocationId: revert.id, changes };
  } catch (error) {
    storage.transaction(() => {
      storage.updateInvocation(revert.id, { state: "failed", exitData: { status: "error", code: error?.code ?? "internal" } });
      storage.appendEvent({ sessionId: session.id, runId: run.id, type: "tool.completed", payload: { invocationId: revert.id, callId: "user", name: "revert_patch", status: "error", durationMs: Date.now() - startedAt, resultBytes: 0, truncated: false, errorCode: error?.code ?? "internal" } });
    });
    throw error;
  }
}
