import { z } from 'zod';
import { ProtocolError } from '@jolo/protocol';

export const decisionTools = [{
  name: 'decision_choose',
  description: 'Ask the selected decision model to classify state or choose between explicit options. Use for structured decisions requested by the user; answer ordinary conversation yourself. Explain the result to the user. Decisions do not grant permission for actions.',
  executionClass: 'read', deadlineMs: 30_000, decisionOperation: true,
  params: z.object({
    state: z.string().min(1).max(24_000),
    question: z.string().min(1).max(2_000),
    options: z.array(z.object({ label: z.string().min(1).max(100), description: z.string().max(2_000) })).min(2).max(32)
      .refine(options => new Set(options.map(option => option.label)).size === options.length, 'Option labels must be unique'),
  }),
  async execute(ctx, args) {
    const selection = ctx.storage.getRunProviderConfig(ctx.runId)?.decisionModel;
    if (!selection || !ctx.decisions) throw new ProtocolError('unavailable', 'No decision model is selected for this run.');
    return ctx.decisions.request({ state: args.state, questions: { decision: {
      type: 'choice', instructions: args.question,
      criteria: Object.fromEntries(args.options.map(option => [option.label, option.description])),
    } } }, selection.ref, ctx.signal, selection);
  },
}];
