import { SessionProjection } from "@jolo/client/projection";
import { requestId as createRequestId, TERMINAL } from "@jolo/client/run-state";
import { connectResumable } from "@jolo/client";
// Headless CLI. Interactive mode is a later milestone and is never imported here.
import { fileURLToPath } from "node:url";
import { resolvePaths, connectOrStart, tryConnect } from "@jolo/launcher";
import { compareSeq, DEMO_PROVIDER_SETTINGS, parseModelTarget, ModelRefSchema } from "@jolo/protocol";
import { findProject, renderBoardDetail, renderBoardTable } from "./board.js";
import { deleteSession, listSessions, restoreSession } from "./sessions.js";
import { runAccountCommand } from './account.js';
import { backgroundCheck, commandUpdate, pendingUpdate } from './update.js';

import { engineCommand as resolveEngineCommand } from "@jolo/launcher/executable";
import path from "node:path";

const BUILD = process.env.JOLO_BUILD ?? "dev";

const engineCommand = (extraArgs = []) => resolveEngineCommand({
  engineDir: path.dirname(fileURLToPath(import.meta.url)),
  sourceEntry: () => fileURLToPath(import.meta.resolve("@jolo/engine/main")), extraArgs,
});
import { EXIT } from "./exit-codes.js";
export { EXIT } from "./exit-codes.js";
import { followRun } from "./follow-run.js";

const USAGE = `usage:
  jolo [<dir>]                       interactive terminal client (needs a TTY)
  jolo run "<task>" [--json] [--path <dir>] [--agent claude] [--worktree [--branch <name>] [--base <ref>]]
  jolo attach <run-id> [--json]
  jolo cancel <run-id>
  jolo resume <run-id> [--json]
  jolo permission allow <permission-id> [--once | --project]
  jolo permission deny <permission-id>
  jolo revert <invocation-id> <path>
  jolo status [--json]
  jolo board [--json]                    every project: what needs you, what finished, what is running
  jolo board <project> [--json] [--seen] one project: where you left off (--seen clears "done since you looked")
  jolo session list [--json] [--path <dir>] [--all]
  jolo session restore <session-id> [--json]  reopen a saved chat (also restores an archive)
  jolo session delete <session-id> [--json]
  jolo agent list [--json]                which third-party agent CLIs this engine can host
  jolo agent ps [--json]                 hosted agents running now, and what they appear to be doing
  jolo agent models <id> [--json]        ask an agent which models it can run
  jolo agent config <id> [--model <name>] [--effort <level>] [--clear] [--json]
  jolo plan new "<goal>" --task "<title>: <brief>" [--task ...] [--agent <id>] [--model <name>] [--effort <level>] [--path <dir>] [--json]
  jolo plan list [--path <dir>] [--json]     plans in this project, and how far each has got
  jolo plan show <plan-id> [--json]          the tasks, who answers each, and what happened
  jolo plan start|pause|cancel <plan-id>
  jolo plan task assign <task-id> [--agent <id>] [--model <name>] [--effort <level>] [--clear]
  jolo plan task retry|skip <task-id>
  jolo worktree list [--path <dir>] [--json]
  jolo worktree add [--path <dir>] [--branch <name>] [--base <ref>] [--json]
  jolo worktree remove <branch|workspace-id> [--path <dir>] [--force]
  jolo provider show [--json]
  jolo provider list [--json]
  jolo provider set <preset> [--base-url <url>]
  jolo model list <preset> [--refresh] [--json]
  jolo model set <preset>/<model> [--effort <level>] [--context-window <tokens>] [--max-output <tokens>]
  jolo run --model <preset>/<model> <prompt>
  jolo provider set openai --model <name> --context-window <tokens> --max-output <tokens> [--base-url <url>] [--reasoning <effort>]
  jolo provider set fake                development mode only
  jolo auth set openai        (reads the API key from stdin, never from arguments)
  jolo auth status openai
  jolo login [--tasks] [--no-open] [--server <url>] [--device-name <name>] [--json]
  jolo logout [--json]                  sign out of your Jolo account on this profile
  jolo whoami [--json]                  show your Jolo account
  jolo engine serve | stop [--cancel]
  jolo update [<version>] [--check] [--json]   install the newest published release
`;

import { parseArgs } from "./args.js";

const out = (line) => process.stdout.write(`${line}\n`);
const err = (line) => process.stderr.write(`${line}\n`);

function emit(json, record) {
  if (json) out(JSON.stringify(record));
}

