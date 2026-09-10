// Runtime schemas are the source of truth for the wire contract.
// Both Bun (engine/CLI) and Electron main validate with these; JSDoc only documents shapes.
import { z } from "zod";
import { PresetId, ModelRefSchema, ProviderOverridesSchema, ProviderEntrySchema, ProviderModelsSchema } from './models.js';
export * from './models.js';
import { IMAGE_LIMITS, IMAGE_MIME_TYPES } from './attachments.js';

export const PROTOCOL_VERSION = Object.freeze({ major: 1, minor: 1 });
export const SCHEMA_VERSION = 1;

/** Stable application error codes carried in JSON-RPC error.data.code (§11.3). */
export const ERROR_CODES = Object.freeze([
  "invalid_frame",
  "invalid_params",
  "unknown_method",
  "unauthenticated",
  "version_mismatch",
  "conflict",
  "permission_denied",
  "limit_exceeded",
  "unavailable",
  "interrupted",
  "resync_required",
  "not_found",
  "internal",
]);

import { RUN_STATES, TERMINAL_RUN_STATES } from "./run-state.js";
export { RUN_STATES, TERMINAL_RUN_STATES, WORKING_RUN_STATES } from "./run-state.js";
export const PAUSE_REASONS = Object.freeze(["permission", "budget", "browser_host_unavailable", "user"]);

export const LIMITS = Object.freeze({
  promptBytes: 64 * 1024,
  ...IMAGE_LIMITS,
  previewChunkBytes: 32 * 1024,
  artifactReadBytes: 64 * 1024,
  eventPageSize: 100,
  sessionPageSize: 50,
  maxClients: 4,
  maxControlClients: 1,
});

const Id = z.string().min(1).max(128);
const DecimalString = z.string().regex(/^\d{1,20}$/, "decimal string expected");
const IsoTimestamp = z.iso.datetime({ offset: true });
const Revision = z.number().int().nonnegative();

export const RunStateSchema = z.enum(RUN_STATES);
export const PauseReasonSchema = z.enum(PAUSE_REASONS);

/** Written once when a run stops (finished, paused, failed, interrupted): what happened and what to do next. */
/**
 * What a run cost. Tokens are what the model reported. contextUsed/contextWindow are how full the model's
 * window was, which only some agents report: null means Jolo does not know, never that the window is empty.
 */
export const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().default(0),
  cachedInputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().default(0),
  attempts: z.number().int().nonnegative().default(0),
  iterations: z.number().int().nonnegative().default(0),
  contextUsed: z.number().int().nonnegative().nullable().default(null),
  contextWindow: z.number().int().positive().nullable().default(null),
});

export const RunNoteSchema = z.object({
  summary: z.string().max(600),
  nextStep: z.string().max(400),
  outcome: z.string().max(40),
  writtenAt: IsoTimestamp,
});

/**
 * Who answers one run, and with what, when it is not the session's usual answerer or the agent's own default.
 * `agentId` is the catalog id of a guest agent, or "jolo" for Jolo's own loop (§6.5, §6.6).
 */
export const RunExecutionSchema = z.object({
  preset: PresetId.nullable().optional(),
  agentId: Id.nullable().default(null),
  model: z.string().max(200).nullable().default(null),
  effort: z.string().max(40).nullable().default(null),
});

export const ImageMimeSchema = z.enum(IMAGE_MIME_TYPES);
export const ImageAttachmentSchema = z.object({
  artifactId: Id,
  name: z.string().min(1).max(200),
  mimeType: ImageMimeSchema,
  bytes: z.number().int().min(1).max(LIMITS.imageAttachmentBytes),
});
const ImageAttachmentsSchema = z.array(ImageAttachmentSchema).max(LIMITS.imageAttachments);

export const WebTaskSummarySchema = z.object({
  key: z.string().regex(/^JOLO-[1-9][0-9]{0,14}$/), title: z.string().min(1).max(200),
  project: z.string().max(100), state: z.enum(['todo','in_progress','in_review','done','canceled']),
  priority: z.enum(['low','normal','high','urgent']), revision: Revision,
  labels: z.array(z.object({id: Id, name: z.string().max(40), color: z.enum(['gray','blue','green','yellow','red','purple'])})).max(8),
  team: z.object({id: Id,name:z.string().max(100)}).nullable(), assigneeId: Id.nullable(),
  archivedAt: IsoTimestamp.nullable(), createdAt: IsoTimestamp, updatedAt: IsoTimestamp,
});
export const WebTaskSchema = WebTaskSummarySchema.extend({description: z.string().max(8192)});
export const TaskReferenceSummarySchema = WebTaskSummarySchema.extend({url:z.string().url().max(2048),origin:z.string().url().max(2048),accountId:Id});

export const RunSchema = z.object({
  id: Id,
  sessionId: Id,
  requestId: Id,
  attempt: z.number().int().positive(),
  state: RunStateSchema,
  revision: Revision,
  prompt: z.string(),
  attachments: ImageAttachmentsSchema.optional(),
  taskReferences: z.array(TaskReferenceSummarySchema).max(4).optional(),
  pauseReason: PauseReasonSchema.nullable(),
  failure: z.string().nullable(),
  verification: z.record(z.string(), z.unknown()).nullable().optional(),
  usage: UsageSchema.partial().optional(),
  note: RunNoteSchema.nullable().optional(),
  execution: RunExecutionSchema.nullable().optional(),
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
});

export const SessionSchema = z.object({
  model: ModelRefSchema.nullable().default(null),
  id: Id,
  projectId: Id,
  workspaceId: Id,
  title: z.string().max(200),
  revision: Revision,
  state: z.enum(["open", "archived"]),
  /** Set when a hosted third-party agent answers in this session instead of Jolo's own loop (§4.3). */
  agentId: Id.nullable().default(null),
  /** Set when this session was opened to carry out one task of a plan (§6.6). */
  planTaskId: Id.nullable().default(null),
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
});

export const WorkspaceSchema = z.object({
  id: Id,
  projectId: Id,
  mode: z.enum(["direct", "worktree"]),
  path: z.string(),
  branch: z.string().nullable(),
  baseCommit: z.string().nullable(),
  owned: z.boolean(),
  lastViewedAt: IsoTimestamp.nullable(),
  removedAt: IsoTimestamp.nullable(),
  createdAt: IsoTimestamp,
});

export const MessageSchema = z.object({
  id: Id,
  sessionId: Id,
  runId: Id.nullable(),
  ordinal: z.number().int().nonnegative(),
  role: z.enum(["user", "assistant", "system", "tool"]),
  kind: z.enum(["text", "reasoning", "tool"]).default("text"),
  artifactId: Id,
  committedBytes: z.number().int().nonnegative(),
  status: z.enum(["streaming", "complete", "interrupted"]),
});

// ---- JSON-RPC envelopes -------------------------------------------------------------------

const RequestId = z.string().min(1).max(64);

export const RequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: RequestId,
  method: z.string().min(1).max(64),
  params: z.record(z.string(), z.unknown()).optional(),
});

