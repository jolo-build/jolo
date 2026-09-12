import { expect, test } from 'bun:test';
import { fixture } from './fixture.js';
import { createRepository } from '../src/storage.js';

function seed(f, { count = 1, account = f.sqlite.query('SELECT id FROM accounts').get().id, title = n => `Conversation ${n}`, at = n => 1700000000000 + n } = {}) {
  for (let n = 1; n <= count; n++) {
    const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const content = JSON.stringify({ version: 1, title: title(n), messages: [{ role: 'user', text: 'Hello' }, { role: 'assistant', text: 'Hi' }] });
    f.sqlite.query('INSERT INTO synced_chats (account_id,id,revision,title,content,updated_at) VALUES (?,?,1,?,?,?)').run(account, id, title(n), content, at(n));
  }
}

test('chat history orders by last sync, paginates ties, and isolates accounts', async () => {
  const f = fixture(); await f.login();
  const account = f.sqlite.query('SELECT id FROM accounts').get().id;
  seed(f, { count: 53, at: () => 1700000000000 });
  const other = await createRepository(f.db, f.now).account({ id: 'other', name: 'Other', email: 'other@example.com' });
  seed(f, { account: other.id, title: () => 'Other account secret' });
  const html = await (await f.send('/chats')).text();
  expect(html).toContain('53 synced chats');
  expect(html).not.toContain('Other account secret');
  expect(html).toContain('2 messages');
  const ids = [...html.matchAll(/class="chat-row" href="\/chats\/([a-f0-9-]+)"/g)].map(match => match[1]);
  expect(ids).toHaveLength(50);
  expect(ids[0]).toEndWith('000000000053');
  const next = html.match(/href="([^"]+)">Older chats/)[1].replaceAll('&amp;', '&');
  const second = await (await f.send(next)).text();
  const remaining = [...second.matchAll(/class="chat-row" href="\/chats\/([a-f0-9-]+)"/g)].map(match => match[1]);
  expect(remaining).toHaveLength(3);
  expect(new Set([...ids, ...remaining]).size).toBe(53);
  expect(second).toContain('Back to latest');
  expect(second).not.toContain('Older chats');
  f.sqlite.query('UPDATE synced_chats SET updated_at=1800000000000 WHERE account_id=? AND id=?').run(account, remaining.at(-1));
  const refreshed = await (await f.send('/chats')).text();
  expect(refreshed.match(/class="chat-row" href="\/chats\/([a-f0-9-]+)"/)[1]).toBe(remaining.at(-1));
  expect((await f.send('/chats/bad-id')).status).toBe(400);
  expect((await f.send('/chats?before=invalid')).status).toBe(400);
});

test('search covers all titles, treats wildcards literally, and escapes user content', async () => {
  const f = fixture(); await f.login();
  seed(f, { count: 55, title: n => n === 1 ? '<script>alert("x")</script> 100%_done' : `Release ${n}` });
  const html = await (await f.send('/chats?q=100%25_done')).text();
  expect(html).toContain('1 matching chats');
  expect(html).toContain('&lt;script&gt;');
  expect(html).not.toContain('<script>alert');
  expect(html).not.toContain('Release 55');
  const search = await (await f.send('/chats?q=RELEASE')).text();
  expect(search).toContain('54 matching chats');
  const next = search.match(/href="([^"]+)">Older chats/)[1].replaceAll('&amp;', '&');
  expect(next).toContain('q=RELEASE');
  const second = await (await f.send(next)).text();
  expect(second.match(/class="chat-row"/g)).toHaveLength(4);
  expect(await (await f.send('/chats?q=unmatched')).text()).toContain('No matching chats');
});

test('empty history explains sync and chat links open readable conversations', async () => {
  const f = fixture();
  expect((await f.send('/chats')).status).toBe(303);
  await f.login();
  expect(await (await f.send('/chats')).text()).toContain('Your conversations, in one place');
  seed(f);
  const detail = await f.send('/chats/00000000-0000-4000-8000-000000000001');
  expect(detail.status).toBe(200);
  expect(await detail.text()).toContain('Hello');
});
