// Patch transaction: validate, snapshot preimages, persist a manifest, stage
// temp files, recheck preconditions, replace atomically per path, fsync directories, record postimages.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { ProtocolError } from "@jolo/protocol";
import { resolveWorkspacePath, WorkspacePathError } from "../tools/paths.js";
import { patchDiff } from "./diff.js";

export const PATCH_INPUT_MAX_BYTES = 1024 * 1024;
export const EDITABLE_FILE_MAX_BYTES = 2 * 1024 * 1024;
const BINARY_PROBE_BYTES = 8192;

const hashBuffer = (buffer) => `sha256:${createHash("sha256").update(buffer).digest("hex")}`;

function pathError(error) {
  if (error instanceof WorkspacePathError) return new ProtocolError(error.code === "not_found" ? "not_found" : "permission_denied", error.message, { pathCode: error.code });
  return error;
}

function fsyncDirectory(dir) {
  try {
    const fd = openSync(dir, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch { /* some filesystems refuse directory fsync; the rename is still durable enough for v1 */ }
}

function writeManifest(file, manifest) {
  const temp = `${file}.tmp`;
  const fd = openSync(temp, "w", 0o600);
  try { writeFileSync(fd, JSON.stringify(manifest, null, 2)); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temp, file); fsyncDirectory(path.dirname(file));
}

function readCurrent(absolute) {
  const stat = statSync(absolute);
  if (!stat.isFile()) throw new ProtocolError("invalid_params", "path is not a regular file");
  if (stat.size > EDITABLE_FILE_MAX_BYTES) throw new ProtocolError("limit_exceeded", `file exceeds the ${EDITABLE_FILE_MAX_BYTES} byte editable limit; view it in ranges instead`);
  const buffer = readFileSync(absolute);
  if (buffer.subarray(0, BINARY_PROBE_BYTES).includes(0)) throw new ProtocolError("invalid_params", "binary files require a separate explicit operation");
  return { buffer, hash: hashBuffer(buffer), mode: stat.mode & 0o777 };
}

/**
 * @param {{ storage: any, workspace: { id: string, root: string }, sessionId: string, invocationId: string, operations: any[], patchesDir: string }} input
 * @returns {{ changes: any[], manifestKey: string, hashes: Record<string, any> }}
 */
export function applyPatchTransaction(input) {
  const { storage, workspace, sessionId, invocationId, operations, patchesDir } = input;
  if (!Array.isArray(operations) || operations.length === 0) throw new ProtocolError("invalid_params", "at least one operation is required");
  let inputBytes = 0;
  for (const op of operations) if (typeof op.content === "string") inputBytes += Buffer.byteLength(op.content, "utf8");
  if (inputBytes > PATCH_INPUT_MAX_BYTES) throw new ProtocolError("limit_exceeded", "patch input exceeds 1 MiB");

  // Phase 1: validate paths, existence, hashes; collect plans.
  const plans = [];
  const seen = new Set();
  for (const op of operations) {
    let resolved;
    try {
      resolved = resolveWorkspacePath(workspace.root, op.path, { mustExist: op.op !== "create" });
    } catch (error) {
      throw pathError(error);
    }
    if (seen.has(resolved.absolute)) throw new ProtocolError("invalid_params", `path appears twice in one patch: ${resolved.relative}`);
    seen.add(resolved.absolute);
    const plan = { op: op.op, path: resolved.relative, absolute: resolved.absolute, before: null, content: null, mode: 0o644 };
    if (op.op === "create") {
      if (existsSync(resolved.absolute)) throw new ProtocolError("conflict", `file already exists: ${resolved.relative}`);
      if (typeof op.content !== "string") throw new ProtocolError("invalid_params", "create requires content");
      if (Buffer.byteLength(op.content) > EDITABLE_FILE_MAX_BYTES) throw new ProtocolError("limit_exceeded", "new file exceeds the editable limit");
      plan.content = Buffer.from(op.content, "utf8");
    } else {
      const current = readCurrent(resolved.absolute);
      if (!op.expectedHash) throw new ProtocolError("invalid_params", `${op.op} requires expectedHash from a prior read`);
      if (op.expectedHash !== current.hash) throw new ProtocolError("conflict", `file changed since it was read: ${resolved.relative}`, { currentHash: current.hash });
      plan.before = current;
      plan.mode = current.mode;
      if (op.op === "replace") {
        if (typeof op.content !== "string") throw new ProtocolError("invalid_params", "replace requires content");
        if (Buffer.byteLength(op.content) > EDITABLE_FILE_MAX_BYTES) throw new ProtocolError("limit_exceeded", "replacement exceeds the editable limit");
        plan.content = Buffer.from(op.content, "utf8");
      } else if (op.op === "rename") {
        let target;
        try { target = resolveWorkspacePath(workspace.root, op.newPath ?? "", { mustExist: false }); } catch (error) { throw pathError(error); }
        if (existsSync(target.absolute)) throw new ProtocolError("conflict", `rename target exists: ${target.relative}`);
        if (seen.has(target.absolute)) throw new ProtocolError("invalid_params", "rename target collides with another operation");
        seen.add(target.absolute);
        plan.newPath = target.relative;
        plan.newAbsolute = target.absolute;
      } else if (op.op !== "delete") {
        throw new ProtocolError("invalid_params", `unknown operation ${op.op}`);
      }
    }
    plans.push(plan);
  }

  // Phase 2: preimages into artifacts (recoverable, pinned by the manifest).
  const manifestKey = `${invocationId}/manifest.json`;
  const manifestPath = path.join(patchesDir, manifestKey);
  let manifest;
  storage.transaction(() => {
  for (const plan of plans) {
    if (!plan.before) continue;
    const artifact = storage.createArtifact({ sessionId, kind: "preimage" });
    const writer = storage.openArtifactWriter(artifact);
    let committed;
    try { writer.append(plan.before.buffer); committed = writer.flush(); }
    finally { writer.close(); }
    storage.finalizeArtifact(artifact.id, committed, plan.before.hash);
    plan.preimageArtifactId = artifact.id;
  }

  // Phase 3: durable manifest before any filesystem mutation.
  manifest = { invocationId, workspaceId: workspace.id, status: "staged", operations: plans.map((p) => ({ op: p.op, path: p.path, newPath: p.newPath, beforeHash: p.before?.hash ?? null, afterHash: p.content ? hashBuffer(p.content) : p.op === "rename" ? p.before.hash : null, preimageArtifactId: p.preimageArtifactId ?? null })) };
  mkdirSync(path.dirname(manifestPath), { recursive: true, mode: 0o700 });
  writeManifest(manifestPath, manifest);
  storage.insertPatch({ invocationId, manifestKey, status: "staged", hashes: { before: Object.fromEntries(plans.filter((p) => p.before).map((p) => [p.path, p.before.hash])) } });

  });

  // Phase 4: stage replacement content in the same directory, flushed.
  const staged = [];
  try {
    for (const plan of plans) {
      if (!plan.content) continue;
      mkdirSync(path.dirname(plan.absolute), { recursive: true });
      const temp = `${plan.absolute}.jolo-${invocationId.slice(-8)}.tmp`;
      const fd = openSync(temp, "w", plan.mode);
      try {
        let offset = 0;
        while (offset < plan.content.length) offset += writeSync(fd, plan.content, offset, plan.content.length - offset);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      plan.temp = temp;
      staged.push(temp);
    }

    // Phase 5: recheck preconditions immediately before replacement.
    for (const plan of plans) {
      if (plan.op === "create") { if (existsSync(plan.absolute)) throw new ProtocolError("conflict", `file appeared while staging: ${plan.path}`); continue; }
      const current = readCurrent(plan.absolute);
      if (current.hash !== plan.before.hash) throw new ProtocolError("conflict", `file changed while staging: ${plan.path}`, { currentHash: current.hash });
    }

    // Phase 6: apply, tracking what has been done for rollback.
    const applied = [];
    try {
      for (const plan of plans) {
        if (plan.op === "create" || plan.op === "replace") { renameSync(plan.temp, plan.absolute); plan.temp = null; }
        else if (plan.op === "delete") unlinkSync(plan.absolute);
        else if (plan.op === "rename") { mkdirSync(path.dirname(plan.newAbsolute), { recursive: true }); renameSync(plan.absolute, plan.newAbsolute); }
        applied.push(plan);
      }
    } catch (error) {
      const failures = rollback(applied);
      storage.updatePatch(invocationId, { status: failures.length ? "aborted" : "rolled_back" });
      throw new ProtocolError("conflict", `patch failed midway; rolled back matching postimages${failures.length ? "; some paths need manual recovery" : ""}: ${error.message}`, { recoveryRequired: failures, manifestKey });
    }
  } catch (error) {
    for (const temp of staged) { try { unlinkSync(temp); } catch { /* already moved or gone */ } }
    if (storage.listPatchesForRun && !(error instanceof ProtocolError && /rolled back/.test(error.message))) storage.updatePatch(invocationId, { status: "aborted" });
    throw error;
  }

  let changes;
  try {
  // Phase 7: durability and postimages.
  const dirs = new Set(plans.flatMap((p) => [path.dirname(p.absolute), ...(p.newAbsolute ? [path.dirname(p.newAbsolute)] : [])]));
  for (const dir of dirs) fsyncDirectory(dir);
  changes = plans.map((plan) => {
    const target = plan.op === "rename" ? plan.newAbsolute : plan.absolute;
    const afterHash = plan.op === "delete" ? null : hashBuffer(readFileSync(target));
    return { path: plan.path, op: plan.op, ...(plan.newPath ? { newPath: plan.newPath } : {}), beforeHash: plan.before?.hash ?? null, afterHash };
  });
  manifest.status = "applied";
  manifest.operations = manifest.operations.map((op, i) => ({ ...op, afterHash: changes[i].afterHash }));
  writeManifest(manifestPath, manifest);
  storage.updatePatch(invocationId, { status: "applied", hashes: { before: Object.fromEntries(changes.map((c) => [c.path, c.beforeHash])), after: Object.fromEntries(changes.map((c) => [c.newPath ?? c.path, c.afterHash])) } });

  } catch (error) {
    const failures = rollback(plans);
    manifest.status = failures.length ? "aborted" : "rolled_back";
    manifest.recoveryRequired = failures;
    try { writeManifest(manifestPath, manifest); storage.updatePatch(invocationId, { status: manifest.status }); }
    catch (recordError) { failures.push({ path: manifestKey, error: `recovery record failed: ${recordError.message}` }); }
    throw new ProtocolError("conflict", "patch durability failed; matching postimages were rolled back", { manifestKey, recoveryRequired: failures, cause: String(error.message) });
  }

  // Phase 8: what this call changed, as a diff, so the transcript can show it without re-reading a tree
  // that has since moved on. A diff that cannot be produced is simply absent, never a wrong one.
  let diffArtifactId = null;
  try {
    const diff = patchDiff(plans.map((plan) => ({
      path: plan.path,
      newPath: plan.newPath ?? null,
      op: plan.op,
      before: plan.before?.buffer ?? null,
      after: plan.op === "delete" ? null : plan.content ?? plan.before?.buffer ?? null,
    })));
    if (diff.text) {
      const artifact = storage.createArtifact({ sessionId, kind: "diff" });
      const writer = storage.openArtifactWriter(artifact);
      const bytes = Buffer.from(diff.text, "utf8");
      let committed;
      try { writer.append(bytes); committed = writer.flush(); } finally { writer.close(); }
      storage.finalizeArtifact(artifact.id, committed, hashBuffer(bytes));
      diffArtifactId = artifact.id;
    }
  } catch { /* the change is applied and recorded; a missing preview is not worth failing it */ }
  return { changes, manifestKey, diffArtifactId };
}

/** Undo applied steps only where the current content still matches what the patch wrote (§9.3). */
function rollback(applied) {
  const failures = [];
  for (const plan of [...applied].reverse()) {
    try {
      if (plan.op === "create") {
        if (!existsSync(plan.absolute)) continue;
        if (hashBuffer(readFileSync(plan.absolute)) !== hashBuffer(plan.content)) throw new Error("file changed after patch; manual recovery required");
        unlinkSync(plan.absolute);
      } else if (plan.op === "replace") {
        if (!existsSync(plan.absolute) || hashBuffer(readFileSync(plan.absolute)) !== hashBuffer(plan.content)) throw new Error("file changed after patch; manual recovery required");
        writeFileSync(plan.absolute, plan.before.buffer, { mode: plan.mode });
      } else if (plan.op === "delete") {
        if (existsSync(plan.absolute)) throw new Error("deleted path was recreated; manual recovery required");
        writeFileSync(plan.absolute, plan.before.buffer, { mode: plan.mode });
      } else if (plan.op === "rename") {
        if (!existsSync(plan.newAbsolute) || existsSync(plan.absolute) || hashBuffer(readFileSync(plan.newAbsolute)) !== hashBuffer(plan.before.buffer)) throw new Error("renamed path changed; manual recovery required");
        renameSync(plan.newAbsolute, plan.absolute);
      }
    } catch (error) { failures.push({ path: plan.path, error: String(error.message) }); }
  }
  return failures;
}