export const RpcErrorSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.object({ code: z.enum(ERROR_CODES), details: z.record(z.string(), z.unknown()).optional() }).optional(),
});

export const ResponseSchema = z.union([
  z.object({ jsonrpc: z.literal("2.0"), id: RequestId, result: z.unknown() }),
  z.object({ jsonrpc: z.literal("2.0"), id: RequestId, error: RpcErrorSchema }),
]);

export const NotificationSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.enum(["event", "preview", "browser.execute", "browser.open", "browser.cancel", "terminal.output", "terminal.state"]),
  params: z.record(z.string(), z.unknown()),
});

export const EnvelopeSchema = z.union([RequestSchema, ResponseSchema, NotificationSchema]);

// ---- Notifications -------------------------------------------------------------------------

export const EVENT_TYPES = Object.freeze([
  "session.created",
  "session.updated",
  "session.deleted",
  "run.state",
  "run.usage",
  "message.started",
  "message.committed",
  "message.finished",
  "provider.attempt",
  "tool.started",
  "tool.completed",
  "grant.created",
  "browser.host",
  "permission.requested",
  "permission.resolved",
  "files.changed",
  "run.verification",
  "terminal.opened",
  "terminal.closed",
  "context.compacted",
  "workspace.viewed",
  "workspace.created",
  "workspace.removed",
  "agent.started",
  "agent.status",
  "agent.exited",
  "plan.created",
  "plan.state",
  "plan.task.state",
  "plan.task.updated",
  "account.changed",
]);

export const EventSchema = z.object({
  engineBootId: Id,
  eventSeq: DecimalString,
  sessionId: Id.nullable(),
  runId: Id.nullable(),
  type: z.enum(EVENT_TYPES),
  payload: z.record(z.string(), z.unknown()),
  at: IsoTimestamp,
});

/** Transient preview: message ID plus UTF-8 byte offset; never a durable sequence (§11.4). */
export const PreviewSchema = z.object({
  sessionId: Id,
  runId: Id,
  messageId: Id,
  byteOffset: z.number().int().nonnegative(),
  text: z.string().max(LIMITS.previewChunkBytes),
});

// ---- External agents --------------------------------------------
// Jolo can host another vendor's coding-agent CLI in an engine-owned terminal. Jolo does not drive it and
// cannot know its internals: status is observed, and every status says which signal produced it.

export const AGENT_STATUSES = Object.freeze(["starting", "working", "needs_input", "idle", "done"]);
/** process: the child's liveness, authoritative. screen: a manifest rule matched. silence: no output for a while. */
export const AGENT_STATUS_SOURCES = Object.freeze(["process", "screen", "silence"]);
export const AGENT_LIMITS = Object.freeze({ maxRules: 40, maxAgents: 8, minIdleMs: 500, maxIdleMs: 120_000 });
/** pty: a terminal Jolo watches. The rest are structured transports, driven turn by turn as a Jolo session: Claude Code's
 *  stream, Codex's app-server, or the Agent Client Protocol spoken by any agent that offers it. */
export const AGENT_TRANSPORTS = Object.freeze(["pty", "claude-stream", "codex-app-server", "acp"]);

export const AgentRuleSchema = z.object({
  id: z.string().min(1).max(64),
  state: z.enum(["working", "needs_input", "idle", "done"]),
  priority: z.number().int().min(0).max(10_000).default(500),
  region: z.enum(["bottom", "screen", "title"]).default("bottom"),
  regionLines: z.number().int().min(1).max(200).default(6),
  contains: z.string().min(1).max(200).optional(),
  regex: z.string().min(1).max(400).optional(),
}).refine((rule) => Boolean(rule.contains) !== Boolean(rule.regex), { message: "a rule needs exactly one of contains or regex" });

/** Which model a hosted agent should use, and how hard it should think. Each vendor has its own
 *  vocabulary for both, so these are opaque strings Jolo passes through rather than a fixed enum. */
export const AgentModelSettingsSchema = z.object({
  model: z.string().min(1).max(200).nullable().default(null),
  effort: z.string().min(1).max(40).nullable().default(null),
});

/** The same fields as a patch. Defaults are deliberately absent: an unnamed field keeps its stored value,
 *  and only an explicit null clears one. */
export const AgentModelPatchSchema = z.object({
  model: z.string().min(1).max(200).nullable().optional(),
  effort: z.string().min(1).max(40).nullable().optional(),
});

/** A model a hosted agent says it can run, as reported by that agent (§4.3). */
export const AgentModelSchema = z.object({
  id: z.string().min(1).max(200),
  displayName: z.string().max(200),
  description: z.string().max(500).default(""),
  isDefault: z.boolean().default(false),
  efforts: z.array(z.string().max(40)).max(20).default([]),
});

export const AgentIdKey = z.string().regex(/^[a-z][a-z0-9-]{0,38}$/, "lowercase kebab-case id");

export const AgentManifestSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,38}$/, "lowercase kebab-case id"),
  displayName: z.string().min(1).max(60),
  description: z.string().max(200).default(""),
  binary: z.string().min(1).max(200),
  args: z.array(z.string().max(200)).max(32).default([]),
  /** Appended when the user supplies an opening prompt; {prompt} is replaced. Omit when the CLI has no such flag. */
  promptArgs: z.array(z.string().max(200)).max(8).optional(),
  /** How this CLI is told which model to use; {model} is replaced. Placed before args, since most CLIs want
   *  their own options before a subcommand. Omit when the transport carries the model itself, as Codex does. */
  modelArgs: z.array(z.string().max(200)).max(8).optional(),
  /** The same for reasoning effort; {effort} is replaced. */
  effortArgs: z.array(z.string().max(200)).max(8).optional(),
  transport: z.enum(AGENT_TRANSPORTS).default("pty"),
  statusModel: z.enum(["process", "screen"]).default("process"),
  idleMs: z.number().int().min(AGENT_LIMITS.minIdleMs).max(AGENT_LIMITS.maxIdleMs).default(4_000),
  rules: z.array(AgentRuleSchema).max(AGENT_LIMITS.maxRules).default([]),
});

export const AgentCatalogEntrySchema = z.object({
  id: Id,
  displayName: z.string(),
  description: z.string(),
  binary: z.string(),
  statusModel: z.enum(["process", "screen"]),
  transport: z.enum(AGENT_TRANSPORTS),
  available: z.boolean(),
  resolvedPath: z.string().nullable(),
  source: z.enum(["builtin", "user"]),
  /** The configured model and effort for this agent, and whether Jolo can set them at all. */
  model: z.string().nullable(),
  effort: z.string().nullable(),
  supportsModel: z.boolean(),
  supportsEffort: z.boolean(),
});

export const AgentSessionSchema = z.object({
  terminalId: Id,
  workspaceId: Id,
  agentId: Id,
  displayName: z.string(),
  status: z.enum(AGENT_STATUSES),
  statusSource: z.enum(AGENT_STATUS_SOURCES),
  statusDetail: z.string().max(200).nullable(),
  exitCode: z.number().int().nullable(),
  startedAt: IsoTimestamp,
  lastActivityAt: IsoTimestamp,
});

