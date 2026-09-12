import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { once } from 'node:events';

export async function checkChats(window, origin) {
  const contents = window.webContents;
  await window.loadURL(origin + '/chats');
  for (const [width, height, theme] of [[1280, 800, 'light'], [1280, 800, 'dark'], [390, 844, 'light'], [390, 844, 'dark'], [1280, 560, 'light'], [320, 740, 'light'], [375, 667, 'dark'], [768, 1024, 'light']]) {
    window.setContentSize(width, height);
    await contents.executeJavaScript(`document.querySelector('#color-theme').value='${theme}';document.querySelector('#color-theme').dispatchEvent(new Event('change',{bubbles:true}));new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    const metrics = await contents.executeJavaScript(`(() => {
      const content=document.querySelector('.task-content'), list=document.querySelector('.chats-collection');
      const controls=['#chat-search','.chats-search button','.chats-sync-help summary'].map(selector=>{const r=document.querySelector(selector).getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth;});
      return { fits:document.documentElement.scrollWidth<=innerWidth&&document.documentElement.scrollHeight<=innerHeight&&content.scrollWidth<=content.clientWidth+1&&content.scrollHeight<=content.clientHeight+1,scrolls:list.scrollHeight>list.clientHeight,controls };
    })()`);
    assert(metrics.fits && metrics.scrolls && metrics.controls.every(Boolean), `Chat layout at ${width}×${height}: ${JSON.stringify(metrics)}`);
    writeFileSync(`/tmp/jolo-access-chats-${width}-${height}-${theme}.png`, (await contents.capturePage()).toPNG());
  }
  // Native GET search must work without a client-side list or inline script.
  const searched = once(contents, 'did-finish-load');
  await contents.executeJavaScript(`document.querySelector('#chat-search').value='packaging';document.querySelector('.chats-search').requestSubmit()`);
  await searched;
  assert.equal(await contents.executeJavaScript(`document.querySelectorAll('.chat-row').length`), 1);
  await window.loadURL(origin + '/chats?q=unmatched');
  assert.match(await contents.executeJavaScript('document.body.textContent'), /No matching chats/);
  writeFileSync('/tmp/jolo-access-chats-empty.png', (await contents.capturePage()).toPNG());
  await window.loadURL(origin + '/chats');
  const link = await contents.executeJavaScript(`document.querySelector('.chat-row').getAttribute('href')`);
  await window.loadURL(origin + link);
  assert.equal(await contents.executeJavaScript(`document.querySelectorAll('.synced-message').length`), 2);
  window.setContentSize(1280, 720);
}
