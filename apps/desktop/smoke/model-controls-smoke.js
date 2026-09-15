import assert from 'node:assert/strict';
import { nativeTheme } from 'electron';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

export async function runModelControlsSmoke({window, bridge, evaluate, waitFor, report, results}) {
  const open = "document.querySelector('.model-popover')?.matches(':popover-open')";
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const type = (selector, value) => evaluate(`(() => { const input=document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)}); input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  const key = code => { window.webContents.sendInputEvent({type:'keyDown',keyCode:code}); if (code === 'Enter') window.webContents.sendInputEvent({type:'char',keyCode:'\r'}); window.webContents.sendInputEvent({type:'keyUp',keyCode:code}); };
  const saved = async () => (await bridge.rawCall('settings.get',{})).settings.agents.codex;
  await evaluate("window.__joloSmoke.pickAnswerer('codex')");
  await waitFor("document.querySelector('.model-select')?.textContent.includes('Codex')",'Codex selected');
  await type('.composer textarea','Keep this draft.');
  await click('.model-select'); await waitFor(open,'popover opens');
  await waitFor("document.querySelector('[data-model=\"fake-large\"]')",'reported models');
  await waitFor("document.querySelector('.model-select')?.getAttribute('aria-expanded') === 'true'", 'popover toggle handled');
  await click('.model-select'); await waitFor('!'+open,'second click closes popover');
  await click('.model-select'); await waitFor(open,'popover reopens');
  await type('.model-search input','large');
  await waitFor("document.querySelector('[data-model=\"fake-large\"]') && !document.querySelector('[data-model=\"fake-small\"]')", 'search filters models');
  key('Enter');
  assert.equal(await evaluate('window.__joloSmoke.state().runCount'),0,'search does not submit the draft');
  await type('.model-search input','');
  await click('[data-source="agent:claude"]');
  assert.equal(await evaluate("window.__joloSmoke.state().answerer"),'Codex','browsing leaves the active agent unchanged');
  await click('[data-source="agent:codex"]');
  await waitFor("document.querySelector('[data-model=\"fake-large\"]')",'return to Codex models');
  const originalMenuTheme = nativeTheme.themeSource;
  try {
    for (const theme of /** @type {const} */ (['light','dark'])) {
      nativeTheme.themeSource = theme;
      await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      assert(await evaluate("[...document.querySelectorAll('.model-providers, .model-submenu')].every(p => { const r=p.getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && p.scrollWidth <= p.clientWidth; })"), 'both menu panels fit the viewport');
      writeFileSync(path.join(results,`model-menu-${theme}.png`),(await window.webContents.capturePage()).toPNG());
    }
  } finally {nativeTheme.themeSource=originalMenuTheme;}

  await type('.model-search input', 'large');
  await evaluate("document.querySelector('.model-search input').focus()"); key('Down');
  await waitFor("document.activeElement?.getAttribute('data-model') === 'fake-large'", 'arrow key enters model results');
  key('Enter');
  await waitFor('!'+open,'model selection closes the menu');
  await click('.model-effort-select');
  await waitFor("document.querySelector('.effort-slider input:not(:disabled)')?.max === '2' && document.querySelector('.model-select')?.textContent.includes('Fake Large')",'model persisted from list');
  await evaluate("document.querySelector('.effort-slider input').focus()");
  key('End');
  await waitFor("window.__joloSmoke.hostedAgents().find(a=>a.id==='codex').effort === 'high'",'keyboard changes effort');
  assert.equal((await saved()).model,'fake-large'); assert.equal((await saved()).effort,'high');
  const originalTheme = nativeTheme.themeSource;
  try {
    for (const theme of /** @type {const} */ (['light','dark'])) {
      nativeTheme.themeSource = theme;
      await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      const box=await evaluate("(() => {const p=document.querySelector('.model-popover'),r=p.getBoundingClientRect();return {x:r.left,y:r.top,width:r.width,height:r.height,overflow:p.scrollWidth>p.clientWidth};})()");
      assert(!box.overflow && box.x>=0 && box.y>=0);
      writeFileSync(path.join(results,`model-effort-${theme}.png`),(await window.webContents.capturePage({x:Math.floor(box.x)-12,y:Math.floor(box.y)-12,width:Math.ceil(box.width)+24,height:Math.ceil(box.height)+24})).toPNG());
    }
  } finally {nativeTheme.themeSource=originalTheme;}
  // Drag the actual native range. Pointer interaction must persist, not only preview.
  const r=await evaluate("(() => {const r=document.querySelector('.effort-slider input').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})()");
  const y=Math.round(r.y+r.height/2), right=Math.round(r.x+r.width-r.height/2), middle=Math.round(r.x+r.width/2);
  window.webContents.sendInputEvent({type:'mouseDown',x:right,y,button:'left',clickCount:1});
  window.webContents.sendInputEvent({type:'mouseMove',x:middle,y,modifiers:['leftButtonDown']});
  window.webContents.sendInputEvent({type:'mouseUp',x:middle,y,button:'left',clickCount:1});
  await waitFor("window.__joloSmoke.hostedAgents().find(a=>a.id==='codex').effort === 'low'",'drag persists low effort');
  assert.equal((await saved()).effort,'low');
  await click('.effort-reset');
  await waitFor("!window.__joloSmoke.hostedAgents().find(a=>a.id==='codex').effort",'reset restores default effort');
  await evaluate("document.querySelector('.effort-slider input').focus()"); key('End');
  await waitFor("window.__joloSmoke.hostedAgents().find(a=>a.id==='codex').effort === 'high'",'high before model switch');
  await click('.effort-model'); await click('[data-model="fake-small"]');
  await waitFor('!'+open,'small model selected'); await click('.model-effort-select');
  await waitFor("document.querySelector('.effort-slider input')?.max === '1'",'small model hides unsupported high effort');
  assert.equal((await saved()).effort,null);
  await evaluate("document.querySelector('.effort-slider input').focus()"); key('End');
  await waitFor("window.__joloSmoke.hostedAgents().find(a=>a.id==='codex').effort === 'low'",'small model low effort');
  key('Escape'); await waitFor('!'+open,'Escape dismisses');
  assert.equal(await evaluate("document.querySelector('.composer textarea').value"),'Keep this draft.');
  assert.equal(await evaluate('window.__joloSmoke.state().runCount'),0);
  await type('.composer textarea','model');
  await click('.composer-submit');
  await waitFor("window.__joloSmoke.state().runState === 'completed'",'selected model answers');
  assert.match(await evaluate('window.__joloSmoke.state().assistantText'),/fake-small/);
  assert.match(await evaluate('window.__joloSmoke.state().assistantText'),/low/);
  const currentSession=await evaluate('window.__joloSmoke.state().sessionId');
  const originalDefault=(await bridge.rawCall('settings.get',{})).settings.model;
  await click('.model-select'); await waitFor(open,'provider switch popover');
  await waitFor("document.querySelector('[data-source=\"provider:smoke-model\"]')",'connected providers');
  await click('[data-source="provider:smoke-model"]');
  await waitFor("document.querySelector('[data-model=\"test-model\"]')",'native provider models');
  writeFileSync(path.join(results,'composer-model-list.png'),(await window.webContents.capturePage()).toPNG());
  await click('[data-model="test-model"]');
  await waitFor("window.__joloSmoke.state().answerer === 'Jolo · Test Model' && !document.querySelector('.model-popover').matches(':popover-open')",'native model chosen');
  const session=(await bridge.rawCall('session.page',{sessionId:currentSession})).session;
  assert.equal(session.model.preset,'smoke-model'); assert.equal(session.model.model,'test-model');
  assert.deepEqual((await bridge.rawCall('settings.get',{})).settings.model,originalDefault,'native picker must not replace other tasks’ default');
  await click('.model-select'); await waitFor(open,'native menu reopens');
  await click('.model-select'); await waitFor('!'+open,'native menu closes on second click');
  await type('.composer textarea','Reply with the selected provider.'); await click('.composer-submit');
  await waitFor("window.__joloSmoke.state().runState === 'completed' && window.__joloSmoke.state().runCount === 2",'native provider answers in same task');
  assert.equal(await evaluate('window.__joloSmoke.state().sessionId'),currentSession);
  assert.match(await evaluate('window.__joloSmoke.state().assistantText'),/Fixture answer/);
  await evaluate('window.__joloSmoke.newTask()');
  await waitFor(`window.__joloSmoke.state().sessionId !== ${JSON.stringify(currentSession)} && window.__joloSmoke.state().answerer === 'Jolo · Test Model'`, 'new task remembers native model');
  const nativeTask = await evaluate('window.__joloSmoke.state().sessionId');
  assert.deepEqual((await bridge.rawCall('session.page', { sessionId: nativeTask })).session.model, session.model);
  await evaluate('window.__joloSmoke.newChat()');
  await waitFor("window.__joloSmoke.state().standalone && window.__joloSmoke.state().answerer === 'Jolo · Test Model'", 'new chat remembers native model');
  await evaluate("window.__joloSmoke.pickAnswerer('codex')");
  await evaluate('window.__joloSmoke.newChat()');
  await waitFor("window.__joloSmoke.state().sessionAgentId === 'codex' && document.querySelector('.model-select')?.textContent.includes('Fake Small')", 'new chat remembers hosted model');
  assert.match(await evaluate("document.querySelector('.model-effort-select').textContent"), /Low/);
  await new Promise((resolve, reject) => {
    const loaded = () => { clearTimeout(timer); resolve(null); };
    const timer = setTimeout(() => { window.webContents.removeListener('did-finish-load', loaded); reject(new Error('model choice reload timed out')); }, 10000);
    window.webContents.once('did-finish-load', loaded);
    window.webContents.reload();
  });
  await waitFor("Boolean(window.__joloSmoke?.newChat)", 'app reloaded');
  await evaluate('window.__joloSmoke.newChat()');
  await waitFor("window.__joloSmoke.state().sessionAgentId === 'codex' && document.querySelector('.model-select')?.textContent.includes('Fake Small')", 'choice survives app reload');
  assert.deepEqual((await bridge.rawCall('settings.get', {})).settings.model, originalDefault);
  report.checks.push('Cascading provider menu, model search, supported effort stops, keyboard model selection and pointer effort selection, reset, double-click dismissal, draft preservation, light/dark layout agent/provider switching, and actual hosted/native execution passed.');
  report.checks.push('New tasks and standalone chats retain the last model, agent and effort, including after reload, without changing the provider default.');
}