// ---- plans -------------------------------------------------------------------------------------
// A plan is work split into ordered tasks, each answered by the agent the user chose for it (§6.6). A task is
// the unit of work; an execution is one try at it. Tasks run one at a time in the plan's own workspace, so a
// later task sees what the earlier ones did, and nothing has to be merged before the user has looked.

export const PLAN_STATES = Object.freeze(["draft", "running", "paused", "done", "failed", "cancelled"]);
export const PLAN_TASK_STATES = Object.freeze(["pending", "running", "blocked", "done", "failed", "cancelled", "skipped"]);
/** Why a task cannot move. Attention is derived from this, never stored as a state of its own. */
export const PLAN_BLOCKED_REASONS = Object.freeze(["permission", "declined", "failure", "interrupted", "budget", "agent_unavailable"]);
export const PLAN_EXECUTION_PURPOSES = Object.freeze(["implement", "retry"]);
export const PLAN_EXECUTION_OUTCOMES = Object.freeze(["completed", "failed", "cancelled", "interrupted", "paused"]);
/** How many tasks one plan may hold: enough for real work, few enough that a plan stays readable. */
export const PLAN_TASK_DRAFT_LIMIT = 50;

/** Defaults a plan applies to tasks that name nothing of their own; snapshotted when the plan is created. */
export const PlanPolicySchema = z.object({
  agentId: Id.nullable().default(null),
  model: z.string().max(200).nullable().default(null),
  effort: z.string().max(40).nullable().default(null),
  maxAttempts: z.number().int().min(1).max(10).default(1),
  stopOnFailure: z.boolean().default(true),
});

export const PlanSchema = z.object({
  id: Id,
  projectId: Id,
  workspaceId: Id,
  goal: z.string().max(LIMITS.promptBytes),
  state: z.enum(PLAN_STATES),
  policy: PlanPolicySchema,
  revision: Revision,
  failure: z.string().max(600).nullable(),
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
});

export const PlanTaskSchema = z.object({
  id: Id,
  planId: Id,
  position: z.number().int().nonnegative(),
  title: z.string().max(200),
  brief: z.string().max(LIMITS.promptBytes),
  agentId: Id.nullable(),
  model: z.string().max(200).nullable(),
  effort: z.string().max(40).nullable(),
  state: z.enum(PLAN_TASK_STATES),
  blockedReason: z.enum(PLAN_BLOCKED_REASONS).nullable(),
  revision: Revision,
  sessionId: Id.nullable(),
  acceptedExecutionId: Id.nullable(),
  summary: z.string().max(600).nullable(),
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
});

export const PlanExecutionSchema = z.object({
  id: Id,
  planId: Id,
  taskId: Id,
  attempt: z.number().int().positive(),
  purpose: z.enum(PLAN_EXECUTION_PURPOSES),
  runId: Id.nullable(),
  sessionId: Id.nullable(),
  agentId: Id.nullable(),
  model: z.string().max(200).nullable(),
  effort: z.string().max(40).nullable(),
  outcome: z.enum(PLAN_EXECUTION_OUTCOMES).nullable(),
  detail: z.string().max(600).nullable(),
  usage: UsageSchema.partial().optional(),
  startedAt: IsoTimestamp,
  endedAt: IsoTimestamp.nullable(),
});

/** A task as it is written down, before it has an identity. */
export const PlanTaskDraftSchema = z.object({
  title: z.string().min(1).max(200),
  brief: z.string().min(1).max(LIMITS.promptBytes),
  agentId: Id.nullable().optional(),
  model: z.string().max(200).nullable().optional(),
  effort: z.string().max(40).nullable().optional(),
});

export const EventPayloadSchemas = Object.freeze({
  "account.changed": z.object({ state: z.enum(['signed_out', 'pending', 'signed_in']) }),
  "session.created": z.object({ session: SessionSchema }),
  "session.updated": z.object({ session: SessionSchema }),
  "session.deleted": z.object({ sessionId: Id, projectId: Id }),
  "run.state": z.object({ state: RunStateSchema, revision: Revision, pauseReason: PauseReasonSchema.nullable().optional(), failure: z.string().nullable().optional(), permissionId: Id.nullable().optional(), attempt: z.number().int().positive().optional(), agentId: Id.nullable().optional(), promptPreview: z.string().max(500).optional(), attachments: ImageAttachmentsSchema.optional(), taskReferences: z.array(TaskReferenceSummarySchema).max(4).optional() }),
  "terminal.opened": z.object({ terminalId: Id, workspaceId: Id, keepAlive: z.boolean() }),
  "context.compacted": z.object({ checkpointId: Id, throughOrdinal: z.number().int().nonnegative(), summarizedItems: z.number().int().nonnegative(), summaryBytes: z.number().int().nonnegative(), estimatedTokensBefore: z.number().int().nonnegative(), estimatedTokensAfter: z.number().int().nonnegative(), reason: z.string().max(200) }),
  "terminal.closed": z.object({ terminalId: Id, workspaceId: Id, reason: z.string() }),
  "workspace.viewed": z.object({ projectId: Id, workspaceId: Id, lastViewedAt: IsoTimestamp }),
  "workspace.created": z.object({ workspace: WorkspaceSchema }),
  "workspace.removed": z.object({ workspaceId: Id, projectId: Id, path: z.string(), branch: z.string().nullable() }),
  "agent.started": z.object({ terminalId: Id, workspaceId: Id, agentId: Id, displayName: z.string(), binary: z.string() }),
  "agent.status": z.object({ terminalId: Id, workspaceId: Id, agentId: Id, status: z.enum(AGENT_STATUSES), source: z.enum(AGENT_STATUS_SOURCES), detail: z.string().max(200).nullable() }),
  "agent.exited": z.object({ terminalId: Id, workspaceId: Id, agentId: Id, exitCode: z.number().int().nullable() }),
  "plan.created": z.object({ plan: PlanSchema, tasks: z.array(PlanTaskSchema) }),
  "plan.state": z.object({ planId: Id, state: z.enum(PLAN_STATES), revision: Revision, failure: z.string().max(600).nullable().optional() }),
  "plan.task.state": z.object({
    planId: Id, taskId: Id, state: z.enum(PLAN_TASK_STATES), revision: Revision,
    blockedReason: z.enum(PLAN_BLOCKED_REASONS).nullable().optional(),
    sessionId: Id.nullable().optional(), runId: Id.nullable().optional(), executionId: Id.nullable().optional(),
    summary: z.string().max(600).nullable().optional(),
  }),
  "plan.task.updated": z.object({ planId: Id, task: PlanTaskSchema }),
  "permission.requested": z.object({ permissionId: Id, runId: Id, workspaceId: Id, tool: z.string(), summary: z.string().max(500), argv: z.array(z.string()).optional(), script: z.string().max(4000).optional(), cwd: z.string(), isolation: z.enum(["none"]), revision: Revision }),
  "permission.resolved": z.object({ permissionId: Id, decision: z.enum(["allow_once", "allow_run", "allow_project", "deny"]), revision: Revision, grantId: Id.nullable().optional() }),
  "files.changed": z.object({ invocationId: Id, tool: z.string(), messageId: Id.optional(), diffArtifactId: Id.optional(), changes: z.array(z.object({ path: z.string(), op: z.enum(["create", "replace", "delete", "rename"]), newPath: z.string().optional(), beforeHash: z.string().nullable(), afterHash: z.string().nullable() })) }),
  "run.verification": z.object({ status: z.enum(["passed", "failed", "not_run", "interrupted", "stale"]), checks: z.array(z.object({ invocationId: Id, argv: z.array(z.string()), exitCode: z.number().int().nullable(), signal: z.string().nullable(), at: IsoTimestamp })) }),
  "message.started": z.object({ messageId: Id, role: MessageSchema.shape.role, kind: MessageSchema.shape.kind.optional(), artifactId: Id, ordinal: z.number().int().nonnegative() }),
  "run.usage": UsageSchema,
  "provider.attempt": z.object({ attempt: z.number().int().positive(), provider: z.string(), preset: PresetId.optional(), model: z.string(), status: z.enum(["started", "completed", "interrupted", "retrying", "failed"]), reason: z.string().optional() }),
  "tool.started": z.object({ invocationId: Id, callId: z.string(), name: z.string(), argumentDigest: z.string(), preview: z.string().max(200) }),
  "tool.completed": z.object({ invocationId: Id, callId: z.string(), name: z.string(), status: z.enum(["ok", "error", "timeout", "denied", "cancelled"]), durationMs: z.number().int().nonnegative(), resultBytes: z.number().int().nonnegative(), truncated: z.boolean(), resultArtifactId: Id.optional(), errorCode: z.string().optional() }),
  "grant.created": z.object({ grantId: Id, scope: z.string(), workspaceId: Id.optional() }),
  "browser.host": z.object({ status: z.enum(["registered", "updated", "unregistered"]), capabilityId: Id, workspaceId: Id, tabId: z.string(), navigationRevision: z.number().int().nonnegative(), url: z.string().optional(), title: z.string().optional() }),
  "message.committed": z.object({ messageId: Id, committedBytes: z.number().int().nonnegative() }),
  "message.finished": z.object({ messageId: Id, committedBytes: z.number().int().nonnegative(), status: z.enum(["complete", "interrupted"]) }),
});

