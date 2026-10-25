import { CHAT_BYTES, validChat } from '../../../packages/protocol/src/chat-sync.js';
import { formValue, hashToken, randomToken, readForm } from './security.js';
import { appPage, escapeHTML as e } from './pages.js';
import { renderMarkdown } from './tasks/markdown.js';
import { chatsPage } from './chat-pages.js';

const redirect = path => new Response(null, { status: 303, headers: { Location: path } });
const transcript = (chat, link = false) => `${chat.context ? `<p class="fine">Project: ${link ? `<a href="/chats?project=${e(chat.context.project.id)}">${e(chat.context.project.name)}</a>` : e(chat.context.project.name)} · Folder: ${e(chat.context.workspace.name)}${chat.context.workspace.branch ? ` · Branch: <code>${e(chat.context.workspace.branch)}</code>` : ''}</p>` : ''}${chat.messages.map(m => `<article class="synced-message"><p class="fine">${e(m.role === 'user' ? 'You' : 'Assistant')}</p><div class="markdown-body">${renderMarkdown(m.text)}</div></article>`).join('')}`;

export function chatRoutes({ env, config, repository, session, prompts }) {
  const db = env.ACCESS_DB;
  return async request => {
    const url = new URL(request.url), api = url.pathname.startsWith('/api/chats');
    if (!/^\/(?:(?:api\/)?chats|shared)(?:\/|$)/.test(url.pathname)) return null;
    // Anyone holding the token can read a shared chat; the database stores only its hash.
    if (url.pathname.startsWith('/shared/')) {
      const shared = /^\/shared\/([a-f0-9]{64})$/.exec(url.pathname);
      if (!shared || request.method !== 'GET') return new Response(appPage('Shared chat', '<h1>Chat not found</h1><p class="fine">This link was removed or is incorrect.</p>', { publicPage: true }), { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      const row = await db.prepare('SELECT content FROM synced_chats WHERE share_token=?1').bind(await hashToken(shared[1])).first();
      if (!row) return new Response(appPage('Shared chat', '<h1>Chat not found</h1><p class="fine">This link was removed or is incorrect.</p>', { publicPage: true }), { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      const chat = JSON.parse(row.content);
      return new Response(appPage(chat.title, `<h1>${e(chat.title)}</h1><p class="fine">Shared conversation · Files and running agents stay on the owner’s device.</p>${transcript(chat)}<p class="fine">Made with <a href="https://jolo.build">Jolo</a> — a workspace for coding agents.</p>`, { publicPage: true, kind: 'shared-chat-page' }), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
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
      const context = body.chat.version === 2 ? { project: { id: body.chat.context.project.id, name: body.chat.context.project.name }, workspace: { id: body.chat.context.workspace.id, name: body.chat.context.workspace.name, mode: body.chat.context.workspace.mode, branch: body.chat.context.workspace.branch } } : null;
      const content = JSON.stringify({ version: body.chat.version, title: body.chat.title, messages: body.chat.messages.map(({role,text}) => ({role,text})), ...(context ? { context } : {}) });
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
    const action = url.pathname.split('/')[api ? 4 : 3];
    if (request.method === 'POST' && !api && id && (action === 'share' || action === 'unshare')) {
      if (request.headers.get('origin') !== config.origin) return Response.json({ error: 'Bad origin.' }, { status: 403 });
      const form = await readForm(request);
      if (formValue(form, 'csrf') !== actor.csrf) return Response.json({ error: 'Your form session changed. Reload the page.' }, { status: 403 });
      const existing = await db.prepare('SELECT share_token FROM synced_chats WHERE account_id=?1 AND id=?2').bind(actor.id, id).first();
      if (!existing) return Response.json({ error: 'Chat not found.' }, { status: 404 });
      if (action === 'unshare') {
        await db.prepare('UPDATE synced_chats SET share_token=NULL, shared_at=NULL WHERE account_id=?1 AND id=?2').bind(actor.id, id).run();
        return redirect(`/chats/${id}`);
      }
      // Sharing is idempotent: an already-shared chat keeps its link until it is unshared.
      if (existing.share_token) return redirect(`/chats/${id}`);
      const token = randomToken();
      await db.prepare('UPDATE synced_chats SET share_token=?3, shared_at=?4 WHERE account_id=?1 AND id=?2').bind(actor.id, id, await hashToken(token), Date.now()).run();
      return redirect(`/chats/${id}?share=${token}`);
    }
    if (request.method !== 'GET') return Response.json({ error: 'Method not allowed.' }, { status: 405 });
    if (id) {
      const row = await db.prepare('SELECT content,revision,share_token,folder_id FROM synced_chats WHERE account_id=?1 AND id=?2').bind(actor.id,id).first();
      if (!row) return Response.json({ error: 'Chat not found.' }, { status: 404 });
      const chat = JSON.parse(row.content);
      if (api) return Response.json({ chat, revision: row.revision, shared: Boolean(row.share_token) });
      // The raw token is shown once, right after creation — only its hash is stored. A param
      // that does not match the stored hash (a stale bookmark) renders no link at all.
      const candidate = url.searchParams.get('share') ?? '';
      const fresh = /^[a-f0-9]{64}$/i.test(candidate) && await hashToken(candidate) === row.share_token ? candidate : null;
      const shareBlock = row.share_token
        ? `<div class="chat-share"><p class="fine">Anyone with the link can read this conversation.${fresh ? ` <code class="chat-share-link">${e(`${config.origin}/shared/${fresh}`)}</code>` : ''}</p><form method="post" action="/chats/${e(id)}/unshare"><input type="hidden" name="csrf" value="${e(actor.csrf)}"><button class="button secondary" type="submit">Stop sharing</button></form></div>`
        : `<div class="chat-share"><form method="post" action="/chats/${e(id)}/share"><input type="hidden" name="csrf" value="${e(actor.csrf)}"><button class="button secondary" type="submit">Share a read-only link</button></form><p class="fine">Creates a public link anyone can open — nothing else on your account is shared.</p></div>`;
      const panel = await prompts.chatPanel(actor, { id, folderId: row.folder_id, error: url.searchParams.get('prompt_error') });
      return new Response(appPage(chat.title, `<h1>${e(chat.title)}</h1><p class="fine">Synced conversation · Files and running agents remain on the original device.</p>${shareBlock}${transcript(chat, true)}${panel.html}`, { active: 'chats', kind: 'synced-chats-page', refresh: panel.refresh ? 4 : 0 }), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    if (!api) {
      const query = (url.searchParams.get('q') ?? '').trim().slice(0, 200);
      const before = url.searchParams.get('before') ?? '';
      const cursor = /^(\d{1,16}):([a-f0-9-]{36})$/.exec(before);
      const timestamp = cursor ? Number(cursor[1]) : null;
      if (before && (!cursor || !Number.isSafeInteger(timestamp))) return Response.json({ error: 'Invalid chat cursor.' }, { status: 400 });
      const projectId = url.searchParams.get('project') ?? '';
      if (projectId && projectId !== 'none' && !/^[a-f0-9-]{36}$/.test(projectId)) return Response.json({ error: 'Invalid project.' }, { status: 400 });
      const page = body => new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      if (!projectId && !query && !before) {
        // With one max() aggregate SQLite takes bare columns from that row: the latest project name.
        const projects = (await db.prepare(`SELECT project_id AS id, project_name AS name, max(updated_at) AS updated_at, count(*) AS chat_count,
          (SELECT group_concat(name, char(10)) FROM (SELECT DISTINCT folder_name AS name FROM synced_chats WHERE account_id=?1 AND project_id=p.project_id)) AS folder_names
          FROM synced_chats p WHERE account_id=?1 AND project_id IS NOT NULL GROUP BY project_id ORDER BY updated_at DESC`).bind(actor.id).all()).results;
        // Accounts with no project chats keep the single dated list instead of one lone group.
        if (projects.length) {
          const unfiled = await db.prepare('SELECT count(*) AS chat_count, max(updated_at) AS updated_at FROM synced_chats WHERE account_id=?1 AND project_id IS NULL').bind(actor.id).first();
          return page(chatsPage({ projects, unfiled, total: projects.reduce((sum, p) => sum + p.chat_count, unfiled.chat_count) }));
        }
      }
      const filter = `account_id=?1 AND (?2='' OR instr(lower(title),lower(?2))>0) AND (?5='' OR (?5='none' AND project_id IS NULL) OR project_id=?5)`;
      const rows = (await db.prepare(`SELECT id,title,updated_at,json_array_length(content,'$.messages') AS message_count,project_name,folder_id,folder_name,folder_branch
        FROM synced_chats WHERE ${filter}
        AND (?3 IS NULL OR updated_at<?3 OR (updated_at=?3 AND id<?4))
        ORDER BY updated_at DESC,id DESC LIMIT 51`).bind(actor.id,query,timestamp,cursor?.[2] ?? '',projectId).all()).results;
      const count = await db.prepare(`SELECT count(*) AS total FROM synced_chats WHERE ${filter}`).bind(actor.id,query,null,null,projectId).first();
      const project = projectId === 'none' ? { id: 'none' } : projectId
        ? { id: projectId, name: (await db.prepare('SELECT project_name AS name FROM synced_chats WHERE account_id=?1 AND project_id=?2 ORDER BY updated_at DESC LIMIT 1').bind(actor.id,projectId).first())?.name ?? 'Project' }
        : null;
      const chats = rows.slice(0,50), last = chats.at(-1);
      const next = rows.length > 50 ? `${last.updated_at}:${last.id}` : null;
      const folders = project && project.id !== 'none' && !query && !before
        ? (await db.prepare('SELECT folder_id AS id, folder_name AS name, folder_branch AS branch, max(updated_at) FROM synced_chats WHERE account_id=?1 AND project_id=?2 GROUP BY folder_id ORDER BY max(updated_at) DESC').bind(actor.id,projectId).all()).results : [];
      const start = await prompts.projectPanel(actor, folders, url.searchParams.get('prompt_error'));
      return page(chatsPage({ chats, total: count.total, query, next, before, project, start }));
    }
    const after = url.searchParams.get('after') ?? '';
    const rows = (await db.prepare('SELECT id,title,revision,updated_at FROM synced_chats WHERE account_id=?1 AND id>?2 ORDER BY id LIMIT 51').bind(actor.id,after.slice(0,36)).all()).results;
    const chats = rows.slice(0,50), next = rows.length > 50 ? chats.at(-1).id : null;
    return Response.json({ chats, next });
  };
}
