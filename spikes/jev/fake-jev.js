// Probe support: a local stand-in for TypeSafe's POST /v1/systemone, so jev-spike.js can be
// exercised without a live key. Answers are deterministic, not intelligent; the point is that the
// response obeys the documented contract so the spike's validation is genuinely tested.
const port = Number(Bun.argv[2] ?? 8787);

/** Mirror the answer shape the SDK validates: one answer per question, typed to match. */
function answer(question) {
  if (question.type === 'noul') return { type: 'noul', noul: 0.82 };
  if (question.type === 'choice') {
    const keys = Object.keys(question.criteria);
    const probabilities = Object.fromEntries(keys.map((k, i) => [k, i === 0 ? 0.7 : 0.3 / (keys.length - 1 || 1)]));
    return { type: 'choice', choice: keys[0], confidence: 0.7, probabilities };
  }
  const levels = question.criteria.length;
  const probabilities = Object.fromEntries(question.criteria.map((_, i) => [String(i), i === 1 ? 0.6 : 0.4 / (levels - 1 || 1)]));
  return { type: 'score', score: 1, legend: question.criteria[1], confidence: 0.6, probabilities };
}

const server = Bun.serve({
  port,
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname !== '/v1/systemone') return Response.json({ error: { message: `not found: ${pathname}` } }, { status: 404 });
    if (!request.headers.get('authorization')?.startsWith('Bearer ')) {
      return Response.json({ error: { message: 'missing bearer credential' } }, { status: 401 });
    }
    const body = await request.json();
    const questions = body?.questions ?? {};
    const answers = Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, answer(q)]));
    return Response.json({
      model: body?.model ?? 'jev-latest',
      usage: { input_tokens: JSON.stringify(body).length >> 2, output_tokens: 0 },
      answers,
    });
  },
});
console.log(`fake jev listening on http://localhost:${server.port}`);