// ---- Methods ---------------------------------------------------------------------------------

const HelloParams = z.object({
  token: z.string().min(16).max(256),
  protocol: z.object({ major: z.number().int().nonnegative(), minor: z.number().int().nonnegative() }),
  build: z.string().max(64),
  clientKind: z.enum(["desktop", "tui", "headless", "control", "test"]),
});

const HelloResult = z.object({
  protocol: z.object({ major: z.number().int(), minor: z.number().int() }),
  schemaVersion: z.number().int(),
  build: z.string(),
  engineBootId: Id,
  eventStreamId: Id.optional(),
  supportedMethods: z.array(z.string()),
  frameLimits: z.object({ maxFrameBytes: z.number().int(), maxBufferedBytes: z.number().int() }),
});

const EngineStatusResult = z.object({
  engineBootId: Id,
  pid: z.number().int(),
  build: z.string(),
  protocol: z.object({ major: z.number().int(), minor: z.number().int() }),
  agent: z.string(),
  clients: z.number().int(),
  activeRuns: z.number().int(),
  queuedRuns: z.number().int(),
  uptimeMs: z.number().int(),
  startedAt: IsoTimestamp,
  cursor: DecimalString,
});

export const SearchTextParams = z.object({
  pattern: z.string().min(1).max(1000).describe('Text or regular expression to search for'),
  paths: z.array(z.string().max(4096)).max(20).default([]).describe('Workspace-relative files or directories; default whole workspace'),
  regex: z.boolean().default(false), caseSensitive: z.boolean().default(false),
  fresh: z.boolean().default(false).describe('Bypass the index to verify the latest file contents'),
  maxMatches: z.number().int().min(1).max(200).default(100),
  cursor: z.string().max(32).optional().describe('Continuation cursor from a truncated result'),
});

