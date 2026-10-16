import { expect, test } from 'bun:test';
import { createHostedTurn } from '../src/agents/hosted.js';

function fixture() {
  const messages = new Map();
  const events = [];
  const turn = createHostedTurn({
    ctx: {
      run: { id: 'run', prompt: 'test' }, signal: new AbortController().signal,
      startMessage: (role, kind) => {
        const id = String(messages.size);
        messages.set(id, { role, kind, text: '', status: 'streaming' });
        return id;
      },
      appendText: (id, text) => { messages.get(id).text += text; },
      finishMessage: (id, status) => { messages.get(id).status = status; },
    },
    storage: {
      transaction: fn => fn(), insertInvocation: () => ({ id: 'invocation' }),
      appendEvent: event => events.push(event), updateInvocation() {}, updateRunUsage() {}, setRunVerification() {},
    },
    permissions: { grantEdit() {} }, manifest: { id: 'codex' }, session: { id: 'session' }, workspace: { id: 'workspace' },
  });
  const start = (callId = 'tool') => {
    const id = turn.toolStarted({ callId, name: 'command', input: {}, display: 'npm test' });
    return messages.get(id);
  };
  const completed = () => events.find(event => event.type === 'tool.completed')?.payload;
  return { turn, start, completed };
}

test('hosted output streams its head and saves the latest tail before the final status', () => {
  const { turn, start, completed } = fixture();
  const message = start();
  const head = 'H'.repeat(2048);
  const tail = 'T'.repeat(2043) + 'FAIL\n';
  turn.toolOutput('tool', head);
  expect(message.text).toBe(`npm test\n${head}`);
  turn.toolOutput('tool', 'middle'.repeat(1000));
  turn.toolOutput('tool', 'old tail'.repeat(500));
  turn.toolOutput('tool', tail);
  expect(message.text).toBe(`npm test\n${head}`);
  turn.toolFinished('tool', { text: 'exit 1', isError: true });
  expect(message.text).toBe(`npm test\n${head}\n[... 10000 bytes omitted ...]\n${tail}exit 1\n`);
  expect(message.status).toBe('complete');
  expect(completed()).toMatchObject({ resultBytes: 14096 + 6, truncated: true, status: 'error' });
});

test('output up to 4 KiB is preserved exactly once regardless of chunk boundaries', () => {
  for (const length of [0, 1, 2047, 2048, 2049, 4095, 4096, 4097, 12000]) {
    const output = Array.from({ length }, (_, i) => String(i % 10)).join('');
    for (const chunkSize of [1, 137, 2048, 100000]) {
      const { turn, start, completed } = fixture();
      const message = start();
      for (let offset = 0; offset < output.length; offset += chunkSize) turn.toolOutput('tool', output.slice(offset, offset + chunkSize));
      turn.toolFinished('tool');
      const expected = length <= 4096 ? output : `${output.slice(0, 2048)}\n[... ${length - 4096} bytes omitted ...]\n${output.slice(-2048)}`;
      expect(message.text).toBe(`npm test\n${expected}`);
      expect(completed()).toMatchObject({ resultBytes: length, truncated: length > 4096 });
    }
  }
});

test('Unicode clipping respects bytes and keeps complete characters at both ends', () => {
  const output = 'a'.repeat(2047) + '🙂' + '中'.repeat(2000) + '🙂' + 'z'.repeat(2047);
  for (const chunks of [[output], Array.from(output)]) {
    const { turn, start, completed } = fixture();
    const message = start();
    for (const chunk of chunks) turn.toolOutput('tool', chunk);
    turn.toolFinished('tool');
    expect(message.text).toBe(`npm test\n${'a'.repeat(2047)}\n[... 6008 bytes omitted ...]\n${'z'.repeat(2047)}`);
    expect(message.text).not.toContain('�');
    expect(completed()).toMatchObject({ resultBytes: Buffer.byteLength(output), truncated: true });
  }
});

test('a character crossing the 2 KiB boundary does not truncate short output', () => {
  for (const output of ['a'.repeat(2047) + '🙂' + 'z'.repeat(2045), '中'.repeat(1365)]) {
    for (const chunks of [[output], Array.from(output)]) {
      const { turn, start, completed } = fixture();
      const message = start();
      for (const chunk of chunks) turn.toolOutput('tool', chunk);
      turn.toolFinished('tool');
      expect(message.text).toBe(`npm test\n${output}`);
      expect(completed()).toMatchObject({ resultBytes: Buffer.byteLength(output), truncated: false });
    }
  }
});

test('interruption saves each open tool tail and never flushes a completed tool twice', () => {
  const { turn, start } = fixture();
  const first = start('first');
  const second = start('second');
  const third = start('third');
  turn.toolOutput('first', 'A'.repeat(5000));
  turn.toolOutput('second', 'B'.repeat(5000));
  turn.toolOutput('third', 'done');
  turn.toolFinished('third');
  turn.finish({ usage: {} });
  turn.finish({ usage: {} });
  for (const [message, character] of [[first, 'A'], [second, 'B']]) {
    expect(message.text).toBe(`npm test\n${character.repeat(2048)}\n[... 904 bytes omitted ...]\n${character.repeat(2048)}`);
    expect(message.status).toBe('interrupted');
  }
  expect(third).toMatchObject({ text: 'npm test\ndone', status: 'complete' });
});