async function attachEngine(flags, { start = true, clientKind = 'headless' } = {}) {
  const paths = resolvePaths({ home: flags.home, profile: flags.profile });
  const options = { paths, clientKind, build: BUILD };
  if (!start) return { paths, client: await tryConnect(paths, options) };
  let started = false;
  const client = await connectResumable({ open: async () => {
    const result = await connectOrStart({ ...options, engineCommand: engineCommand(["--profile", paths.profile, ...(flags.home ? ["--home", flags.home] : [])]), env: flags.home ? { JOLO_HOME: flags.home } : {} });
    started = result.started;
    return result.client;
  } });
  if (started) err(`started engine for profile ${paths.profile}`);
  return { paths, client };
}

/**
 * Subscribe first, then start or attach, so transient previews are not missed (§11.4).
 * Gaps between rendered previews and committed bytes are filled from the artifact.
 * Returns the exit code.
 */
async function commandRun({ positional, flags }) {
  const prompt = positional.slice(1).join(" ").trim();
  if (!prompt) { err(USAGE); return EXIT.usage; }
  const json = flags.json === true;
  const { client } = await attachEngine(flags);
  try {
    if (flags.agent && flags.model) throw new Error('Choose --agent or --model for this run');
    const modelOverride = flags.model ? parseModelTarget(flags.model) : null;
    const project = await client.call("project.open", { path: flags.path ?? process.cwd() });
    if (!json && !flags.agent) {
      const { settings } = await client.call("settings.get", {});
      if (!settings.model && !settings.provider && !flags.model) err(settings.demoProviderEnabled ? "no provider configured; using the development demo provider (see `jolo provider set`)" : "no model provider configured; configure one with `jolo provider set` or choose an agent with --agent");
    }
    let workspaceId = project.workspaceId;
    if (flags.worktree) {
      const { workspace } = await client.call("workspace.create", { projectId: project.projectId, ...(flags.branch ? { branch: flags.branch } : {}), ...(flags.base ? { base: flags.base } : {}), title: prompt.slice(0, 80) });
      workspaceId = workspace.id;
      emit(json, { type: "workspace.created", workspace });
      if (!json) err(`worktree ${workspace.branch} at ${workspace.path}`);
    }
    // --agent hands the task to a hosted agent; Jolo relays the prompt and routes its permission requests here.
    const { session, cursor } = await client.call("session.create", { projectId: project.projectId, workspaceId, title: prompt.slice(0, 80), ...(flags.agent ? { agentId: flags.agent } : {}) });
    if (flags.agent && !json) err(`task answered by ${flags.agent}`);
    const requestId = createRequestId();
    return await followRun(client, {
      session, cursor, json,
      startRun: async () => {
        const { run } = await client.call("run.start", { sessionId: session.id, requestId, prompt, expectedSessionRevision: session.revision, ...(modelOverride ? { execution: { agentId: "jolo", preset: modelOverride.preset, model: modelOverride.model, effort: flags.effort ?? null } } : {}) });
        emit(json, { type: "run.started", runId: run.id, sessionId: session.id, requestId });
        return run;
      },
    });
  } finally {
    await client.close();
  }
}

async function commandAttach({ positional, flags }) {
  const runId = positional[1];
  if (!runId) { err(USAGE); return EXIT.usage; }
  const json = flags.json === true;
  const { client } = await attachEngine(flags, { start: false });
  if (!client) { err("engine is not running"); return EXIT.failed; }
  try {
    const { run, messages, cursor } = await client.call("run.snapshot", { runId });
    if (["completed", "failed", "cancelled", "interrupted"].includes(run.state)) {
      const projection = new SessionProjection({
        retainText: false,
        readArtifact: (artifactId, offset, length) => client.call("artifact.read", { artifactId, offset, length }),
        onText: ({ message, byteOffset, text }) => {
          if (json) emit(json, { type: "preview", sessionId: run.sessionId, runId: run.id, messageId: message.id, byteOffset, text, replayed: true });
          else process.stdout.write(text);
        },
      });
      projection.seed({ messages: messages.filter(message => message.role === "assistant" && message.kind === "text") });
      for (const message of projection.ordered()) await projection.fill(message.id);
      const code = run.state === "completed" ? EXIT.completed : run.state === "cancelled" ? EXIT.cancelled : EXIT.failed;
      emit(json, { type: "result", runId: run.id, state: run.state, exitCode: code });
      if (!json) err(`run ${run.state}`);
      return code;
    }
    return await followRun(client, { session: { id: run.sessionId }, cursor, json, run: { ...run, messages } });
  } finally {
    await client.close();
  }
}