export const MethodSchemas = {
  hello: { params: HelloParams, result: HelloResult },
  "engine.status": { params: z.object({}), result: EngineStatusResult },
  "workspace.search": {
    params: SearchTextParams.extend({ workspaceId: Id }),
    result: z.object({ pattern: z.string(), engine: z.enum(['tgrep', 'ripgrep', 'builtin']), freshness: z.enum(['indexed', 'live']), matches: z.array(z.object({ path: z.string(), line: z.number().int(), text: z.string() })), truncated: z.boolean(), nextCursor: z.string().optional(), scanned: z.number().int() }),
  },
  "engine.stop": { params: z.object({ cancelActive: z.boolean().default(false) }), result: z.object({ stopping: z.literal(true) }) },
  "engine.reload": { params: z.object({}), result: z.object({ stopping: z.literal(true) }) },
  "project.open": {
    params: z.object({ path: z.string().min(1).max(4096) }),
    result: z.object({ projectId: Id, workspaceId: Id, rootPath: z.string(), mode: z.enum(["direct", "worktree"]), preferredMode: z.enum(["direct", "worktree"]).default("direct"), standalone: z.boolean().default(false) }),
  },
  "workspace.create": {
    params: z.object({ projectId: Id, mode: z.literal("worktree").default("worktree"), branch: z.string().trim().min(1).max(120).optional(), base: z.string().trim().min(1).max(120).optional(), title: z.string().max(200).default("") }),
    result: z.object({ workspace: WorkspaceSchema }),
  },
  "workspace.list": {
    params: z.object({ projectId: Id }),
    result: z.object({ workspaces: z.array(WorkspaceSchema.extend({ present: z.boolean(), sessionCount: z.number().int().nonnegative() })) }),
  },
  "workspace.readFile": {
    params: z.object({ workspaceId: Id, path: z.string().min(1).max(4096), maxBytes: z.number().int().min(1).max(1024 * 1024).default(256 * 1024) }),
    result: z.object({ path: z.string(), text: z.string(), bytes: z.number().int().nonnegative(), truncated: z.boolean(), binary: z.boolean() }),
  },
  "workspace.remove": {
    params: z.object({ workspaceId: Id, force: z.boolean().default(false) }),
    result: z.object({ workspaceId: Id, branch: z.string().nullable(), path: z.string() }),
  },
  'chat.create': {
    params: z.object({ title: z.string().max(200).default(''), agentId: Id.optional() }),
    result: z.object({ session: SessionSchema, rootPath: z.string() }),
  },
  "session.create": {
    params: z.object({ projectId: Id, workspaceId: Id, title: z.string().max(200).default(""), agentId: Id.optional() }),
    result: z.object({ session: SessionSchema, cursor: DecimalString }),
  },
  "session.list": {
    params: z.object({ projectId: Id.optional(), state: z.enum(["open", "archived"]).default("open"), limit: z.number().int().min(1).max(LIMITS.sessionPageSize).default(LIMITS.sessionPageSize) }),
    result: z.object({ sessions: z.array(SessionSchema) }),
  },
  "session.rename": {
    params: z.object({ sessionId: Id, title: z.string().trim().min(1).max(200), expectedRevision: Revision }),
    result: z.object({ session: SessionSchema }),
  },
  "session.setModel": {
    params: z.object({ sessionId: Id, model: ModelRefSchema.nullable(), expectedRevision: Revision }),
    result: z.object({ session: SessionSchema }),
  },
  "session.setAgent": {
    params: z.object({ sessionId: Id, agentId: Id.nullable(), expectedRevision: Revision }),
    result: z.object({ session: SessionSchema }),
  },
  "session.archive": {
    params: z.object({ sessionId: Id, archived: z.boolean(), expectedRevision: Revision }),
    result: z.object({ session: SessionSchema }),
  },
  "session.delete": {
    params: z.object({ sessionId: Id, expectedRevision: Revision }),
    result: z.object({ sessionId: Id }),
  },
  "session.page": {
    params: z.object({ sessionId: Id, beforeOrdinal: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(200).default(100) }),
    result: z.object({ session: SessionSchema, messages: z.array(MessageSchema), runs: z.array(RunSchema), pendingPermissions: z.array(EventPayloadSchemas['permission.requested']).optional(), hasOlder: z.boolean(), cursor: DecimalString }),
  },
  "run.start": {
    params: z.object({
      sessionId: Id,
      requestId: Id,
      expectedSessionRevision: Revision.optional(),
      prompt: z.string().min(1).max(LIMITS.promptBytes),
      attachments: ImageAttachmentsSchema.optional(),
      /** What this run should be answered with, when it is not the agent's configured default (§6.6). */
      execution: RunExecutionSchema.optional(),
    }),
    result: z.object({ run: RunSchema, deduplicated: z.boolean() }),
  },
  "run.cancel": {
    params: z.object({ runId: Id, expectedRevision: Revision.optional() }),
    result: z.object({ run: RunSchema }),
  },
  "run.sendNow": { params: z.object({ runId: Id }), result: z.object({ run: RunSchema }) },
  "run.snapshot": {
    params: z.object({ runId: Id }),
    result: z.object({ run: RunSchema, messages: z.array(MessageSchema), cursor: DecimalString }),
  },
  "events.subscribe": {
    params: z.object({ after: DecimalString.default("0"), sessionId: Id.optional() }),
    result: z.object({ cursor: DecimalString, replayed: z.number().int().nonnegative() }),
  },
  "attachment.create": {
    params: z.object({ sessionId: Id, mimeType: ImageMimeSchema }),
    result: z.object({ artifactId: Id }),
  },
  "attachment.write": {
    params: z.object({ sessionId: Id, artifactId: Id, offset: z.number().int().min(0).max(LIMITS.imageAttachmentBytes), data: z.string().min(4).max(Math.ceil(LIMITS.attachmentChunkBytes / 3) * 4), final: z.boolean().default(false) }),
    result: z.object({ bytes: z.number().int().nonnegative(), complete: z.boolean() }),
  },
  "artifact.read": {
    params: z.object({
      artifactId: Id,
      offset: z.number().int().nonnegative().default(0),
      length: z.number().int().min(1).max(LIMITS.artifactReadBytes).default(LIMITS.artifactReadBytes),
      encoding: z.enum(["utf8", "base64"]).default("utf8"),
    }),
    result: z.object({ artifactId: Id, offset: z.number().int(), bytes: z.number().int(), text: z.string(), committedBytes: z.number().int(), eof: z.boolean(), kind: z.string().optional() }),
  },
};

// ---- Browser host (§5.3, §11.3): the host registers an ephemeral capability; the engine dispatches admitted operations.

export const BROWSER_OPERATIONS = Object.freeze(["navigate", "snapshot", "click", "type", "screenshot", "network", "fill", "press", "scroll", "hover", "select", "history"]);

export const BrowserExecuteSchema = z.object({
  invocationId: Id,
  capabilityId: Id,
  operation: z.enum(BROWSER_OPERATIONS),
  arguments: z.record(z.string(), z.unknown()),
  navigationRevision: z.number().int().nonnegative(),
  leaseMs: z.number().int().positive(),
  argumentDigest: z.string(),
});

export const BrowserCancelSchema = z.object({ invocationId: Id, reason: z.string().max(200) });
export const BrowserOpenSchema = z.object({ invocationId: Id, workspaceId: Id, leaseMs: z.number().int().positive().max(30_000) });
export const BrowserOpenerSchema = z.object({ workspaceIds: z.array(Id).max(64) });

Object.assign(MethodSchemas, {
  'browser.call': {
    params: z.object({ workspaceId: Id, name: z.enum(['browser_open', 'browser_tabs', ...BROWSER_OPERATIONS.map(operation => `browser_${operation}`)]), arguments: z.record(z.string(), z.unknown()).default({}) }),
    result: z.object({ content: z.array(z.union([z.object({ type: z.literal('text'), text: z.string() }), z.object({ type: z.literal('image'), data: z.string().max(1_400_000), mimeType: z.literal('image/png') })])), structuredContent: z.record(z.string(), z.unknown()).optional(), isError: z.boolean() }),
  },
  'browser.setOpener': { params: BrowserOpenerSchema, result: z.object({ registered: z.boolean() }) },
  'browser.openResult': {
    params: z.object({ invocationId: Id, capabilityId: Id.optional(), error: z.string().max(1000).optional(), errorCode: z.literal('browser_busy').optional() }),
    result: z.object({ accepted: z.boolean() }),
  },
  "browser.register": {
    params: z.object({ workspaceId: Id, tabId: z.string().min(1).max(64), navigationRevision: z.number().int().nonnegative(), url: z.string().max(2048).optional(), title: z.string().max(500).optional(), operations: z.array(z.enum(BROWSER_OPERATIONS)).min(1) }),
    result: z.object({ capabilityId: Id, grantId: Id }),
  },
  "browser.update": {
    params: z.object({ capabilityId: Id, navigationRevision: z.number().int().nonnegative(), url: z.string().max(2048).optional(), title: z.string().max(500).optional() }),
    result: z.object({ capabilityId: Id, navigationRevision: z.number().int().nonnegative() }),
  },
  "browser.unregister": { params: z.object({ capabilityId: Id }), result: z.object({ capabilityId: Id }) },
  "browser.result": {
    params: z.object({
      invocationId: Id,
      status: z.enum(["ok", "error", "cancelled", "stale"]),
      result: z.record(z.string(), z.unknown()).optional(),
      error: z.object({ code: z.string().max(64), message: z.string().max(1000) }).optional(),
      navigationRevision: z.number().int().nonnegative().optional(),
      screenshot: z.object({ base64: z.string().max(1_400_000), width: z.number().int(), height: z.number().int(), mimeType: z.literal("image/png") }).optional(),
    }),
    result: z.object({ accepted: z.boolean() }),
  },
});


