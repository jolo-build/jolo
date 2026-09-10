import { expect, test } from 'bun:test';
import { openSession, startEngine, tempHome, removeHome, waitFor } from './helpers.js';

// Explicit opt-in only. Models are supplied by the caller, never a dated vendor list.
const presets = (process.env.JOLO_LIVE_PROVIDERS ?? '').split(',').map(p => p.trim()).filter(Boolean);
if (!presets.length) test.skip('live provider tool turns (set JOLO_LIVE_PROVIDERS and JOLO_LIVE_MODEL_<PRESET>)', () => {});
for (const preset of presets) test(`live ${preset} uses a real model and one read tool`, async () => {
  const model = process.env[`JOLO_LIVE_MODEL_${preset.toUpperCase().replaceAll('-', '_')}`];
  if (!model) throw new Error(`Set JOLO_LIVE_MODEL_${preset.toUpperCase().replaceAll('-', '_')} to the model ID to test`);
  const home = tempHome(); let engine, client;
  try {
    engine = await startEngine({ home, env: { JOLO_CREDENTIALS: 'session' } }); client = await engine.connect();
    await client.call('settings.update', { model: { preset, model }, budgets: { maxIterations: 3, maxActiveMs: 60000 } });
    const { session } = await openSession(client, home);
    const { run } = await client.call('run.start', { sessionId: session.id, requestId: 'live', prompt: 'Call list_files on the current directory once, then briefly report the result. Do not modify any files or execute commands.' });
    const result = await waitFor(async () => { const result = await client.call('run.snapshot', { runId: run.id }); return ['completed', 'failed', 'paused'].includes(result.run.state) && result; }, { timeoutMs: 65000, label: 'live provider response' });
    expect(result.run.state).toBe('completed');
    expect(result.messages.some(m => m.role === 'tool')).toBe(true);
  } finally { await client?.close(); await engine?.stop(); removeHome(home); }
}, 80000);