async function commandPermission({ positional, flags }) {
  const [, action, permissionId] = positional;
  if (!["allow", "deny"].includes(action) || !permissionId) { err(USAGE); return EXIT.usage; }
  const paths = resolvePaths({ home: flags.home, profile: flags.profile });
  const client = await tryConnect(paths, { clientKind: "tui", build: BUILD }); // a human at a terminal is an interactive client
  if (!client) { err("engine is not running"); return EXIT.failed; }
  try {
    const decision = action === "deny" ? "deny" : flags.once ? "allow_once" : flags.project ? "allow_project" : "allow_run";
    const result = await client.call("permission.resolve", { permissionId, decision });
    out(flags.json ? JSON.stringify(result) : `${result.decision} for run ${result.runId}${action === "allow" ? " (the run resumes if it was paused)" : ""}`);
    return EXIT.completed;
  } finally {
    await client.close();
  }
}

async function commandRevert({ positional, flags }) {
  const [, invocationId, target] = positional;
  if (!invocationId || !target) { err(USAGE); return EXIT.usage; }
  const paths = resolvePaths({ home: flags.home, profile: flags.profile });
  const client = await tryConnect(paths, { clientKind: "tui", build: BUILD });
  if (!client) { err("engine is not running"); return EXIT.failed; }
  try {
    const result = await client.call("patch.revert", { invocationId, path: target });
    out(flags.json ? JSON.stringify(result) : result.changes.map((c) => `${c.op} ${c.path}${c.newPath ? ` → ${c.newPath}` : ""}`).join("\n"));
    return EXIT.completed;
  } finally {
    await client.close();
  }
}

async function commandResume({ positional, flags }) {
  const runId = positional[1];
  if (!runId) { err(USAGE); return EXIT.usage; }
  const json = flags.json === true;
  const { client } = await attachEngine(flags, { start: false });
  if (!client) { err("engine is not running"); return EXIT.failed; }
  try {
    const { run } = await client.call("run.resume", { runId });
    const { messages, cursor } = await client.call("run.snapshot", { runId });
    return await followRun(client, { session: { id: run.sessionId }, cursor, json, run: { ...run, messages } });
  } finally {
    await client.close();
  }
}

async function commandCancel({ positional, flags }) {
  const runId = positional[1];
  if (!runId) { err(USAGE); return EXIT.usage; }
  const { client } = await attachEngine(flags, { start: false });
  if (!client) { err("engine is not running"); return EXIT.failed; }
  try {
    const { run } = await client.call("run.cancel", { runId });
    out(flags.json ? JSON.stringify({ type: "run.state", runId: run.id, state: run.state, revision: run.revision }) : `run ${run.id}: ${run.state}`);
    return EXIT.completed;
  } finally {
    await client.close();
  }
}

async function commandStatus({ flags }) {
  const { paths, client } = await attachEngine(flags, { start: false });
  if (!client) {
    out(flags.json ? JSON.stringify({ engine: null, profile: paths.profile }) : `engine: not running (profile ${paths.profile})`);
    return EXIT.completed;
  }
  try {
    const status = await client.call("engine.status", {});
    out(flags.json ? JSON.stringify({ engine: status, profile: paths.profile }) : `engine: running pid ${status.pid} build ${status.build} agent ${status.agent} clients ${status.clients} active ${status.activeRuns} queued ${status.queuedRuns} up ${Math.round(status.uptimeMs / 1000)}s`);
    return EXIT.completed;
  } finally {
    await client.close();
  }
}

async function commandBoard({ positional, flags }) {
  const selector = positional[1];
  const json = flags.json === true;
  const { client } = await attachEngine(flags);
  try {
    const board = await client.call("board.list", {});
    if (!selector) {
      out(json ? JSON.stringify(board) : renderBoardTable(board.projects));
      return EXIT.completed;
    }
    const row = findProject(board.projects, selector);
    if (!row) { err(`no project matches "${selector}"${board.projects.length ? `; known: ${board.projects.map((r) => r.name).join(", ")}` : ""}`); return EXIT.failed; }
    if (flags.seen) await client.call("board.viewed", { workspaceId: row.workspace.id });
    out(json ? JSON.stringify({ project: row }) : renderBoardDetail(row));
    return EXIT.completed;
  } finally {
    await client.close();
  }
}

