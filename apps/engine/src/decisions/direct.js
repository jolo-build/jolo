import { z } from 'zod';
import { ProtocolError } from '@jolo/protocol';
import { newId } from '../storage/index.js';

const Description = z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown()), z.null()]);
const Instructions = Description.refine(value => value !== null, 'Instructions are required');
const Question = z.discriminatedUnion('type', [
  z.object({ type: z.literal('choice'), instructions: Instructions, criteria: z.record(z.string().min(1).max(100), Description).refine(value => Object.keys(value).length >= 2 && Object.keys(value).length <= 255) }),
  z.object({ type: z.literal('noul'), instructions: Instructions, criteria: z.object({ true: Description, false: Description }).optional() }),
  z.object({ type: z.literal('score'), instructions: Instructions, criteria: z.array(Description).min(2).max(10) }),
]);
export const DirectDecisionRequest = z.object({
  state: z.union([z.string().min(1), z.record(z.string(), z.unknown()), z.array(z.unknown())]),
  questions: z.record(z.string().min(1).max(100), Question).refine(value => Object.keys(value).length >= 1 && Object.keys(value).length <= 32),
}).refine(value => Buffer.byteLength(JSON.stringify(value)) <= 32_000, 'Decision requests must fit within 32 KB');

// Keep the explicit JSON interface without requiring ordinary chat messages to use it.
export function isDirectDecisionPrompt(prompt) {
  const text = prompt.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1');
  return text.startsWith('{') && /"(?:state|questions)"\s*:/.test(text);
}
const Probability = z.number().min(0).max(1);
const Distribution = z.record(z.string(), Probability);
export const DirectDecisionReply = z.object({
  model: z.string().max(200),
  answers: z.record(z.string(), z.discriminatedUnion('type', [
    z.object({ type: z.literal('choice'), choice: z.string(), confidence: Probability, probabilities: Distribution }),
    z.object({ type: z.literal('noul'), noul: Probability }),
    z.object({ type: z.literal('score'), score: z.number().nonnegative(), confidence: Probability, probabilities: Distribution, legend: z.record(z.string(), Description) }),
  ])),
  usage: z.object({ input_tokens: z.number().nonnegative(), output_tokens: z.number().nonnegative(), cost: z.number().nonnegative().optional() }).optional(),
});

export function validateDecisionAnswers(request, reply) {
  const ids = Object.keys(request.questions);
  if (Object.keys(reply.answers).length !== ids.length) throw new Error('Decision provider returned unknown or missing questions');
  for (const id of ids) {
    const question = request.questions[id], answer = reply.answers[id];
    if (!answer || answer.type !== question.type) throw new Error('Decision provider returned missing or mismatched answers');
    if (answer.type === 'noul') continue;
    const labels = question.type === 'score' ? question.criteria.map((_, index) => String(index)) : Object.keys(question.criteria);
    if (Object.keys(answer.probabilities).length !== labels.length || labels.some(label => !Object.hasOwn(answer.probabilities, label))) throw new Error('Decision provider returned unknown or missing choices');
    if (Math.abs(Object.values(answer.probabilities).reduce((sum, value) => sum + value, 0) - 1) > 0.01) throw new Error('Decision probabilities do not sum to one');
    if (answer.type === 'choice' && !labels.includes(answer.choice)) throw new Error('Decision provider returned unknown or missing choices');
    if (answer.type === 'score' && answer.score > labels.length - 1) throw new Error('Decision provider returned a score outside the rubric');
  }
}

const escape = value => String(value).replace(/[\\`*_{}\[\]<>#|]/g, '\\$&').replace(/[\r\n]+/g, ' ');
export function formatDecisionReply(reply) {
  return Object.entries(reply.answers).map(([id, answer]) => {
    if (answer.type === 'noul') return `### ${escape(id)}\n\nYes probability: ${(answer.noul * 100).toFixed(1)}%`;
    const result = answer.type === 'choice' ? escape(answer.choice) : answer.score.toFixed(2);
    const rows = Object.entries(answer.probabilities).map(([label, probability]) => {
      const description = answer.type === 'score' ? answer.legend[label] : null;
      const shown = description == null ? label : `${label}: ${typeof description === 'string' ? description : JSON.stringify(description)}`;
      return `| ${escape(shown)} | ${(probability * 100).toFixed(1)}% |`;
    }).join('\n');
    return `### ${escape(id)}\n\n${answer.type === 'choice' ? 'Choice' : 'Score'}: **${result}** · Confidence: ${(answer.confidence * 100).toFixed(1)}%\n\n| ${answer.type === 'score' ? 'Level' : 'Option'} | Probability |\n| --- | ---: |\n${rows}`;
  }).join('\n\n');
}

export async function executeDecisionTurn(ctx, { decisions, storage, selection }) {
  const user = ctx.startMessage('user', 'text');
  ctx.appendText(user, ctx.run.prompt); ctx.finishMessage(user, 'complete');
  storage.insertItem({ sessionId: ctx.run.sessionId, runId: ctx.run.id, kind: 'user_message', groupId: newId('grp'), payload: { text: ctx.run.prompt }, messageId: user });
  if (ctx.run.attachments?.length) throw new ProtocolError('invalid_params', 'Decision models accept text or JSON state. Include your input in state instead of attaching files.');
  let request;
  try { request = DirectDecisionRequest.parse(JSON.parse(ctx.run.prompt.replace(/^\s*```(?:json)?\s*\n([\s\S]*?)\n```\s*$/, '$1'))); }
  catch { throw new ProtocolError('invalid_params', 'Enter a JSON decision request with state and questions. Questions use type noul, choice, or score, with instructions and criteria. Use the example in the composer to start.'); }
  ctx.transition('model');
  const reply = await decisions.request(request, { preset: selection.preset, model: selection.model }, ctx.signal, selection);
  ctx.signal.throwIfAborted();
  const message = ctx.startMessage('assistant', 'text');
  ctx.appendText(message, formatDecisionReply(reply)); ctx.finishMessage(message, 'complete');
  storage.insertItem({ sessionId: ctx.run.sessionId, runId: ctx.run.id, kind: 'assistant_message', groupId: newId('grp'), payload: { text: formatDecisionReply(reply) }, messageId: message });
  const usage = { inputTokens: reply.usage?.input_tokens ?? 0, outputTokens: reply.usage?.output_tokens ?? 0, iterations: 1, attempts: 1 };
  storage.updateRunUsage(ctx.run.id, usage);
  storage.appendEvent({ sessionId: ctx.run.sessionId, runId: ctx.run.id, type: 'run.usage', payload: usage });
  return { outcome: 'completed' };
}