export const PROVIDER_NAMES = Object.freeze(["fake", "openai"]);
export const DEMO_PROVIDER_SETTINGS = Object.freeze({ name: "fake", model: "fake", contextWindowTokens: 128_000, maxOutputTokens: 4_096 });

export const ProviderSettingsSchema = z.object({
  name: z.enum(PROVIDER_NAMES),
  model: z.string().min(1).max(100),
  baseUrl: z.string().url().max(500).optional(),
  contextWindowTokens: z.number().int().min(1_000).max(10_000_000),
  maxOutputTokens: z.number().int().min(16).max(1_000_000),
  reasoningEffort: z.enum(["none", "minimal", "low", "medium", "high"]).optional(),
});

export const BudgetSettingsSchema = z.object({
  maxIterations: z.number().int().min(1).max(10_000).default(512),
  maxActiveMs: z.number().int().min(1_000).max(7 * 24 * 3_600_000).default(4 * 3_600_000),
  toolDeadlineMs: z.number().int().min(1_000).max(3_600_000).default(120_000),
});

export const SettingsSchema = z.object({
  model: ModelRefSchema.nullable().default(null),
  providers: ProviderOverridesSchema.default({}),
  provider: ProviderSettingsSchema.nullable(),
  /** Read-only engine capability; older engines do not advertise demo support. */
  demoProviderEnabled: z.boolean().default(false),
  budgets: BudgetSettingsSchema,
  /** Per hosted agent, keyed by manifest id: which model it should use (§4.3). */
  agents: z.record(AgentIdKey, AgentModelSettingsSchema).default({}),
});

const CredentialProvider = PresetId;

export const AccountIdentitySchema = z.object({ id: Id, name: z.string().min(1).max(500), email: z.string().min(1).max(500) });
export const AccountDeviceSchema = z.object({ id: Id, name: z.string().min(1).max(500), expiresAt: IsoTimestamp, scopes: z.array(z.enum(['account:read', 'tasks:read'])).default(['account:read']) });
export const AccountStatusSchema = z.object({
  state: z.enum(['signed_out', 'pending', 'signed_in']),
  origin: z.string().url().max(2048),
  account: AccountIdentitySchema.nullable(),
  device: AccountDeviceSchema.nullable(),
  pending: z.object({ userCode: z.string().regex(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/), verificationUri: z.string().url().max(2048), verificationUriComplete: z.string().url().max(2048), expiresAt: IsoTimestamp }).nullable(),
  source: z.enum(['none', 'session', 'keychain']),
  note: z.string().max(500).nullable(),
});

export const TERMINAL_LIMITS = Object.freeze({ maxCols: 240, maxRows: 100, scrollbackLines: 2000, snapshotBytes: 230 * 1024, inputBytes: 64 * 1024 });

const TerminalSchema = z.object({ terminalId: Id, workspaceId: Id, agentId: Id.nullable().optional(), cols: z.number().int(), rows: z.number().int(), state: z.enum(["running", "exited"]), exitCode: z.number().int().nullable(), keepAlive: z.boolean(), createdAt: IsoTimestamp });

Object.assign(MethodSchemas, {
  'task.list': { params: z.object({q:z.string().max(100).default(''),before:z.number().int().positive().optional()}), result:z.object({tasks:z.array(WebTaskSummarySchema.extend({url:z.string().url()})).max(20),next:z.number().int().positive().nullable()}) },
  'task.get': { params: z.object({key:z.string().regex(/^JOLO-[1-9][0-9]{0,14}$/i)}), result:z.object({task:WebTaskSchema.extend({url:z.string().url()})}) },
  'account.status': { params: z.object({ refresh: z.boolean().default(false) }), result: AccountStatusSchema },
  'account.login': { params: z.object({ tasks: z.boolean().optional(), origin: z.string().url().max(2048).optional(), deviceName: z.string().min(1).max(100).optional() }), result: AccountStatusSchema },
  'account.cancel': { params: z.object({}), result: AccountStatusSchema },
  'account.logout': { params: z.object({}), result: AccountStatusSchema },
  "terminal.open": {
    params: z.object({ workspaceId: Id, cols: z.number().int().min(20).max(TERMINAL_LIMITS.maxCols).default(80), rows: z.number().int().min(5).max(TERMINAL_LIMITS.maxRows).default(24), keepAlive: z.boolean().default(false) }),
    result: z.object({ terminal: TerminalSchema, snapshot: z.string(), seq: DecimalString, inputLease: z.boolean() }),
  },
  "terminal.attach": { params: z.object({ terminalId: Id }), result: z.object({ terminal: TerminalSchema, snapshot: z.string(), seq: DecimalString, inputLease: z.boolean() }) },
  "terminal.input": { params: z.object({ terminalId: Id, data: z.string().min(1).max(TERMINAL_LIMITS.inputBytes) }), result: z.object({ accepted: z.literal(true) }) },
  "terminal.resize": { params: z.object({ terminalId: Id, cols: z.number().int().min(20).max(TERMINAL_LIMITS.maxCols), rows: z.number().int().min(5).max(TERMINAL_LIMITS.maxRows) }), result: z.object({ cols: z.number().int(), rows: z.number().int() }) },
  "terminal.lease": { params: z.object({ terminalId: Id }), result: z.object({ inputLease: z.literal(true) }) },
  "terminal.close": { params: z.object({ terminalId: Id }), result: z.object({ closed: z.literal(true) }) },
  "terminal.list": { params: z.object({ workspaceId: Id.optional() }), result: z.object({ terminals: z.array(TerminalSchema) }) },
  "permission.resolve": {
    params: z.object({ permissionId: Id, decision: z.enum(["allow_once", "allow_run", "allow_project", "deny"]), expectedRevision: Revision.optional() }),
    result: z.object({ permissionId: Id, decision: z.enum(["allow_once", "allow_run", "allow_project", "deny"]), revision: Revision, runId: Id }),
  },
  "run.resume": {
    params: z.object({ runId: Id, expectedRevision: Revision.optional() }),
    result: z.object({ run: RunSchema }),
  },
  "patch.revert": {
    params: z.object({ invocationId: Id, path: z.string().min(1).max(4096) }),
    result: z.object({ invocationId: Id, changes: z.array(z.object({ path: z.string(), op: z.enum(["create", "replace", "delete", "rename"]), newPath: z.string().optional(), beforeHash: z.string().nullable(), afterHash: z.string().nullable() })) }),
  },
  "workspace.diff": {
    params: z.object({ workspaceId: Id, path: z.string().max(4096).optional() }),
    result: z.object({ diff: z.string(), truncated: z.boolean(), source: z.enum(["git", "none"]) }),
  },
  "workspace.changes": {
    params: z.object({ workspaceId: Id }),
    result: z.object({ files: z.array(z.object({ path: z.string(), newPath: z.string().optional(), op: z.enum(['create', 'replace', 'delete', 'rename']), revision: z.string() })), source: z.enum(['git', 'none']), truncated: z.boolean() }),
  },
  "provider.presets": { params: z.object({}), result: z.object({ presets: z.array(ProviderEntrySchema).max(100) }) },
  "provider.models": { params: z.object({ preset: PresetId, refresh: z.boolean().default(false) }), result: ProviderModelsSchema },
  "settings.get": { params: z.object({}), result: z.object({ settings: SettingsSchema }) },
  "settings.update": {
    // agents is a patch: an entry merges into that agent's settings, and null forgets the agent entirely.
    params: z.object({
      provider: ProviderSettingsSchema.nullable().optional(),
      model: ModelRefSchema.nullable().optional(),
      providers: ProviderOverridesSchema.optional(),
      budgets: BudgetSettingsSchema.partial().optional(),
      agents: z.record(AgentIdKey, AgentModelPatchSchema.nullable()).optional(),
    }),
    result: z.object({ settings: SettingsSchema }),
  },
  "credential.set": {
    params: z.object({ provider: CredentialProvider, value: z.string().min(8).max(4096) }),
    result: z.object({ provider: CredentialProvider, stored: z.enum(["keychain", "session"]) }),
  },
  "credential.status": {
    params: z.object({ provider: CredentialProvider }),
    result: z.object({ provider: CredentialProvider, available: z.boolean(), source: z.enum(["keychain", "session", "environment", "none"]) }),
  },
});