/** Hosted third-party agents (§4.3). Starting one needs a terminal, so the CLI reports rather than launches. */
async function commandAgent({ positional, flags }) {
  const sub = positional[1] ?? "list";
  if (!["list", "ps", "models", "config"].includes(sub)) { err(USAGE); return EXIT.usage; }
  const json = flags.json === true;
  const agentId = positional[2];
  if ((sub === "models" || sub === "config") && !agentId) { err(USAGE); return EXIT.usage; }
  // Asking an agent for its models starts it, which the engine treats as a user's own action (§4.3).
  const paths = resolvePaths({ home: flags.home, profile: flags.profile });
  const client = sub === "models"
    ? await tryConnect(paths, { clientKind: "tui", build: BUILD })
    : (await attachEngine(flags, { start: sub === "list" })).client;
  if (!client) { err("engine is not running"); return EXIT.failed; }
  try {
    if (sub === "list") {
      const { agents } = await client.call("agent.catalog", {});
      if (json) out(JSON.stringify({ agents }));
      else for (const agent of agents) out(`${agent.available ? "✓" : "·"} ${agent.id.padEnd(10)} ${agent.displayName.padEnd(16)} ${(agent.transport === "pty" ? "terminal" : "task").padEnd(9)} ${(agent.model ?? "-").padEnd(18)} ${agent.available ? agent.resolvedPath : `not installed (${agent.binary})`}`);
      if (!json && agents.every((agent) => !agent.available)) err("no agent CLIs found on the engine's PATH");
      return EXIT.completed;
    }
    if (sub === "models") {
      const report = await client.call("agent.models", { agentId });
      if (json) { out(JSON.stringify(report)); return EXIT.completed; }
      for (const model of report.models) out(`${model.isDefault ? "*" : " "} ${model.id.padEnd(24)} ${model.displayName}${model.efforts.length ? `  [${model.efforts.join(", ")}]` : ""}${model.description ? `  ${model.description}` : ""}`);
      if (report.note) err(report.note);
      return EXIT.completed;
    }
    if (sub === "config") {
      const patch = flags.clear === true ? null : {};
      if (patch) {
        if (flags.model !== undefined) patch.model = flags.model === "" ? null : String(flags.model);
        if (flags.effort !== undefined) patch.effort = flags.effort === "" ? null : String(flags.effort);
      }
      if (patch && !Object.keys(patch).length) { // nothing to change: report what this agent is set to
        const agent = (await client.call("agent.catalog", {})).agents.find((entry) => entry.id === agentId);
        if (!agent) { err(`no agent named ${agentId}`); return EXIT.failed; }
        out(json ? JSON.stringify({ agent }) : `${agent.displayName}: ${agent.model ?? "the agent's own default"}${agent.effort ? ` at ${agent.effort}` : ""}${agent.supportsModel ? "" : " (Jolo cannot set a model for this one)"}`);
        return EXIT.completed;
      }
      const { settings } = await client.call("settings.update", { agents: { [agentId]: patch } });
      const chosen = settings.agents[agentId] ?? { model: null, effort: null };
      out(json ? JSON.stringify({ agentId, ...chosen }) : `${agentId}: ${chosen.model ?? "the agent's own default"}${chosen.effort ? ` at ${chosen.effort}` : ""}`);
      return EXIT.completed;
    }
    const { agents } = await client.call("agent.list", {});
    if (json) { out(JSON.stringify({ agents })); return EXIT.completed; }
    if (!agents.length) { out("no hosted agents are running"); return EXIT.completed; }
    for (const agent of agents) out(`${agent.terminalId}  ${agent.displayName.padEnd(16)} ${agent.status.padEnd(11)} (${agent.statusSource}${agent.statusDetail ? `: ${agent.statusDetail}` : ""})`);
    return EXIT.completed;
  } finally {
    await client.close();
  }
}

