// Process tools: run_command and run_shell through the supervisor.
import { z } from "zod";
import { ProtocolError } from "@jolo/protocol";
import { resolveWorkspacePath, WorkspacePathError } from "./paths.js";

const OUTPUT_INLINE_BYTES = 48 * 1024;

function resolveCwd(ctx, cwd) {
  if (!cwd || cwd === ".") return ctx.workspace.root;
  try {
    const resolved = resolveWorkspacePath(ctx.workspace.root, cwd);
    if (!resolved.stat.isDirectory()) throw new ProtocolError("invalid_params", "cwd is not a directory");
    return resolved.absolute;
  } catch (error) {
    throw error instanceof WorkspacePathError ? new ProtocolError(error.code === "not_found" ? "not_found" : "permission_denied", error.message) : error;
  }
}

function summarize(result) {
  const output = result.tail ? `${result.head}\n[... ${result.omittedBytes} bytes omitted; full output in artifact ...]\n${result.tail}` : result.head;
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    terminated: result.killed,
    durationMs: result.durationMs,
    outputBytes: result.outputBytes,
    outputArtifactId: result.outputArtifactId,
    truncated: output.length > OUTPUT_INLINE_BYTES || Boolean(result.tail) || result.spoolTruncated,
    output: output.slice(0, OUTPUT_INLINE_BYTES),
  };
}

export const commandTools = [
  {
    name: "run_command",
    description: "Run an executable with arguments in the workspace (no shell parsing). Use for tests, builds, and linters. Output is bounded; the full output is stored as an artifact readable with read_output.",
    executionClass: "process",
    deadlineMs: 120_000,
    params: z.object({
      argv: z.array(z.string().min(1).max(4096)).min(1).max(64).describe("Executable followed by its arguments"),
      cwd: z.string().max(4096).optional().describe("Workspace-relative working directory"),
      timeoutMs: z.number().int().min(1_000).max(600_000).optional().describe("Deadline for this command"),
    }),
    permissionSummary: (args) => ({ argv: args.argv, cwd: args.cwd ?? ".", summary: args.argv.join(" ").slice(0, 500) }),
    async execute(ctx, args) {
      const cwd = resolveCwd(ctx, args.cwd);
      const result = await ctx.supervisor.run({ invocationId: ctx.invocationId, sessionId: ctx.sessionId, command: args.argv, cwd, timeoutMs: Math.min(args.timeoutMs ?? ctx.deadlineMs, ctx.deadlineMs), signal: ctx.signal, onOutput: ctx.onOutput });
      ctx.recordCheck({ argv: args.argv, exitCode: result.exitCode, signal: result.signal });
      return { argv: args.argv, cwd: args.cwd ?? ".", ...summarize(result) };
    },
  },
  {
    name: "run_shell",
    description: "Run a shell script with /bin/sh in the workspace. Broader approval class than run_command; prefer run_command when no shell features are needed.",
    executionClass: "process",
    deadlineMs: 120_000,
    params: z.object({
      script: z.string().min(1).max(64 * 1024),
      cwd: z.string().max(4096).optional(),
      timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
    }),
    permissionSummary: (args) => ({ script: args.script.slice(0, 4000), cwd: args.cwd ?? ".", summary: args.script.split("\n")[0].slice(0, 500) }),
    async execute(ctx, args) {
      const cwd = resolveCwd(ctx, args.cwd);
      const result = await ctx.supervisor.run({ invocationId: ctx.invocationId, sessionId: ctx.sessionId, command: ["/bin/sh", "-c", args.script], cwd, timeoutMs: Math.min(args.timeoutMs ?? ctx.deadlineMs, ctx.deadlineMs), signal: ctx.signal, onOutput: ctx.onOutput });
      ctx.recordCheck({ argv: ["/bin/sh", "-c", args.script.slice(0, 200)], exitCode: result.exitCode, signal: result.signal });
      return { cwd: args.cwd ?? ".", ...summarize(result) };
    },
  },
];
