import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { once } from 'node:events';

async function layout(window, origin, page, { scrolls }) {
  const contents = window.webContents;
  await window.loadURL(origin + page);
  for (const [width, height, theme] of [[1280, 800, 'light'], [1280, 800, 'dark'], [390, 844, 'light'], [390, 844, 'dark'], [1280, 560, 'light'], [320, 740, 'light'], [375, 667, 'dark'], [768, 1024, 'light']]) {
    window.setContentSize(width, height);
    await contents.executeJavaScript(`document.querySelector('#color-theme').value='${theme}';document.querySelector('#color-theme').dispatchEvent(new Event('change',{bubbles:true}));new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    const metrics = await contents.executeJavaScript(`(() => {
      const content=document.querySelector('.task-content'), list=document.querySelector('.chats-collection');
      const controls=['#chat-search','.chats-search button','.chats-sync-help summary'].map(selector=>{const r=document.querySelector(selector).getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth;});
      const rows=[...document.querySelectorAll('.chat-row')].every(row=>row.getBoundingClientRect().right<=innerWidth+1);
      return { fits:document.documentElement.scrollWidth<=innerWidth&&document.documentElement.scrollHeight<=innerHeight&&content.scrollWidth<=content.clientWidth+1&&content.scrollHeight<=content.clientHeight+1,scrolls:list.scrollHeight>list.clientHeight,controls,rows };
    })()`);
    assert(metrics.fits && metrics.rows && (!scrolls || metrics.scrolls) && metrics.controls.every(Boolean), `Chat layout ${page} at ${width}×${height}: ${JSON.stringify(metrics)}`);
    writeFileSync(`/tmp/jolo-access-chats${page.replace(/[^a-z0-9]+/gi, '-')}-${width}-${height}-${theme}.png`, (await contents.capturePage()).toPNG());
  }
}

export async function checkChats(window, origin) {
  const contents = window.webContents;
  await layout(window, origin, '/chats', { scrolls: false });
  assert.equal(await contents.executeJavaScript(`document.querySelectorAll('.project-row').length`), 5);
  await layout(window, origin, '/chats?project=none', { scrolls: true });
  await layout(window, origin, '/chats?project=00000000-0000-4000-9000-000000000000', { scrolls: false });
  assert.deepEqual(await contents.executeJavaScript(`[...document.querySelectorAll('.chat-folder-group h2')].map(h=>h.textContent)`), ['desktop', 'desktop-releaserelease/2026-10-a-long-branch-name']);
  assert.equal(await contents.executeJavaScript(`document.querySelectorAll('.prompt-composer select option').length`), 2, 'Both folders on the online device can start a chat');
  const projectChat = await contents.executeJavaScript(`document.querySelector('.chat-folder-group .chat-row').getAttribute('href')`);
  await window.loadURL(origin + projectChat);
  assert.match(await contents.executeJavaScript(`document.querySelector('.chat-continue').textContent`), /Runs on Studio Mac/);
  await contents.executeJavaScript(`new Promise(resolve=>{const check=()=>document.documentElement.hasAttribute('data-assets-loading')?setTimeout(check,20):requestAnimationFrame(()=>requestAnimationFrame(resolve));check();})`);
  writeFileSync('/tmp/jolo-access-chat-continue.png', (await contents.capturePage()).toPNG());
  // A prompt waiting on approval shows the request, the reply so far, and once-or-deny answers.
  await window.loadURL(origin + '/chats/00000000-0000-4000-8000-000000000008');
  for (const [width, height] of [[1280, 800], [390, 844], [320, 740]]) {
    window.setContentSize(width, height);
    const waiting = await contents.executeJavaScript(`new Promise(resolve=>{const check=()=>{const live=document.querySelector('.prompt-live');if(document.documentElement.hasAttribute('data-assets-loading')||!live||live.hidden){setTimeout(check,50);return;}requestAnimationFrame(()=>resolve({buttons:[...document.querySelectorAll('.prompt-permission button')].map(b=>b.textContent),fits:document.documentElement.scrollWidth<=innerWidth,live:live.textContent,composer:Boolean(document.querySelector('.prompt-composer'))}));};check();})`);
    assert.deepEqual(waiting.buttons, ['Allow once', 'Deny']);
    assert(waiting.fits && !waiting.composer && waiting.live.includes('notarization'), `Waiting prompt at ${width}×${height}: ${JSON.stringify(waiting)}`);
    await contents.executeJavaScript(`document.querySelector('.prompt-permission').scrollIntoView({block:'end'});new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
    writeFileSync(`/tmp/jolo-access-chat-permission-${width}.png`, (await contents.capturePage()).toPNG());
  }
  window.setContentSize(1280, 800);
  // Revoking the web-prompt device removes it before the device form checks run.
  await window.loadURL(origin + '/devices');
  const revoked = once(contents, 'did-finish-load');
  await contents.executeJavaScript(`document.querySelector('form[action="/devices/revoke"] input[value="browser-device"]').form.requestSubmit()`);
  await revoked;
  await window.loadURL(origin + '/chats');
  // Native GET search must work without a client-side list or inline script.
  const searched = once(contents, 'did-finish-load');
  await contents.executeJavaScript(`document.querySelector('#chat-search').value='packaging';document.querySelector('.chats-search').requestSubmit()`);
  await searched;
  assert.equal(await contents.executeJavaScript(`document.querySelectorAll('.chat-row').length`), 1);
  await window.loadURL(origin + '/chats?q=unmatched');
  assert.match(await contents.executeJavaScript('document.body.textContent'), /No matching chats/);
  writeFileSync('/tmp/jolo-access-chats-empty.png', (await contents.capturePage()).toPNG());
  await window.loadURL(origin + '/chats?project=none');
  const link = await contents.executeJavaScript(`document.querySelector('.chat-row').getAttribute('href')`);
  await window.loadURL(origin + link);
  assert.equal(await contents.executeJavaScript(`document.querySelectorAll('.synced-message').length`), 2);
  window.setContentSize(1280, 720);
}