async function commandWorktree({ positional, flags }) {
  const sub = positional[1];
  if (!["list", "add", "remove"].includes(sub)) { err(USAGE); return EXIT.usage; }
  const json = flags.json === true;
  const dir = flags.path ?? process.cwd();
  if (sub === "remove") {
    const selector = positional[2];
    if (!selector) { err(USAGE); return EXIT.usage; }
    const paths = resolvePaths({ home: flags.home, profile: flags.profile });
    const client = await tryConnect(paths, { clientKind: "tui", build: BUILD }); // removal is a user's decision (§9.1)
    if (!client) { err("engine is not running"); return EXIT.failed; }
    try {
      const project = await client.call("project.open", { path: dir });
      const { workspaces } = await client.call("workspace.list", { projectId: project.projectId });
      const target = workspaces.find((w) => w.mode === "worktree" && (w.id === selector || w.branch === selector));
      if (!target) { err(`no worktree matches "${selector}"; known: ${workspaces.filter((w) => w.mode === "worktree").map((w) => w.branch).join(", ") || "none"}`); return EXIT.failed; }
      const result = await client.call("workspace.remove", { workspaceId: target.id, force: flags.force === true });
      out(json ? JSON.stringify(result) : `removed worktree ${result.branch} (${result.path}); the branch stays`);
      return EXIT.completed;
    } finally {
      await client.close();
    }
  }
  const { client } = await attachEngine(flags);
  try {
    const project = await client.call("project.open", { path: dir });
    if (sub === "add") {
      const { workspace } = await client.call("workspace.create", { projectId: project.projectId, ...(flags.branch ? { branch: flags.branch } : {}), ...(flags.base ? { base: flags.base } : {}) });
      out(json ? JSON.stringify({ workspace }) : `${workspace.branch}  ${workspace.path}  (from ${workspace.baseCommit.slice(0, 10)})`);
      return EXIT.completed;
    }
    const { workspaces } = await client.call("workspace.list", { projectId: project.projectId });
    if (json) out(JSON.stringify({ workspaces }));
    else for (const w of workspaces) out(`${w.mode === "direct" ? "main    " : "worktree"}  ${(w.branch ?? "-").padEnd(28)}  ${String(w.sessionCount).padStart(2)} task${w.sessionCount === 1 ? " " : "s"}  ${w.present ? "" : "(missing) "}${w.path}`);
    return EXIT.completed;
  } finally {
    await client.close();
  }
}

/** "<title>: <brief>" as the user types it; a task with no colon is its own brief. */
function parseTask(text) {
  const at = String(text).indexOf(":");
  if (at <= 0) return { title: String(text).slice(0, 200).trim(), brief: String(text).trim() };
  return { title: String(text).slice(0, at).trim(), brief: String(text).slice(at + 1).trim() };
}

const PLAN_MARK = Object.freeze({ done: "done", running: "running", pending: "waiting", blocked: "needs you", failed: "failed", skipped: "skipped", cancelled: "cancelled" });

