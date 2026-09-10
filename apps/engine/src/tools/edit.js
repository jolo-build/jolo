// Mutation tools: exact replacement and structured patches through one transaction.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { z } from "zod";
import { ProtocolError } from "@jolo/protocol";
import { applyPatchTransaction, EDITABLE_FILE_MAX_BYTES } from "../workspaces/patches.js";
import { resolveWorkspacePath, WorkspacePathError } from "./paths.js";

const hashBuffer = (buffer) => `sha256:${createHash("sha256").update(buffer).digest("hex")}`;

function countOccurrences(haystack, needle) {
  let count = 0;
  let index = 0;
  for (;;) {
    index = haystack.indexOf(needle, index);
    if (index === -1) return count;
    count += 1;
    index += needle.length;
  }
}

export const editTools = [
  {
    name: "replace_exact",
    description: "Replace an exact text occurrence in a workspace file. Requires the file's current hash from read_file. The old text must occur exactly once unless occurrences is given; no fuzzy matching or newline normalization is applied.",
    executionClass: "mutation",
    deadlineMs: 30_000,
    params: z.object({
      path: z.string().min(1).max(4096),
      expectedHash: z.string().min(8).max(80).describe("Whole-file hash returned by read_file"),
      oldText: z.string().min(1).max(1024 * 1024),
      newText: z.string().max(1024 * 1024),
      occurrences: z.number().int().min(1).max(10_000).optional().describe("Exact number of occurrences to replace when more than one is intended"),
    }),
    async execute(ctx, args) {
      let resolved;
      try { resolved = resolveWorkspacePath(ctx.workspace.root, args.path); } catch (error) { throw error instanceof WorkspacePathError ? new ProtocolError(error.code === "not_found" ? "not_found" : "permission_denied", error.message) : error; }
      const buffer = readFileSync(resolved.absolute);
      if (buffer.length > EDITABLE_FILE_MAX_BYTES) throw new ProtocolError("limit_exceeded", "file exceeds the editable limit");
      const currentHash = hashBuffer(buffer);
      if (currentHash !== args.expectedHash) throw new ProtocolError("conflict", "file changed since it was read; read it again", { currentHash });
      const text = buffer.toString("utf8");
      const count = countOccurrences(text, args.oldText);
      if (count === 0) throw new ProtocolError("conflict", "oldText was not found in the file", { occurrences: 0 });
      if (args.occurrences === undefined && count !== 1) throw new ProtocolError("conflict", `oldText occurs ${count} times; pass occurrences to replace all of them or make it unique`, { occurrences: count });
      if (args.occurrences !== undefined && count !== args.occurrences) throw new ProtocolError("conflict", `oldText occurs ${count} times, not ${args.occurrences}`, { occurrences: count });
      const content = text.split(args.oldText).join(args.newText);
      const { changes, diffArtifactId } = applyPatchTransaction({ storage: ctx.storage, workspace: ctx.workspace, sessionId: ctx.sessionId, invocationId: ctx.invocationId, patchesDir: ctx.patchesDir, operations: [{ op: "replace", path: resolved.relative, expectedHash: currentHash, content }] });
      ctx.reportChanges(changes, { diffArtifactId });
      return { path: resolved.relative, replacements: count, hash: changes[0].afterHash, bytes: Buffer.byteLength(content) };
    },
  },
  {
    name: "apply_patch",
    description: "Apply structured file operations atomically per path: create, replace (whole file), delete, or rename. Replace, delete, and rename require expectedHash from read_file. Returns the new hashes.",
    executionClass: "mutation",
    deadlineMs: 60_000,
    params: z.object({
      operations: z.array(z.object({
        op: z.enum(["create", "replace", "delete", "rename"]),
        path: z.string().min(1).max(4096),
        content: z.string().max(2 * 1024 * 1024).optional(),
        expectedHash: z.string().max(80).optional(),
        newPath: z.string().max(4096).optional(),
      })).min(1).max(20),
    }),
    async execute(ctx, args) {
      const { changes, manifestKey, diffArtifactId } = applyPatchTransaction({ storage: ctx.storage, workspace: ctx.workspace, sessionId: ctx.sessionId, invocationId: ctx.invocationId, patchesDir: ctx.patchesDir, operations: args.operations });
      ctx.reportChanges(changes, { diffArtifactId });
      return { changes, manifest: manifestKey };
    },
  },
];