// ---- Work board (cross-project attention view) ------------------------------------------------

export const BOARD_ATTENTION = Object.freeze(["needs_you", "done", "running", "idle"]);

const BoardActionSchema = z.object({ invocationId: Id, name: z.string().max(64), preview: z.string().max(200), status: z.string().max(20), at: IsoTimestamp });
const BoardPermissionSchema = z.object({ permissionId: Id, tool: z.string().max(64), summary: z.string().max(500), argv: z.array(z.string()).optional(), script: z.string().max(4000).optional(), cwd: z.string(), createdAt: IsoTimestamp });
const BoardRunSchema = z.object({
  id: Id, sessionId: Id, state: RunStateSchema, revision: Revision, pauseReason: PauseReasonSchema.nullable(), failure: z.string().nullable(),
  prompt: z.string(), createdAt: IsoTimestamp, updatedAt: IsoTimestamp,
  verification: z.record(z.string(), z.unknown()).nullable(),
  usage: UsageSchema.nullable(),
  note: RunNoteSchema.nullable(),
});

export const BoardRowSchema = z.object({
  standalone: z.boolean().default(false),
  projectId: Id,
  rootPath: z.string(),
  name: z.string(),
  workspaceId: Id,
  taskCount: z.number().int().nonnegative().optional(),
  working: z.boolean().optional(),
  workspace: z.object({ id: Id, mode: z.enum(["direct", "worktree"]), branch: z.string().nullable(), path: z.string() }),
  lastViewedAt: IsoTimestamp.nullable(),
  attention: z.enum(BOARD_ATTENTION),
  reason: z.string().max(40).nullable(),
  summary: z.string().max(600),
  nextStep: z.string().max(400).nullable(),
  session: z.object({ id: Id, title: z.string() }).nullable(),
  run: BoardRunSchema.nullable(),
  pendingPermission: BoardPermissionSchema.nullable(),
  actions: z.array(BoardActionSchema).max(3),
  changedFiles: z.number().int().nonnegative(),
  git: z.object({ branch: z.string().nullable(), dirty: z.number().int().nonnegative().nullable() }),
  lastActivityAt: IsoTimestamp.nullable(),
});

/** One open task, wherever it lives: what a task list spanning every project shows for it (§5.1). */
export const BoardTaskSchema = z.object({
  standalone: z.boolean().default(false),
  sessionId: Id,
  title: z.string().max(200),
  agentId: Id.nullable(),
  projectId: Id,
  projectName: z.string(),
  rootPath: z.string(),
  workspaceId: Id,
  branch: z.string().nullable(),
  mode: z.enum(["direct", "worktree"]),
  attention: z.enum(BOARD_ATTENTION),
  reason: z.string().max(40).nullable(),
  summary: z.string().max(600).nullable(),
  updatedAt: IsoTimestamp,
  run: z.object({ id: Id, state: RunStateSchema, pauseReason: PauseReasonSchema.nullable(), createdAt: IsoTimestamp, updatedAt: IsoTimestamp }).nullable(),
});

Object.assign(MethodSchemas, {
  "board.list": { params: z.object({}), result: z.object({ projects: z.array(BoardRowSchema), generatedAt: IsoTimestamp }) },
  "board.tasks": {
    params: z.object({ limit: z.number().int().min(1).max(500).default(200), workspaceId: Id.optional(), standalone: z.boolean().optional(), state: z.enum(["open", "archived"]).optional(), before: z.object({ updatedAt: IsoTimestamp, sessionId: Id }).optional() }),
    result: z.object({ tasks: z.array(BoardTaskSchema), generatedAt: IsoTimestamp, hasMore: z.boolean().optional(), nextCursor: z.object({ updatedAt: IsoTimestamp, sessionId: Id }).nullable().optional() }),
  },
  "board.viewed": { params: z.object({ workspaceId: Id }), result: z.object({ projectId: Id, workspaceId: Id, lastViewedAt: IsoTimestamp }) },
  "agent.catalog": { params: z.object({}), result: z.object({ agents: z.array(AgentCatalogEntrySchema) }) },
  // Asking an agent which models it can run means starting it, so this is an interactive client's request.
  "agent.models": {
    params: z.object({ agentId: Id, refresh: z.boolean().optional().default(false) }),
    result: z.object({
      agentId: Id,
      models: z.array(AgentModelSchema),
      efforts: z.array(z.string().max(40)),
      source: z.enum(["agent", "none"]),
      note: z.string().max(300).nullable(),
    }),
  },
  "agent.start": {
    params: z.object({
      workspaceId: Id, agentId: Id,
      cols: z.number().int().min(20).max(TERMINAL_LIMITS.maxCols).default(80),
      rows: z.number().int().min(5).max(TERMINAL_LIMITS.maxRows).default(24),
      prompt: z.string().max(LIMITS.promptBytes).optional(),
    }),
    result: z.object({ agent: AgentSessionSchema, terminal: TerminalSchema, snapshot: z.string(), seq: DecimalString, inputLease: z.boolean() }),
  },
  "agent.list": { params: z.object({ workspaceId: Id.optional() }), result: z.object({ agents: z.array(AgentSessionSchema) }) },
  "agent.stop": { params: z.object({ terminalId: Id }), result: z.object({ stopped: z.literal(true) }) },

  // Plans (§6.6). Writing one down is free; starting it is what puts work in front of an agent.
  "plan.create": {
    params: z.object({
      projectId: Id,
      workspaceId: Id.optional(),
      goal: z.string().min(1).max(LIMITS.promptBytes),
      tasks: z.array(PlanTaskDraftSchema).min(1).max(PLAN_TASK_DRAFT_LIMIT),
      policy: PlanPolicySchema.partial().optional(),
    }),
    result: z.object({ plan: PlanSchema, tasks: z.array(PlanTaskSchema) }),
  },
  "plan.list": {
    params: z.object({ projectId: Id.optional(), limit: z.number().int().min(1).max(200).default(50), includeTasks: z.boolean().default(false) }),
    result: z.object({ plans: z.array(PlanSchema.extend({ counts: z.record(z.string(), z.number().int().nonnegative()), tasks: z.array(PlanTaskSchema).optional() })) }),
  },
  "plan.get": {
    params: z.object({ planId: Id }),
    result: z.object({ plan: PlanSchema, tasks: z.array(PlanTaskSchema), executions: z.array(PlanExecutionSchema) }),
  },
  "plan.start": { params: z.object({ planId: Id, expectedRevision: Revision.optional() }), result: z.object({ plan: PlanSchema }) },
  "plan.pause": { params: z.object({ planId: Id }), result: z.object({ plan: PlanSchema }) },
  "plan.cancel": { params: z.object({ planId: Id }), result: z.object({ plan: PlanSchema }) },
  "plan.task.add": {
    params: z.object({ planId: Id, task: PlanTaskDraftSchema, position: z.number().int().nonnegative().optional() }),
    result: z.object({ task: PlanTaskSchema }),
  },
  "plan.task.update": {
    params: z.object({
      taskId: Id,
      expectedRevision: Revision.optional(),
      title: z.string().min(1).max(200).optional(),
      brief: z.string().min(1).max(LIMITS.promptBytes).optional(),
      agentId: Id.nullable().optional(),
      model: z.string().max(200).nullable().optional(),
      effort: z.string().max(40).nullable().optional(),
      position: z.number().int().nonnegative().optional(),
    }),
    result: z.object({ task: PlanTaskSchema }),
  },
  "plan.task.remove": { params: z.object({ taskId: Id }), result: z.object({ taskId: Id }) },
  "plan.task.retry": { params: z.object({ taskId: Id }), result: z.object({ task: PlanTaskSchema }) },
  "plan.task.skip": { params: z.object({ taskId: Id }), result: z.object({ task: PlanTaskSchema }) },
});