async function commandPlan({ positional, flags }) {
  const sub = positional[1];
  const json = flags.json === true;
  const dir = flags.path ?? process.cwd();
  // Who will answer a task: its own choice, else the plan's default, else Jolo's own loop (§6.6).
  const named = (task, plan) => {
    const policy = plan?.policy ?? {};
    const agentId = task.agentId ?? policy.agentId ?? null;
    const model = task.model ?? (task.agentId ? null : policy.model) ?? null;
    const effort = task.effort ?? (task.agentId ? null : policy.effort) ?? null;
    return [agentId ?? "jolo", model, effort].filter(Boolean).join(" · ");
  };

  if (sub === "task") {
    const action = positional[2];
    const taskId = positional[3];
    if (!["assign", "retry", "skip"].includes(action) || !taskId) { err(USAGE); return EXIT.usage; }
    const { client } = await attachEngine(flags);
    try {
      if (action === "assign") {
        const patch = flags.clear === true
          ? { agentId: null, model: null, effort: null }
          : {
            ...(flags.agent !== undefined ? { agentId: flags.agent === "jolo" ? null : String(flags.agent) } : {}),
            ...(flags.model !== undefined ? { model: String(flags.model) } : {}),
            ...(flags.effort !== undefined ? { effort: String(flags.effort) } : {}),
          };
        const { task } = await client.call("plan.task.update", { taskId, ...patch });
        const { plan } = await client.call("plan.get", { planId: task.planId });
        out(json ? JSON.stringify({ task }) : `${task.title} → ${named(task, plan)}`);
        return EXIT.completed;
      }
      const { task } = await client.call(action === "retry" ? "plan.task.retry" : "plan.task.skip", { taskId });
      out(json ? JSON.stringify({ task }) : `${task.title} is ${PLAN_MARK[task.state] ?? task.state}`);
      return EXIT.completed;
    } finally {
      await client.close();
    }
  }

  if (["start", "pause", "cancel"].includes(sub)) {
    const planId = positional[2];
    if (!planId) { err(USAGE); return EXIT.usage; }
    const { client } = await attachEngine(flags);
    try {
      const { plan } = await client.call(`plan.${sub}`, { planId });
      out(json ? JSON.stringify({ plan }) : `plan ${plan.id} is ${plan.state}${plan.failure ? `: ${plan.failure}` : ""}`);
      return EXIT.completed;
    } finally {
      await client.close();
    }
  }

  if (sub === "new") {
    const goal = positional[2];
    const tasks = (Array.isArray(flags.task) ? flags.task : flags.task === undefined ? [] : [flags.task]).map(parseTask);
    if (!goal || !tasks.length) { err(USAGE); return EXIT.usage; }
    const { client } = await attachEngine(flags);
    try {
      const project = await client.call("project.open", { path: dir });
      const policy = {
        ...(flags.agent !== undefined ? { agentId: flags.agent === "jolo" ? null : String(flags.agent) } : {}),
        ...(flags.model !== undefined ? { model: String(flags.model) } : {}),
        ...(flags.effort !== undefined ? { effort: String(flags.effort) } : {}),
      };
      const created = await client.call("plan.create", { projectId: project.projectId, goal, tasks, ...(Object.keys(policy).length ? { policy } : {}) });
      if (json) out(JSON.stringify(created));
      else {
        out(`${created.plan.id}  ${created.plan.goal}`);
        for (const task of created.tasks) out(`  ${String(task.position + 1).padStart(2)}. ${task.title}  (${named(task, created.plan)})`);
        out(`start it with: jolo plan start ${created.plan.id}`);
      }
      return EXIT.completed;
    } finally {
      await client.close();
    }
  }

  if (sub === "show") {
    const planId = positional[2];
    if (!planId) { err(USAGE); return EXIT.usage; }
    const { client } = await attachEngine(flags);
    try {
      const { plan, tasks, executions } = await client.call("plan.get", { planId });
      if (json) { out(JSON.stringify({ plan, tasks, executions })); return EXIT.completed; }
      out(`${plan.goal}  [${plan.state}]${plan.failure ? `  ${plan.failure}` : ""}`);
      for (const task of tasks) {
        const tries = executions.filter((execution) => execution.taskId === task.id).length;
        const mark = PLAN_MARK[task.state] ?? task.state;
        out(`  ${String(task.position + 1).padStart(2)}. ${task.title.padEnd(30)} ${mark.padEnd(10)} ${named(task, plan).padEnd(24)}${tries > 1 ? `${tries} tries  ` : ""}${task.summary ?? ""}`);
      }
      return EXIT.completed;
    } finally {
      await client.close();
    }
  }

  if (sub === undefined || sub === "list") {
    const { client } = await attachEngine(flags);
    try {
      const project = await client.call("project.open", { path: dir });
      const { plans } = await client.call("plan.list", { projectId: project.projectId });
      if (json) { out(JSON.stringify({ plans })); return EXIT.completed; }
      if (!plans.length) out("no plans in this project yet");
      for (const plan of plans) {
        const done = plan.counts.done ?? 0;
        const total = Object.values(plan.counts).reduce((sum, n) => sum + n, 0);
        out(`${plan.id}  ${String(plan.state).padEnd(9)} ${String(`${done}/${total}`).padEnd(7)} ${plan.goal.slice(0, 60)}`);
      }
      return EXIT.completed;
    } finally {
      await client.close();
    }
  }

  err(USAGE);
  return EXIT.usage;
}

async function commandSession({ positional, flags }) {
  const action = positional[1] ?? "list";
  const sessionId = positional[2];
  if (!["list", "restore", "delete"].includes(action) || positional.length > 3 || (action === "list" ? Boolean(sessionId) : !sessionId)) { err(USAGE); return EXIT.usage; }
  if (action === "restore" && !flags.json) return commandInteractive({ positional: [], flags: { ...flags, session: sessionId } });
  const { client } = await attachEngine(flags);
  try {
    if (action === "restore") { out(JSON.stringify({ session: await restoreSession(client, sessionId) })); return EXIT.completed; }
    if (action === "delete") {
      const { session } = await client.call("session.page", { sessionId });
      await deleteSession(client, session);
      out(flags.json ? JSON.stringify({ sessionId, deleted: true }) : `Deleted session ${sessionId}`);
      return EXIT.completed;
    }
    let projectId;
    if (flags.path) projectId = (await client.call("project.open", { path: flags.path })).projectId;
    const sessions = await listSessions(client, projectId, flags.all === true);
    if (flags.json) out(JSON.stringify({ sessions }));
    else for (const s of sessions) out(`${s.id}  ${s.state}  rev ${s.revision}  ${s.updatedAt}  ${s.title}`);
    return EXIT.completed;
  } finally {
    await client.close();
  }
}

