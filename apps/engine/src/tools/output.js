// read_output: paged access to stored tool output artifacts.
import { z } from "zod";
import { ProtocolError } from "@jolo/protocol";

export const outputTools = [
  {
    name: "read_output",
    description: "Read a range of a stored output artifact (for example a truncated tool result or a full git diff) by artifact id.",
    executionClass: "read",
    deadlineMs: 10_000,
    params: z.object({
      artifactId: z.string().min(1).max(128).describe("Artifact id returned by another tool"),
      offset: z.number().int().nonnegative().default(0).describe("Byte offset to start from"),
      length: z.number().int().min(1).max(64 * 1024).default(64 * 1024).describe("Maximum bytes to return"),
    }),
    async execute(ctx, args) {
      const artifact = ctx.storage.getArtifact(args.artifactId);
      if (!artifact || artifact.sessionId !== ctx.sessionId) throw new ProtocolError("not_found", "unknown artifact for this session");
      const { buffer, eof } = ctx.storage.readArtifact(artifact, args.offset, args.length, artifact.committedBytes);
      return { artifactId: artifact.id, offset: args.offset, bytes: buffer.length, committedBytes: artifact.committedBytes, eof, text: buffer.toString("utf8") };
    },
  },
];
