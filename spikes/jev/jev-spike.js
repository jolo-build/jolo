// Probe: call TypeSafe's Jev once and check the answer obeys the documented contract.
// Jev is an evaluation model, not a chat model: it takes { state, questions } and returns one typed
// answer per question (Choice, Score, or Noul). It cannot generate free text, so it is deliberately
// NOT wired into the engine's provider harness here — this only proves a credential and the shape.
//
//   bun spikes/jev/jev-spike.js --provider openrouter --key-file /tmp/openrouter.key
//   bun spikes/jev/jev-spike.js --provider typesafe --key-file /tmp/typesafe.key
//   bun spikes/jev/jev-spike.js --base-url http://localhost:8787 --key-file /tmp/any.key
//
// Credential: --key-file <path>, else the provider's environment variable. The key is never printed,
// and is redacted from any error text before it reaches stdout.

// Two hosts serve Jev with the same request and answer shape; only the route, slug, and key differ.
const PROVIDERS = {
  typesafe: { baseUrl: 'https://api.typesafe.ai', path: '/v1/systemone', model: 'jev-latest', env: 'TYPESAFE_API_KEY' },
  openrouter: { baseUrl: 'https://openrouter.ai', path: '/api/alpha/decisions', model: '~typesafe/jev-latest', env: 'OPENROUTER_API_KEY' },
};

const args = Bun.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };

const providerName = flag('--provider') ?? 'typesafe';
const provider = PROVIDERS[providerName];
if (!provider) {
  console.error(`Unknown --provider ${providerName}; use ${Object.keys(PROVIDERS).join(' or ')}.`);
  process.exit(2);
}
const baseUrl = (flag('--base-url') ?? provider.baseUrl).replace(/\/+$/, '');
const url = `${baseUrl}${flag('--path') ?? provider.path}`;
const model = flag('--model') ?? provider.model;
const keyFile = flag('--key-file');
const apiKey = (keyFile ? await Bun.file(keyFile).text() : process.env[provider.env] ?? '').trim();
if (!apiKey) {
  console.error(`No credential. Pass --key-file <path> or set ${provider.env}.`);
  process.exit(2);
}
const redact = text => apiKey ? String(text).replaceAll(apiKey, '<redacted>') : String(text);

// One request exercising all three primitives, over a state shaped like something Jolo would ask about.
const state = {
  request: 'Rename the retry helper and drop its jitter.',
  diff: 'apps/engine/src/providers/retry.js: -export function backoff(attempt, jitter)\n+export function delay(attempt)',
  tests: 'no test file touched',
};
const questions = {
  risk: {
    type: 'choice',
    instructions: 'How risky is landing this change as-is?',
    criteria: { low: 'behaviour preserved', medium: 'observable change, covered', high: 'behaviour change with no test' },
  },
  coverage: {
    type: 'score',
    instructions: 'Rate how well the change is covered by tests.',
    criteria: ['uncovered', 'partially covered', 'well covered'],
  },
  needs_review: { type: 'noul', instructions: 'Should a human review this before merge?' },
};

const probability = v => Number.isFinite(v) && v >= 0 && v <= 1;

/** Reject any answer that does not match its question, mirroring what the official SDK enforces. */
function problems(result) {
  const found = [];
  if (typeof result?.model !== 'string' || !result.model) found.push('missing model');
  for (const field of ['input_tokens', 'output_tokens']) {
    const count = result?.usage?.[field];
    if (!Number.isSafeInteger(count) || count < 0) found.push(`usage.${field} is not a count`);
  }
  const answers = result?.answers ?? {};
  if (Object.keys(answers).length !== Object.keys(questions).length) found.push('answer count does not match question count');
  for (const [id, question] of Object.entries(questions)) {
    const answer = answers[id];
    if (!answer) { found.push(`${id}: no answer`); continue; }
    if (answer.type !== question.type) { found.push(`${id}: type ${answer.type} != ${question.type}`); continue; }
    if (answer.type === 'noul') {
      if (!probability(answer.noul)) found.push(`${id}: noul not a probability`);
      continue;
    }
    if (!probability(answer.confidence)) found.push(`${id}: confidence not a probability`);
    const keys = question.type === 'choice' ? Object.keys(question.criteria) : question.criteria.map((_, i) => String(i));
    const given = Object.entries(answer.probabilities ?? {});
    if (given.length !== keys.length || keys.some(k => !probability(answer.probabilities?.[k]))) {
      found.push(`${id}: probabilities do not cover every option`);
    }
    if (answer.type === 'choice' && !keys.includes(answer.choice)) found.push(`${id}: choice ${answer.choice} is not an option`);
    if (answer.type === 'score') {
      // Score is an expected value over the levels, so a fraction between two levels is normal.
      if (!Number.isFinite(answer.score) || answer.score < 0 || answer.score > keys.length - 1) found.push(`${id}: score out of range`);
      if (!answer.legend) found.push(`${id}: score has no legend`);
    }
  }
  return found;
}

const started = performance.now();
let response;
try {
  response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, state, questions }),
    signal: AbortSignal.timeout(30_000),
  });
} catch (error) {
  console.error(`request failed: ${redact(error.message)}`);
  process.exit(1);
}
const elapsedMs = Math.round(performance.now() - started);
const text = await response.text();
if (!response.ok) {
  console.error(`HTTP ${response.status} from ${url} after ${elapsedMs}ms`);
  console.error(redact(text).slice(0, 600));
  process.exit(1);
}

let result;
try { result = JSON.parse(text); }
catch { console.error(`response was not JSON: ${redact(text).slice(0, 300)}`); process.exit(1); }

const found = problems(result);
console.log(JSON.stringify({ url, model: result.model, elapsedMs, usage: result.usage, answers: result.answers }, null, 1));
if (found.length) {
  console.error(`\ncontract violations:\n${found.map(p => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
const input = result.usage?.input_tokens ?? 0;
// OpenRouter reports the billed cost; TypeSafe does not, so fall back to its list price.
const cost = result.usage?.cost ?? input * 0.042 / 1e6;
console.log(`\nOK: ${Object.keys(result.answers).length} answers matched their questions; ${input} input tokens, $${cost.toFixed(6)}.`);
