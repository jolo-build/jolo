// Jolo's permission gate for Antigravity CLI (agy).
//
// agy's print mode cannot ask anyone for permission, but it runs a PreToolUse hook before every tool call, its
// subagents' calls included, and does what the hook decides. The gate is that hook: a directory of Jolo's, added to
// the run with --add-dir, whose .agents/hooks.json runs a small script for every call. The script hands the call to
// the adapter over a private Unix socket and prints the decision back to agy. A hook that fails, prints nothing
// usable, or times out makes agy block the call, so a broken gate refuses rather than allows.
//
// Every shape here was read from agy 1.3.5: its documented hook contract and live print-mode sessions.
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { displayPath } from "./hosted.js";

// The user may take a while to answer; Jolo's own budgets and cancellation end a run that waits too long.
const HOOK_TIMEOUT_S = 24 * 60 * 60;

/** The hook's side of the gate, embedded so source, bundled and compiled engines run the same code. */
export const GATE_SOURCE = `
import { connect } from "node:net";
const request = JSON.stringify(JSON.parse(await new Response(Bun.stdin.stream()).text()));
const socket = connect(process.argv[2]);
let reply = "";
socket.setEncoding("utf8");
socket.on("connect", () => socket.write(request + "\\n"));
socket.on("data", (chunk) => { reply += chunk; });
socket.on("end", () => { if (!reply.trim()) process.exit(1); process.stdout.write(reply); process.exit(0); });
socket.on("error", () => process.exit(1));
`;

const READ_TOOLS = new Set(["view_file", "list_dir", "grep_search", "find_by_name"]);
// sed_file is not among them: its expressions can read or write files other than its target.
const MUTATION_TOOLS = new Set(["write_to_file", "replace_file_content", "multi_replace_file_content", "notebook_edit"]);
// agy's own coordination. A subagent's tool calls pass through this gate too, so starting one in the parent's own
// workspace, messaging it or waiting on it decides nothing by itself. A subagent given a new workspace ("branch" or
// "share") is not: agy itself creates that workspace from the repository, so the user decides.
const COORDINATION_TOOLS = new Set(["invoke_subagent", "send_message", "command_status", "wait", "wait_5_seconds", "finish"]);
const inheritsWorkspace = (args) => (Array.isArray(args?.Subagents) ? args.Subagents : []).every((entry) => !entry?.Workspace || entry.Workspace === "inherit");
const PATH_ARGS = ["AbsolutePath", "TargetFile", "DirectoryPath", "SearchPath", "SearchDirectory"];

/**
 * What Jolo is asked to decide for one of agy's tool calls: a command by its command line, a file tool by every path
 * it names, and anything else, or a file tool whose path Jolo cannot find, as a decision for the user.
 * @param {string} name @param {any} args @param {string} workspacePath
 */
export function gateRequest(name, args, workspacePath) {
  if (typeof args?.CommandLine === "string") {
    return { toolClass: "process", targets: [], summary: `${name}: ${args.CommandLine}`, script: args.CommandLine, cwd: typeof args.Cwd === "string" && args.Cwd ? displayPath(workspacePath, args.Cwd) : "." };
  }
  const targets = PATH_ARGS.map((key) => args?.[key]).filter((value) => typeof value === "string" && value);
  if (targets.length && READ_TOOLS.has(name)) return { toolClass: "read", targets };
  if (targets.length && MUTATION_TOOLS.has(name)) return { toolClass: "mutation", targets };
  if (COORDINATION_TOOLS.has(name) && (name !== "invoke_subagent" || inheritsWorkspace(args))) return { toolClass: "read", targets: [] };
  const call = `${name} ${JSON.stringify(args ?? {})}`;
  return { toolClass: "process", targets: [], summary: call, script: call, cwd: "." };
}

const shellQuote = (value) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * Open a gate whose hook asks `answer` about every tool call, and return the directory to add to agy's run. The
 * directory sits outside every file grant, so agy's own file tools cannot rewrite the hook that guards them.
 * @param {{ answer: (request: any) => Promise<{ decision: string, reason?: string }> }} options
 * @returns {Promise<{ dir: string, close: () => void }>}
 */
export async function openGate({ answer }) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "jolo-gate-")));
  const socketPath = path.join(dir, "gate.sock");
  const script = path.join(dir, ".agents", "jolo-gate.mjs");
  mkdirSync(path.dirname(script));
  writeFileSync(script, GATE_SOURCE);
  const command = [process.execPath, script, socketPath].map(shellQuote).join(" ");
  writeFileSync(path.join(dir, ".agents", "hooks.json"), JSON.stringify({ "jolo-permissions": { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_S }] }] } }));
  const decide = async (line) => answer(JSON.parse(line));
  const server = createServer((socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      if (input.includes("\n")) return;
      input += chunk;
      if (input.includes("\n")) decide(input).then((reply) => socket.end(`${JSON.stringify(reply)}\n`), () => socket.destroy());
    });
    socket.on("error", () => {});
  });
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, () => resolve(null)); });
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return { dir, close() { server.close(); rmSync(dir, { recursive: true, force: true }); } };
}
