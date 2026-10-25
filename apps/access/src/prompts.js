import { appPage, escapeHTML as e } from './pages.js';
import { formValue, hashToken, readForm } from './security.js';
import { ACTIVE_PROMPT, relayFor } from './relay.js';

const UUID = /^[a-f0-9-]{36}$/;
const PROMPT_CHARS = 20_000;
// A full prompt, percent-encoded: up to nine bytes per character for non-Latin text.
const FORM_BYTES = 200 * 1024;
const RATE = 10;
const html = (body, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const redirect = path => new Response(null, { status: 303, headers: { Location: path } });
const ERRORS = {
  text: `Write a prompt of up to ${PROMPT_CHARS.toLocaleString('en-US')} characters.`,
  busy: 'A prompt is already running in this chat. Wait for it to finish or cancel it.',
  rate: 'Too many prompts in the last minute. Wait a moment and send again.',
  offline: 'That device is no longer online. Open Jolo on it and try again.',
  folder: 'Choose a folder on an online device.',
};
const active = status => ACTIVE_PROMPT.includes(status);

function statusLine(prompt) {
  const device = e(prompt.device_name);
  return {
    pending: `Sending to ${device}…`, delivered: `Sending to ${device}…`, accepted: `Starting on ${device}…`, running: `Running on ${device}…`,
    // Without a permission's details the run waits on something else, such as a question Claude Code asked.
    awaiting_permission: prompt.permission ? `Waiting for approval on ${device}.` : `Waiting for an answer on ${device}.`,
    completed: prompt.error ? e(prompt.error) : `Finished on ${device}.`, cancelled: prompt.error ? e(prompt.error) : `Cancelled on ${device}.`,
  }[prompt.status] ?? e(prompt.error || `Did not run on ${prompt.device_name}.`);
}

/** What the run is waiting for, with Allow once / Deny when its device takes answers from the web. */
const waitingOn = prompt => { try { return prompt.status === 'awaiting_permission' && prompt.permission ? JSON.parse(prompt.permission) : null; } catch { return null; } };

function permissionBlock(prompt, csrf, approvals) {
  const request = waitingOn(prompt);
  if (!request) return prompt.status === 'awaiting_permission' ? `<p class="fine">Open Jolo on ${e(prompt.device_name)} to answer.</p>` : '';
  const answer = (decision, label, style) => `<form method="post" action="/prompts/${e(prompt.id)}/permission"><input type="hidden" name="csrf" value="${e(csrf)}"><input type="hidden" name="permission" value="${e(request.id)}"><input type="hidden" name="decision" value="${decision}"><button class="button${style}" type="submit">${label}</button></form>`;
  return `<div class="prompt-permission"><p><strong>${e(request.tool)}</strong> · ${e(request.summary)}</p>${request.command ? `<pre><code>${e(request.command)}</code></pre>` : ''}
    ${!request.complete ? `<p class="fine">This request is too long to review here. Open Jolo on ${e(prompt.device_name)} to allow or deny it.</p>`
      : approvals ? `<div class="prompt-permission-actions">${answer('allow_once', 'Allow once', '')}${answer('deny', 'Deny', ' secondary')}</div><p class="fine">Allowing runs this once on ${e(prompt.device_name)}. Standing permissions can only be granted on the device.</p>`
      : `<p class="fine">Open Jolo on ${e(prompt.device_name)} to allow or deny it, or turn on <strong>Approve from the web</strong> there.</p>`}</div>`;
}

function promptItem(prompt, csrf, { approvals = false } = {}) {
  const text = prompt.text.length > 400 ? `${prompt.text.slice(0, 400)}…` : prompt.text;
  const live = active(prompt.status) ? `<div class="prompt-live" data-live="/prompts/${e(prompt.id)}/live" data-status="${e(prompt.status)}" data-permission="${e(waitingOn(prompt)?.id ?? '')}" aria-live="polite" hidden></div>` : '';
  // A sync conflict can put the reply in a copy of the chat; link it from the original.
  const elsewhere = !active(prompt.status) && prompt.chat_id && prompt.result_chat_id && prompt.result_chat_id !== prompt.chat_id ? `<p class="fine"><a href="/chats/${e(prompt.result_chat_id)}">Open the reply</a>, saved as a copy because the chat changed on another device.</p>` : '';
  return `<li class="prompt-item${active(prompt.status) ? ' active' : ''}"><p class="prompt-text">${e(text)}</p>${live}<div class="prompt-status"><p class="fine" role="status">${statusLine(prompt)}</p>${active(prompt.status) ? `<form method="post" action="/prompts/${e(prompt.id)}/cancel"><input type="hidden" name="csrf" value="${e(csrf)}"><button class="button secondary" type="submit">Cancel</button></form>` : ''}</div>${elsewhere}${permissionBlock(prompt, csrf, approvals)}</li>`;
}

// Updates live text in place and reloads once the status changes; without scripts, pages refresh.
const LIVE_SCRIPT = '<script src="/prompt-live.js" defer></script>';

const composer = ({ action, csrf, targets, error, placeholder }) => `<form class="prompt-composer" method="post" action="${e(action)}"><input type="hidden" name="csrf" value="${e(csrf)}">
  <label class="chats-search-label" for="prompt-text">Prompt</label><textarea id="prompt-text" name="text" rows="3" maxlength="${PROMPT_CHARS}" required placeholder="${e(placeholder)}"></textarea>
  ${error ? `<p class="notice" role="alert">${e(ERRORS[error] ?? ERRORS.offline)}</p>` : ''}
  <div class="prompt-actions">${targets.length > 1 ? `<label class="prompt-target"><span class="chats-search-label">Run on</span><select name="target" aria-label="Run on">${targets.map(t => `<option value="${e(t.value)}">${e(t.label)}</option>`).join('')}</select></label>` : `<input type="hidden" name="target" value="${e(targets[0].value)}"><span class="fine">Runs on ${e(targets[0].label)}</span>`}<button class="button" type="submit">Send</button></div></form>`;

export function promptRoutes({ env, config, repository, session, now }) {
  const db = env.ACCESS_DB;
  // Online sockets alone are not enough: the device must still exist with this scope.
  async function devices(account) {
    const relay = relayFor(env, account.id);
    if (!relay) return [];
    const allowed = new Map((await db.prepare(`SELECT id,name FROM devices WHERE account_id=?1 AND expires_at>?2 AND (' '||scope||' ') LIKE '% prompts:run %'`).bind(account.id, now()).all()).results.map(d => [d.id, d]));
    return (await relay.online()).filter(d => allowed.has(d.id)).map(d => ({ ...d, name: allowed.get(d.id).name }));
  }
  async function expire(account) {
    await db.prepare(`UPDATE remote_prompts SET status='expired', error='The device did not respond.', updated_at=?2 WHERE account_id=?1 AND status IN ('pending','delivered') AND updated_at<=?3`).bind(account.id, now(), now() - 120_000).run();
  }
  async function send(account, { deviceId, deviceName, chatId = null, folderId = null, text }) {
    text = (text ?? '').replace(/\r\n?/g, '\n').trim();
    if (!text || text.length > PROMPT_CHARS) return 'text';
    const id = crypto.randomUUID(), since = now() - 60_000;
    // The rate limit and one active prompt per chat are enforced in the insert itself, so
    // concurrent requests cannot all pass a check made before it.
    const inserted = await db.prepare(`INSERT INTO remote_prompts (id,account_id,device_id,device_name,chat_id,folder_id,text,status,created_at,updated_at)
      SELECT ?1,?2,?3,?4,?5,?6,?7,'pending',?8,?8 WHERE (SELECT count(*) FROM remote_prompts WHERE account_id=?2 AND created_at>?9) < ?10
        AND (?5 IS NULL OR NOT EXISTS (SELECT 1 FROM remote_prompts WHERE account_id=?2 AND chat_id=?5 AND status IN ('pending','delivered','accepted','running','awaiting_permission'))) RETURNING id`)
      .bind(id, account.id, deviceId, deviceName, chatId, folderId, text, now(), since, RATE).first();
    if (!inserted) {
      const recent = await db.prepare('SELECT count(*) AS n FROM remote_prompts WHERE account_id=?1 AND created_at>?2').bind(account.id, since).first();
      return recent.n >= RATE ? 'rate' : 'busy';
    }
    const sent = await relayFor(env, account.id).send(deviceId, { type: 'prompt', id, chatId, folderId, text });
    // The device may already have reported `accepted`; only a still-pending prompt moves here.
    await db.prepare(`UPDATE remote_prompts SET status=?2, error=?3, updated_at=?4 WHERE id=?1 AND status='pending'`).bind(id, sent ? 'delivered' : 'failed', sent ? null : ERRORS.offline, now()).run();
    return sent ? { id } : 'offline';
  }

  /** The "continue from the web" panel under a synced chat, and whether the page should refresh. */
  async function chatPanel(account, chat) {
    if (!env.ACCESS_RELAY) return { html: '', refresh: false };
    await expire(account);
    const prompts = (await db.prepare('SELECT * FROM remote_prompts WHERE account_id=?1 AND chat_id=?2 ORDER BY created_at DESC LIMIT 3').bind(account.id, chat.id).all()).results;
    const running = prompts.some(p => active(p.status)), online = await devices(account);
    const targets = running ? [] : online.filter(d => !chat.folderId || d.folders.includes(chat.folderId)).map(d => ({ value: d.id, label: d.name }));
    const approvals = prompt => online.some(d => d.id === prompt.device_id && d.approvals);
    const body = running ? '' : targets.length ? composer({ action: `/chats/${chat.id}/prompt`, csrf: account.csrf, targets, error: chat.error, placeholder: 'Ask the agent to continue…' })
      : `<p class="fine">To continue here, open Jolo on a device${chat.folderId ? ' that has this folder' : ''} and turn on <strong>Web prompts</strong> in Settings → Account.</p>`;
    return { refresh: running, html: `<section class="chat-continue" id="continue" aria-labelledby="continue-title"><h2 id="continue-title">Continue from the web</h2>${prompts.length ? `<ul class="prompt-list">${prompts.reverse().map(p => promptItem(p, account.csrf, { approvals: approvals(p) })).join('')}</ul>` : ''}${body}${running ? LIVE_SCRIPT : ''}</section>` };
  }

  /** Start a new chat in one of a project's folders on a device that has a checkout of it. */
  async function projectPanel(account, folders, error) {
    if (!env.ACCESS_RELAY || !folders.length) return '';
    const online = await devices(account);
    const targets = folders.flatMap(folder => online.filter(d => d.folders.includes(folder.id)).map(d => ({ value: `${d.id}:${folder.id}`, label: `${folder.name}${folder.branch ? ` (${folder.branch})` : ''} on ${d.name}` })));
    if (!targets.length) return `<p class="fine chat-continue-hint">Open Jolo on a device with one of these folders and turn on <strong>Web prompts</strong> to start a chat from here.</p>`;
    // Collapsed by default so the folder list keeps its room; an error reopens it with the message.
    return `<details class="chat-continue chat-start"${error ? ' open' : ''}><summary><span>Start a chat on a device</span><span class="chats-help-label">${targets.length === 1 ? e(targets[0].label) : `${targets.length} folders online`}</span></summary>${composer({ action: '/prompts', csrf: account.csrf, targets, error, placeholder: 'Describe the task…' })}</details>`;
  }

  async function handle(request) {
    const url = new URL(request.url), path = url.pathname;
    if (path === '/api/relay') {
      const match = /^Bearer ([a-f0-9]{64})$/i.exec(request.headers.get('authorization') ?? '');
      const actor = match && await repository.getDevice(await hashToken(match[1]));
      if (!actor) return Response.json({ error: 'Sign in to Jolo.' }, { status: 401 });
      if (!actor.scope.split(' ').includes('prompts:run')) return Response.json({ error: 'Approve web prompts for this device.' }, { status: 403 });
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket' || !env.ACCESS_RELAY) return Response.json({ error: 'Expected a WebSocket.' }, { status: 426 });
      return relayFor(env, actor.id).connect({ id: actor.device_id, name: actor.device_name, accountId: actor.id });
    }
    const chatPrompt = /^\/chats\/([a-f0-9-]{36})\/prompt$/.exec(path);
    const promptPage = /^\/prompts\/([a-f0-9-]{36})(\/cancel|\/permission|\/live)?$/.exec(path);
    if (!chatPrompt && !promptPage && path !== '/prompts') return null;
    const account = await session(request);
    if (!account) return redirect('/');
    if (request.method === 'GET' && promptPage?.[2] === '/live') {
      const prompt = await db.prepare('SELECT status,permission FROM remote_prompts WHERE id=?1 AND account_id=?2').bind(promptPage[1], account.id).first();
      if (!prompt) return Response.json({ error: 'Prompt not found.' }, { status: 404 });
      // The permission id lets the page notice one request replacing another between polls.
      return Response.json({ status: prompt.status, permission: waitingOn(prompt)?.id ?? null, text: active(prompt.status) ? await relayFor(env, account.id)?.live(promptPage[1]) ?? null : null });
    }
    if (request.method === 'GET' && promptPage && !promptPage[2]) {
      await expire(account);
      const prompt = await db.prepare('SELECT * FROM remote_prompts WHERE id=?1 AND account_id=?2').bind(promptPage[1], account.id).first();
      if (!prompt) return html(appPage('Prompt', '<h1>Prompt not found</h1>', { active: 'chats' }), 404);
      const target = prompt.result_chat_id ?? prompt.chat_id;
      if (!active(prompt.status) && target && await db.prepare('SELECT 1 FROM synced_chats WHERE account_id=?1 AND id=?2').bind(account.id, target).first()) return redirect(`/chats/${target}`);
      const approvals = active(prompt.status) && (await devices(account)).some(d => d.id === prompt.device_id && d.approvals);
      return html(appPage('Prompt', `<h1>Prompt</h1><ul class="prompt-list">${promptItem(prompt, account.csrf, { approvals })}</ul>${active(prompt.status) ? `<p class="fine">This page updates until the chat syncs.</p>${LIVE_SCRIPT}` : '<a class="button secondary" href="/chats">Back to chats</a>'}`, { active: 'chats', kind: 'synced-chats-page', refresh: active(prompt.status) ? 3 : 0 }));
    }
    if (request.method !== 'POST') return Response.json({ error: 'Method not allowed.' }, { status: 405 });
    if (request.headers.get('origin') !== config.origin) return Response.json({ error: 'Bad origin.' }, { status: 403 });
    const form = await readForm(request, FORM_BYTES);
    if (formValue(form, 'csrf') !== account.csrf) return Response.json({ error: 'Your form session changed. Reload the page.' }, { status: 403 });
    if (promptPage) {
      const prompt = await db.prepare('SELECT * FROM remote_prompts WHERE id=?1 AND account_id=?2').bind(promptPage[1], account.id).first();
      if (!prompt) return Response.json({ error: 'Prompt not found.' }, { status: 404 });
      const back = prompt.chat_id ? `/chats/${prompt.chat_id}#continue` : `/prompts/${prompt.id}`;
      if (promptPage[2] === '/permission') {
        // Only the request the run is waiting on, only once or deny, and only for a device that
        // accepts answers from the web. The device checks all of this again before acting.
        const decision = formValue(form, 'decision'), waiting = waitingOn(prompt);
        const device = (await devices(account)).find(d => d.id === prompt.device_id);
        if (!waiting?.complete || waiting.id !== formValue(form, 'permission') || !['allow_once', 'deny'].includes(decision) || !device?.approvals) return redirect(back);
        await relayFor(env, account.id).send(prompt.device_id, { type: 'permission', id: prompt.id, permissionId: waiting.id, decision });
        return redirect(back);
      }
      if (promptPage[2] !== '/cancel') return Response.json({ error: 'Method not allowed.' }, { status: 405 });
      if (active(prompt.status)) {
        const sent = await relayFor(env, account.id)?.send(prompt.device_id, { type: 'cancel', id: prompt.id });
        // With the device online, it reports `cancelled` once the run stops. Without it, the prompt
        // ends here, and the relay stops the run when the device reconnects and reports it.
        const started = !['pending', 'delivered'].includes(prompt.status);
        if (!sent || !started) await db.prepare(`UPDATE remote_prompts SET status='cancelled', error=?3, updated_at=?2 WHERE id=?1 AND status IN ('pending','delivered','accepted','running','awaiting_permission')`)
          .bind(prompt.id, now(), !sent && started ? `Cancelled. ${prompt.device_name} is offline; the run stops when it reconnects.` : null).run();
      }
      return redirect(back);
    }
    const online = await devices(account);
    if (chatPrompt) {
      const chat = await db.prepare('SELECT id,folder_id FROM synced_chats WHERE account_id=?1 AND id=?2').bind(account.id, chatPrompt[1]).first();
      if (!chat) return Response.json({ error: 'Chat not found.' }, { status: 404 });
      const device = online.find(d => d.id === formValue(form, 'target') && (!chat.folder_id || d.folders.includes(chat.folder_id)));
      const result = device ? await send(account, { deviceId: device.id, deviceName: device.name, chatId: chat.id, text: formValue(form, 'text') }) : 'offline';
      return redirect(`/chats/${chat.id}${typeof result === 'string' ? `?prompt_error=${result}` : ''}#continue`);
    }
    const [deviceId, folderId] = (formValue(form, 'target') ?? '').split(':');
    const folder = UUID.test(folderId ?? '') && await db.prepare('SELECT project_id FROM synced_chats WHERE account_id=?1 AND folder_id=?2 LIMIT 1').bind(account.id, folderId).first();
    const device = folder && online.find(d => d.id === deviceId && d.folders.includes(folderId));
    const result = device ? await send(account, { deviceId: device.id, deviceName: device.name, folderId, text: formValue(form, 'text') }) : 'folder';
    return redirect(typeof result === 'string' ? `/chats?project=${folder ? folder.project_id : 'none'}&prompt_error=${result}` : `/prompts/${result.id}`);
  }
  return { handle, chatPanel, projectPanel };
}
