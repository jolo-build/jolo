import { CHAT_BYTES, validChat } from '../../../packages/protocol/src/chat-sync.js';
import { hashToken } from './security.js';
import { appPage, escapeHTML as e } from './pages.js';
import { renderMarkdown } from './tasks/markdown.js';
import { chatsPage } from './chat-pages.js';

export function chatRoutes({ env, repository, session }) {
  const db = env.ACCESS_DB;
  return async request => {
    const url = new URL(request.url), api = url.pathname.startsWith('/api/chats');
    if (!/^\/(api\/)?chats(?:\/|$)/.test(url.pathname)) return null;
    const match = /^Bearer ([a-f0-9]{64})$/i.exec(request.headers.get('authorization') ?? '');
    const actor = api ? match && await repository.getDevice(await hashToken(match[1])) : await session(request);
    if (!actor) return api ? Response.json({ error: 'Sign in to Jolo.' }, { status: 401 }) : new Response(null, { status: 303, headers: { Location: '/' } });
    if (api && !actor.scope.split(' ').includes('chats:sync')) return Response.json({ error: 'Approve chat sync for this device.' }, { status: 403 });
    const id = url.pathname.split('/')[api ? 3 : 2];
    if (id && !/^[a-f0-9-]{36}$/.test(id)) return Response.json({ error: 'Invalid chat ID.' }, { status: 400 });
    if (request.method === 'PUT' && api && id) {
      let body;
      try {
        // Bound the streamed body too; Content-Length is not a trusted limit.
        const reader = request.body?.getReader(); if (!reader) throw new Error();
        let size = 0; const chunks = [];
        while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > CHAT_BYTES + 1024) { await reader.cancel(); throw new Error(); } chunks.push(value); }
        body = JSON.parse(await new Blob(chunks).text());
      } catch { return Response.json({ error: 'Invalid or oversized chat.' }, { status: 400 }); }
      if (!validChat(body.chat) || !Number.isSafeInteger(body.revision) || body.revision < 0) return Response.json({ error: 'Invalid chat.' }, { status: 400 });
      const content = JSON.stringify({ version: 1, title: body.chat.title, messages: body.chat.messages.map(({role,text}) => ({role,text})) });
      const at = Date.now();
      // CAS and quota are in the same SQL statement; stale devices cannot overwrite newer history.
      const result = body.revision === 0
        ? await db.prepare(`INSERT INTO synced_chats (account_id,id,revision,title,content,updated_at)
            SELECT ?1,?2,1,?3,?4,?5 WHERE (SELECT count(*) FROM synced_chats WHERE account_id=?1)<1000
            ON CONFLICT(account_id,id) DO NOTHING RETURNING revision`).bind(actor.id,id,body.chat.title,content,at).first()
        : await db.prepare(`UPDATE synced_chats SET revision=revision+1,title=?3,content=?4,updated_at=?5
            WHERE account_id=?1 AND id=?2 AND revision=?6 RETURNING revision`).bind(actor.id,id,body.chat.title,content,at,body.revision).first();
      return result ? Response.json(result) : Response.json({ error: 'Chat changed on another device or storage limit reached.' }, { status: 409 });
    }
    if (request.method !== 'GET') return Response.json({ error: 'Method not allowed.' }, { status: 405 });
    if (id) {
      const row = await db.prepare('SELECT content,revision FROM synced_chats WHERE account_id=?1 AND id=?2').bind(actor.id,id).first();
      if (!row) return Response.json({ error: 'Chat not found.' }, { status: 404 });
      const chat = JSON.parse(row.content);
      if (api) return Response.json({ chat, revision: row.revision });
      return new Response(appPage(chat.title, `<h1>${e(chat.title)}</h1><p class="fine">Synced conversation · Files and running agents remain on the original device.</p>${chat.messages.map(m=>`<article class="synced-message"><p class="fine">${e(m.role === 'user' ? 'You' : 'Assistant')}</p><div class="markdown-body">${renderMarkdown(m.text)}</div></article>`).join('')}`, { active: 'chats', kind: 'synced-chats-page' }), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    if (!api) {
      const query = (url.searchParams.get('q') ?? '').trim().slice(0, 200);
      const before = url.searchParams.get('before') ?? '';
      const cursor = /^(\d{1,16}):([a-f0-9-]{36})$/.exec(before);
      const timestamp = cursor ? Number(cursor[1]) : null;
      if (before && (!cursor || !Number.isSafeInteger(timestamp))) return Response.json({ error: 'Invalid chat cursor.' }, { status: 400 });
      const rows = (await db.prepare(`SELECT id,title,updated_at,json_array_length(content,'$.messages') AS message_count
        FROM synced_chats WHERE account_id=?1 AND (?2='' OR instr(lower(title),lower(?2))>0)
        AND (?3 IS NULL OR updated_at<?3 OR (updated_at=?3 AND id<?4))
        ORDER BY updated_at DESC,id DESC LIMIT 51`).bind(actor.id,query,timestamp,cursor?.[2] ?? '').all()).results;
      const count = await db.prepare("SELECT count(*) AS total FROM synced_chats WHERE account_id=?1 AND (?2='' OR instr(lower(title),lower(?2))>0)").bind(actor.id,query).first();
      const chats = rows.slice(0,50), last = chats.at(-1);
      const next = rows.length > 50 ? `${last.updated_at}:${last.id}` : null;
      return new Response(chatsPage({ chats, total: count.total, query, next, before }), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    const after = url.searchParams.get('after') ?? '';
    const rows = (await db.prepare('SELECT id,title,revision,updated_at FROM synced_chats WHERE account_id=?1 AND id>?2 ORDER BY id LIMIT 51').bind(actor.id,after.slice(0,36)).all()).results;
    const chats = rows.slice(0,50), next = rows.length > 50 ? chats.at(-1).id : null;
    return Response.json({ chats, next });
  };
}
