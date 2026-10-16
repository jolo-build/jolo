import { DirectDecisionRequest, DirectDecisionReply, validateDecisionAnswers } from "../decisions/direct.js";
import { ProtocolError } from '@jolo/protocol';
import { boundedText, requestHeaders, redact } from './transport.js';

export const isDecisionProtocol = protocol => protocol === 'openrouter-decisions' || protocol === 'typesafe';

export class InvalidDecisionResponse extends Error {
  constructor(message, usage = null) {
    super(message);
    this.usage = usage;
  }
}

/** @param {{ settings: any, providers: any, credentials: any, fetchImpl?: import('./transport.js').FetchLike }} options */
export function createDecisionService({ settings, providers, credentials, fetchImpl = fetch }) {
  return {
    async request(payload, ref, signal, endpoint = null) {
      payload = DirectDecisionRequest.parse(payload);
      const config = settings.get();
      if (!ref) throw new ProtocolError('unavailable', 'Choose a model for this chat first.');
      const preset = endpoint ?? providers.preset(ref.preset, config);
      const native = preset.protocol === 'typesafe';
      if (!native && preset.listing !== 'openrouter') throw new ProtocolError('unavailable', 'Decision models require TypeSafe or OpenRouter');
      const credential = preset.auth.kind === 'none' ? null : await credentials.get(ref.preset);
      if (preset.auth.kind !== 'none' && !credential) throw new ProtocolError('unavailable', `No credential for ${ref.preset}`);
      const maxChoices = preset.decisionLimits?.maxChoices;
      if (maxChoices) for (const [id, question] of Object.entries(payload.questions)) {
        const count = question.type === 'choice' ? Object.keys(question.criteria).length : question.type === 'score' ? question.criteria.length : 0;
        if (count > maxChoices) throw new ProtocolError('invalid_params', `${preset.displayName} supports at most ${maxChoices} choices in question ${id}`);
      }
      // Each transport stays on its configured origin, including custom endpoints.
      const base = preset.baseUrl.replace(/\/+$/, '');
      const url = native ? `${base}/systemone` : `${base.replace(/\/v1$/, '')}/alpha/decisions`;
      const combined = AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(30_000)]);
      try {
        const response = await fetchImpl(url, {
          method: 'POST', headers: requestHeaders({ ...preset, apiKey: credential?.value }), signal: combined, redirect: 'error',
          body: JSON.stringify({ ...payload, model: ref.model }),
        });
        const text = await boundedText(response, 64 * 1024);
        if (!response.ok) throw new Error(`Decision provider returned HTTP ${response.status}`);
        let body;
        try { body = JSON.parse(text); }
        catch { throw new InvalidDecisionResponse('Decision provider returned invalid JSON'); }
        const parsed = DirectDecisionReply.safeParse(body);
        if (!parsed.success) throw new InvalidDecisionResponse('Decision provider returned an invalid response');
        try { validateDecisionAnswers(payload, parsed.data); }
        catch (error) { throw new InvalidDecisionResponse(error.message, parsed.data.usage); }
        return parsed.data;
      } catch (error) {
        if (signal?.aborted) throw new ProtocolError('interrupted', 'Decision request cancelled');
        if (error instanceof InvalidDecisionResponse && !combined.aborted) throw error;
        throw new ProtocolError('unavailable', combined.aborted ? 'Decision request timed out after 30 seconds' : redact(error.message, credential?.value));
      }
    },
  };
}