Object.freeze(MethodSchemas);
export const METHOD_NAMES = Object.freeze(Object.keys(MethodSchemas)); // all method groups are registered above

export class ProtocolError extends Error {
  /** @param {string} code @param {string} message @param {Record<string, unknown>} [details] */
  constructor(code, message, details) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
    this.details = details;
  }
}

const JSON_RPC_CODES = Object.freeze({
  unknown_method: -32601,
  invalid_params: -32602,
  invalid_frame: -32700,
});

/** Build a JSON-RPC error object from a ProtocolError. */
export function toRpcError(error) {
  const code = ERROR_CODES.includes(error?.code) ? error.code : "internal";
  const message = code === "internal" ? "internal error" : String(error?.message ?? code);
  const data = { code };
  if (error?.details) data.details = error.details;
  return { code: JSON_RPC_CODES[code] ?? -32000, message, data };
}

// A successful Zod object parse may remove unknown nested fields. Requests must
// fail instead of silently changing the meaning of a newer client's operation.
function strippedKeys(input, output, prefix = []) {
  if (!input || typeof input !== "object" || !output || typeof output !== "object") return [];
  const issues = [];
  for (const key of Object.keys(input)) {
    const path = [...prefix, key];
    if (!Object.hasOwn(output, key)) issues.push({ path: path.join("."), message: "unrecognized key" });
    else issues.push(...strippedKeys(input[key], output[key], path));
    if (issues.length >= 5) break;
  }
  return issues.slice(0, 5);
}

/**
 * Validate params for a method. Unknown methods fail closed.
 * @returns {{ ok: true, value: any } | { ok: false, error: ProtocolError }}
 */
export function parseParams(method, params) {
  const schema = MethodSchemas[method];
  if (!schema) return { ok: false, error: new ProtocolError("unknown_method", `unknown method ${method}`) };
  const result = (schema.params.strict ? schema.params.strict() : schema.params).safeParse(params ?? {});
  if (!result.success) {
    return { ok: false, error: new ProtocolError("invalid_params", `invalid params for ${method}`, { issues: result.error.issues.slice(0, 5).map((i) => ({ path: i.path.join("."), message: i.message })) }) };
  }
  const unknown = strippedKeys(params ?? {}, result.data);
  if (unknown.length) return { ok: false, error: new ProtocolError("invalid_params", `unknown fields for ${method}`, { issues: unknown }) };
  return { ok: true, value: result.data };
}

/** Validate a method result before it crosses the wire (engine side) or after (client side). */
export function parseResult(method, result) {
  const schema = MethodSchemas[method];
  if (!schema) return { ok: false, error: new ProtocolError("unknown_method", `unknown method ${method}`) };
  const parsed = schema.result.safeParse(result);
  if (!parsed.success) return { ok: false, error: new ProtocolError("internal", `invalid result for ${method}`, { issues: parsed.error.issues.slice(0, 5).map((i) => ({ path: i.path.join("."), message: i.message })) }) };
  return { ok: true, value: parsed.data };
}

export function parseEnvelope(value) {
  const parsed = EnvelopeSchema.safeParse(value);
  if (!parsed.success) return { ok: false, error: new ProtocolError("invalid_frame", "envelope is not a JSON-RPC 2.0 request, response, or notification") };
  return { ok: true, value: parsed.data };
}

export function parseEvent(value) {
  const parsed = EventSchema.safeParse(value);
  if (!parsed.success) return { ok: false, error: new ProtocolError("invalid_frame", "invalid event notification") };
  const payload = EventPayloadSchemas[parsed.data.type]?.safeParse(parsed.data.payload);
  if (!payload?.success) return { ok: false, error: new ProtocolError("invalid_frame", `invalid ${parsed.data.type} payload`, { issues: payload?.error?.issues?.slice(0, 5) }) };
  // Validate required fields; preserve additive event fields for newer consumers.
  return { ok: true, value: parsed.data };
}

export function parsePreview(value) {
  const parsed = PreviewSchema.safeParse(value);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: new ProtocolError("invalid_frame", "invalid preview notification") };
}

/** Compare durable sequence strings numerically without losing precision. */
export function compareSeq(a, b) {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function parseBrowserExecute(value) {
  const parsed = BrowserExecuteSchema.safeParse(value);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: new ProtocolError("invalid_frame", "invalid browser.execute notification") };
}

export const TerminalOutputSchema = z.object({ terminalId: Id, seq: DecimalString, data: z.string() }); // base64 bytes
export const TerminalStateSchema = z.object({ terminalId: Id, state: z.enum(["running", "exited"]), exitCode: z.number().int().nullable() });