function modelWithFlags(target, flags) {
  return ModelRefSchema.parse({ ...parseModelTarget(target), effort: flags.effort ?? flags.reasoning ?? null,
    contextWindowTokens: flags['context-window'] ? Number(flags['context-window']) : null,
    maxOutputTokens: flags['max-output'] ? Number(flags['max-output']) : null });
}

async function commandModel({ positional, flags }) {
  const { client } = await attachEngine(flags);
  try {
    if (positional[1] === 'list' && positional[2]) {
      const report = await client.call('provider.models', { preset: positional[2], refresh: flags.refresh === true });
      if (flags.json) out(JSON.stringify(report));
      else { for (const m of report.models) out(`${m.id}  ${m.displayName}  context ${m.contextWindowTokens ?? 'unknown'}  max-output ${m.maxOutputTokens ?? 'unknown'}`); if (report.note) err(report.note); }
    } else if (positional[1] === 'set' && positional[2]) {
      const model = modelWithFlags(positional[2], flags);
      const { settings } = await client.call('settings.update', { model });
      out(flags.json ? JSON.stringify(settings) : `default model ${model.preset}/${model.model} configured`);
    } else { err(USAGE); return EXIT.usage; }
    return EXIT.completed;
  } finally { await client.close(); }
}

async function commandProvider({ positional, flags }) {
  const sub = positional[1];
  const { client } = await attachEngine(flags);
  try {
    if (sub === 'list') {
      const report = await client.call('provider.presets', {});
      if (flags.json) out(JSON.stringify(report));
      else for (const p of report.presets) out(`${p.id}  ${p.displayName}  ${p.protocol}  ${p.available ? 'ready' : 'API key needed'}  ${p.baseUrl}`);
    } else if (sub === 'show') {
      const { settings } = await client.call('settings.get', {});
      out(flags.json ? JSON.stringify(settings) : settings.model ? `provider ${settings.model.preset} model ${settings.model.model}` : settings.demoProviderEnabled ? 'provider: none configured (development runs use the demo provider)' : 'provider: none configured; configure a model provider or select an installed coding agent');
    } else if (sub === 'set' && positional[2]) {
      const name = positional[2];
      if (name === 'fake') {
        await client.call('settings.update', { provider: DEMO_PROVIDER_SETTINGS });
        err('development demo provider configured');
      } else {
        const providers = { [name]: { baseUrl: flags['base-url'] ?? null } };
        const model = flags.model ? modelWithFlags(`${name}/${flags.model}`, flags) : null;
        const { settings } = await client.call('settings.update', { providers, ...(model ? { model } : {}) });
        out(flags.json ? JSON.stringify(settings) : model ? `provider ${name} model ${model.model} configured` : `provider ${name} endpoint configured; select a model with jolo model set ${name}/<model>`);
        if (model) err(`Use jolo model set ${name}/${model.model} next time; provider set --model is kept for compatibility.`);
      }
    } else { err(USAGE); return EXIT.usage; }
    return EXIT.completed;
  } finally { await client.close(); }
}

async function readSecretFromStdin() {
  if (process.stdin.isTTY) {
    process.stderr.write("API key (input hidden): ");
    process.stdin.setRawMode(true);
  }
  let value = "";
  for await (const chunk of process.stdin) {
    const text = chunk.toString("utf8");
    if (process.stdin.isTTY) {
      for (const ch of text) {
        if (ch === "\u0003") { process.stdin.setRawMode(false); process.stderr.write("\n"); return null; }
        if (ch === "\r" || ch === "\n") { process.stdin.setRawMode(false); process.stderr.write("\n"); return value.trim(); }
        if (ch === "\u007f") value = value.slice(0, -1);
        else value += ch;
      }
      continue;
    }
    value += text;
    if (value.includes("\n")) break;
  }
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  return value.trim();
}

async function commandAuth({ positional, flags }) {
  const sub = positional[1];
  const provider = positional[2];
  if (!["set", "status"].includes(sub) || !/^[a-z][a-z0-9-]{0,38}$/.test(provider ?? "")) { err(USAGE); return EXIT.usage; }
  const { client } = await attachEngine(flags);
  try {
    if (sub === "status") {
      const status = await client.call("credential.status", { provider });
      out(flags.json ? JSON.stringify(status) : `${provider}: ${status.available ? `available (${status.source})` : "not configured"}`);
      return EXIT.completed;
    }
    const value = await readSecretFromStdin();
    if (!value) { err("no key provided"); return EXIT.usage; }
    const result = await client.call("credential.set", { provider, value });
    err(`credential stored (${result.stored})${result.stored === "session" ? "; it is not saved and lasts only while this engine runs" : ""}`);
    return EXIT.completed;
  } finally {
    await client.close();
  }
}

