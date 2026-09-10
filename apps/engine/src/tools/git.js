// Read-only Git tools with bounded output. Larger diffs become paged artifacts.
import { z } from "zod";
import { ProtocolError } from "@jolo/protocol";
import { resolveWorkspacePath, WorkspacePathError } from "./paths.js";

const OUTPUT_INLINE_BYTES = 64 * 1024;
const OUTPUT_ARTIFACT_BYTES = 8 * 1024 * 1024;

async function runGit(ctx, args) {
  if (!ctx.env.git) throw new ProtocolError("unavailable", "git is not available in the engine's environment profile");
  const proc = Bun.spawn([ctx.env.git, ...args], { cwd: ctx.workspace.root, stdout: "pipe", stderr: "pipe", env: { PATH: ctx.env.path, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" } });
  const onAbort = () => proc.kill();
  ctx.signal.addEventListener("abort", onAbort, { once: true });
  const chunks = [];
  let bytes = 0;
  let overflow = false;
  try {
    const reader = proc.stdout.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (bytes + value.length > OUTPUT_ARTIFACT_BYTES) { overflow = true; proc.kill(); break; }
      chunks.push(Buffer.from(value));
      bytes += value.length;
    }
  } finally {
    ctx.signal.removeEventListener("abort", onAbort);
  }
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (ctx.signal.aborted) throw new ProtocolError("interrupted", "git cancelled");
  return { stdout: Buffer.concat(chunks, bytes), stderr: stderr.slice(0, 2000), exitCode, overflow };
}

const notRepo = (stderr) => /not a git repository/i.test(stderr);

export const gitTools = [
  {
    name: "git_status",
    description: "Show the workspace's Git branch and changed files (porcelain v2). Bounded; reports when the list is truncated.",
    executionClass: "read",
    deadlineMs: 60_000,
    params: z.object({}),
    async execute(ctx) {
      const result = await runGit(ctx, ["status", "--porcelain=v2", "--branch", "--untracked-files=normal"]);
      if (result.exitCode !== 0) {
        if (notRepo(result.stderr)) throw new ProtocolError("unavailable", "the workspace is not a Git repository");
        throw new ProtocolError("internal", `git status failed: ${result.stderr}`);
      }
      const lines = result.stdout.toString("utf8").split("\n").filter(Boolean);
      const branch = {};
      const entries = [];
      for (const line of lines) {
        if (line.startsWith("# branch.")) { const [key, ...rest] = line.slice(9).split(" "); branch[key] = rest.join(" "); continue; }
        const parts = line.split(" ");
        if (line.startsWith("1 ") || line.startsWith("2 ")) entries.push({ status: parts[1], path: line.startsWith("2 ") ? parts.slice(9).join(" ").split("\t").at(-1) : parts.slice(8).join(" ") });
        else if (line.startsWith("u ")) entries.push({ status: "UU", path: parts.slice(10).join(" ") });
        else if (line.startsWith("? ")) entries.push({ status: "??", path: line.slice(2) });
        if (entries.length >= 500) break;
      }
      return { branch: branch.head ?? null, upstream: branch.upstream ?? null, entries, truncated: entries.length >= 500 || result.overflow };
    },
  },
  {
    name: "git_diff",
    description: "Show a unified diff of the workspace (working tree vs HEAD by default, or vs a base ref). The first 64 KiB is returned inline; the full diff is stored as an artifact readable with read_output.",
    executionClass: "read",
    deadlineMs: 60_000,
    params: z.object({
      base: z.string().max(200).optional().describe("Base revision to diff against; default is the index/HEAD working-tree diff"),
      paths: z.array(z.string().max(4096)).max(20).default([]).describe("Workspace-relative paths to limit the diff"),
    }),
    async execute(ctx, args) {
      if (args.base && (args.base.startsWith("-") || !/^[A-Za-z0-9_.\-\/~^@{}]+$/.test(args.base))) throw new ProtocolError("invalid_params", "invalid base revision");
      const paths = args.paths.map((p) => { try { return resolveWorkspacePath(ctx.workspace.root, p).relative; } catch (error) { throw error instanceof WorkspacePathError ? new ProtocolError("permission_denied", error.message) : error; } });
      const gitArgs = ["diff", "--no-color", "--no-ext-diff"];
      if (args.base) gitArgs.push(args.base);
      else gitArgs.push("HEAD");
      gitArgs.push("--", ...paths);
      let result = await runGit(ctx, gitArgs);
      if (result.exitCode !== 0 && !args.base && /bad revision|ambiguous argument 'HEAD'/i.test(result.stderr)) {
        result = await runGit(ctx, ["diff", "--no-color", "--no-ext-diff", "--", ...paths]); // repository without commits yet
      }
      if (result.exitCode !== 0) {
        if (notRepo(result.stderr)) throw new ProtocolError("unavailable", "the workspace is not a Git repository");
        throw new ProtocolError("internal", `git diff failed: ${result.stderr}`);
      }
      const full = result.stdout;
      let artifactId;
      if (full.length > OUTPUT_INLINE_BYTES) artifactId = ctx.storeArtifact("git-diff", full);
      return { base: args.base ?? "HEAD", bytes: full.length, truncated: full.length > OUTPUT_INLINE_BYTES || result.overflow, artifactId, diff: full.subarray(0, OUTPUT_INLINE_BYTES).toString("utf8") };
    },
  },
];
