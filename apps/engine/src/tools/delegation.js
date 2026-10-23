import { z } from 'zod';
import { ProtocolError } from '@jolo/protocol';

export const delegationTools = [
  { name: 'delegation_models', description: 'List the model aliases explicitly selected by the user with ^ for this conversation. Only these aliases can run child tasks.',
    executionClass: 'read', params: z.object({}), method: 'listModels', deadlineMs: 10_000 },
  { name: 'delegate_task', description: 'Start a child task on a user-selected model alias. Supply a self-contained prompt; the child has its own conversation in this workspace. Returns immediately with a delegation id. Collect its result using delegation_status. Reuse requestId only when retrying the same start.',
    executionClass: 'mutation', params: z.object({ modelAlias: z.string().regex(/^m\d+$/), title: z.string().min(1).max(80), prompt: z.string().min(1).max(32 * 1024), requestId: z.string().min(1).max(128) }), method: 'start', deadlineMs: 30_000 },
  // The wait itself is bounded by the delegation.maxWaitMs setting; the schema only bounds what that setting may be.
  { name: 'delegation_status', description: "Read a child task's state and latest answer. A child may keep working after its first answer: `done` is true only when its process is idle. Set `waitMs` (up to the configured maximum, default 600000) to wait inside Jolo without polling. If `activity` is `background`, the child is still working; do not report its `output` as final while `partial` is true.",
    executionClass: 'read', params: z.object({ delegationId: z.string().min(1).max(128), waitMs: z.number().int().min(0).max(3_600_000).default(0) }), method: 'status', deadlineMs: 3_600_000 },
  { name: 'delegation_cancel', description: 'Stop a child task in this conversation that is no longer needed.',
    executionClass: 'mutation', params: z.object({ delegationId: z.string().min(1).max(128) }), method: 'cancel', deadlineMs: 10_000 },
].map(tool => ({ ...tool, async execute(ctx, args) {
  if (!ctx.delegations) throw new ProtocolError('unavailable', 'Child-task delegation is unavailable');
  // A wait ends early when the call is stopped (the run cancelled, or the native loop's own tool deadline).
  return ctx.delegations[tool.method](ctx.runId, tool.method === 'cancel' ? args.delegationId : args, ctx.signal);
} }));
