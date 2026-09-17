import { z } from 'zod';
import { ProtocolError } from '@jolo/protocol';

export const delegationTools = [
  { name: 'delegation_models', description: 'List the model aliases explicitly selected by the user with ^ for this conversation. Only these aliases can run child tasks.',
    executionClass: 'read', params: z.object({}), method: 'listModels', deadlineMs: 10_000 },
  { name: 'delegate_task', description: 'Start a child task on a user-selected model alias. Supply a self-contained prompt; the child has its own conversation in this workspace. Returns immediately with a delegation id. Collect its result using delegation_status. Reuse requestId only when retrying the same start.',
    executionClass: 'mutation', params: z.object({ modelAlias: z.string().regex(/^m\d+$/), title: z.string().min(1).max(80), prompt: z.string().min(1).max(32 * 1024), requestId: z.string().min(1).max(128) }), method: 'start', deadlineMs: 30_000 },
  { name: 'delegation_status', description: 'Read a child task state and its final response. Set waitMs up to 25000 to wait for completion without busy polling. If paused or awaiting_permission, open the child task for user action; do not report success until completed.',
    executionClass: 'read', params: z.object({ delegationId: z.string().min(1).max(128), waitMs: z.number().int().min(0).max(25_000).default(0) }), method: 'status', deadlineMs: 30_000 },
  { name: 'delegation_cancel', description: 'Stop a child task in this conversation that is no longer needed.',
    executionClass: 'mutation', params: z.object({ delegationId: z.string().min(1).max(128) }), method: 'cancel', deadlineMs: 10_000 },
].map(tool => ({ ...tool, async execute(ctx, args) {
  if (!ctx.delegations) throw new ProtocolError('unavailable', 'Child-task delegation is unavailable');
  return ctx.delegations[tool.method](ctx.runId, tool.method === 'cancel' ? args.delegationId : args);
} }));