async function commandAccount({ positional, flags }) {
  const command = positional[0];
  const { client } = await attachEngine(flags, { clientKind: command === 'whoami' ? 'headless' : 'tui' });
  try { return await runAccountCommand({ command, flags, client }); }
  finally { await client.close(); }
}

/** Interactive mode: the only place the Ink dependency graph is loaded (§4.4). */
async function commandInteractive({ positional, flags }) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) { err("interactive mode needs a terminal; use `jolo run` for headless use"); err(USAGE); return EXIT.usage; }
  const dir = positional[0] ?? flags.path ?? process.cwd();
  const paths = resolvePaths({ home: flags.home, profile: flags.profile });
  // Advisory only: show what the last check found and refresh it in the background, so opening
  // the client never waits on the network and never installs anything by itself.
  const update = pendingUpdate({ paths, build: BUILD });
  void backgroundCheck({ paths, build: BUILD });
  let started = false;
  const client = await connectResumable({
    open: async () => {
      const result = await connectOrStart({ paths, clientKind: "tui", build: BUILD, engineCommand: engineCommand(["--profile", paths.profile, ...(flags.home ? ["--home", flags.home] : [])]), env: flags.home ? { JOLO_HOME: flags.home } : {} });
      started = result.started;
      return result.client;
    },
  });
  if (started) err(`started engine for profile ${paths.profile}`);
  try {
    let selected = null;
    let projectPath = dir;
    if (flags.session) {
      selected = await restoreSession(client, flags.session);
      const { projects } = await client.call("board.list", {});
      const known = projects.find((row) => row.projectId === selected.projectId);
      if (!known) throw new Error("The saved session's project is unavailable.");
      projectPath = known.rootPath;
    }
    const project = await client.call("project.open", { path: projectPath });
    // Without an explicit restore, keep a fresh draft. The first prompt creates
    // its session, so simply opening the CLI never resumes or creates a chat.
    const status = await client.call("engine.status", {});
    await client.subscribe({ after: status.cursor });
    const { startTui } = await import("./tui/index.jsx");
    return await startTui({ client, project, session: selected, cursor: status.cursor, restored: Boolean(flags.session), update });
  } finally {
    await client.close();
  }
}

async function commandEngine({ positional, flags }) {
  const sub = positional[1];
  if (sub === "serve") {
    const { serve } = await import("@jolo/engine/main"); // bundled into the CLI; the same code the spawned engine runs
    return serve(["serve", ...(flags.profile ? ["--profile", flags.profile] : []), ...(flags.home ? ["--home", flags.home] : [])]);
  }
  if (sub === "stop") {
    const { client } = await attachEngine(flags, { start: false });
    if (!client) { err("engine is not running"); return EXIT.completed; }
    try {
      await client.call("engine.stop", { cancelActive: flags.cancel === true });
      err("engine stopping");
      return EXIT.completed;
    } finally {
      await client.close();
    }
  }
  err(USAGE);
  return EXIT.usage;
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && ["--version", "-v"].includes(argv[0])) { out(`jolo ${BUILD}`); return EXIT.completed; }
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) { out(USAGE); return EXIT.completed; }
  const parsed = parseArgs(argv);
  const command = parsed.positional[0];
  if (command === undefined || (command && !/^[a-z]+$/.test(command) && (command.startsWith("/") || command.startsWith(".") || command.startsWith("~")))) {
    try { return await commandInteractive(parsed); } catch (error) { err(`error: ${error?.message ?? error}`); return EXIT.failed; }
  }
  const commands = { login: commandAccount, logout: commandAccount, whoami: commandAccount, run: commandRun, attach: commandAttach, cancel: commandCancel, resume: commandResume, revert: commandRevert, permission: commandPermission, status: commandStatus, board: commandBoard, agent: commandAgent, worktree: commandWorktree, plan: commandPlan, session: commandSession, provider: commandProvider, model: commandModel, auth: commandAuth, engine: commandEngine, update: (parsed) => commandUpdate(parsed, { build: BUILD }) };
  if (!commands[command]) { err(USAGE); return EXIT.usage; }
  try {
    return await commands[command](parsed);
  } catch (error) {
    err(`error: ${error?.message ?? error}${error?.code ? ` (${error.code})` : ""}`);
    return error?.code === "invalid_params" ? EXIT.usage : EXIT.failed;
  }
}

if (import.meta.main) {
  main().then((code) => process.exit(code));
}
