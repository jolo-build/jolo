import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { runAccountCommand } from './account.js';

const signedOut = { state: 'signed_out', origin: 'https://access.jolo.build', account: null, device: null, pending: null, source: 'none', note: null };
const pending = { ...signedOut, state: 'pending', pending: { userCode: 'ABCD-EFGH', verificationUriComplete: 'https://access.jolo.build/device?user_code=ABCD-EFGH' } };
const signedIn = { ...signedOut, state: 'signed_in', account: { name: 'Developer', email: 'dev@example.com' }, source: 'keychain' };

test('CLI displays the approval code, opens the browser, and waits for engine status', async () => {
  const calls = [], output = [], opened = [];
  let reads = 0;
  const client = { call: async (method, params) => { calls.push({ method, params }); return method === 'account.login' ? pending : ++reads === 1 ? signedOut : signedIn; } };
  const code = await runAccountCommand({ command: 'login', flags: { server: 'http://127.0.0.1:8788' }, client, write: line => output.push(line), openBrowser: async url => opened.push(url), sleep: async () => {}, signals: new EventEmitter() });
  expect(code).toBe(0); expect(opened).toEqual([pending.pending.verificationUriComplete]);
  expect(output[0]).toContain('ABCD-EFGH'); expect(output.at(-1)).toContain('dev@example.com');
  expect(calls.find(call => call.method === 'account.login').params.origin).toBe('http://127.0.0.1:8788');
});

test('CLI JSON login avoids browser opening and Ctrl+C cancels the engine flow', async () => {
  const signals = new EventEmitter(), calls = [], output = [];
  const client = { call: async method => { calls.push(method); return method === 'account.login' ? pending : signedOut; } };
  const code = await runAccountCommand({ command: 'login', flags: { json: true }, client, signals, write: line => output.push(JSON.parse(line)), openBrowser: async () => { throw new Error('must not open'); }, sleep: async () => signals.emit('SIGINT') });
  expect(code).toBe(130); expect(calls).toContain('account.cancel');
  expect(output.map(item => item.type)).toEqual(['account.pending', 'account.cancelled']);
  expect(signals.listenerCount('SIGINT')).toBe(0);
});

test('CLI whoami refreshes account status and logout reports local-only revocation', async () => {
  const output = [], calls = [];
  const client = { call: async (method, params) => { calls.push({ method, params }); return method === 'account.status' ? signedIn : { ...signedOut, note: 'Signed out locally.' }; } };
  await runAccountCommand({ command: 'whoami', flags: { json: true }, client, write: line => output.push(line) });
  expect(calls[0]).toEqual({ method: 'account.status', params: { refresh: true } });
  expect(JSON.parse(output[0]).account.email).toBe('dev@example.com');
  await runAccountCommand({ command: 'logout', flags: {}, client, write: line => output.push(line) });
  expect(output.at(-1)).toBe('Signed out locally.');
});
